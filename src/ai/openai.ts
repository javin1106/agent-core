import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import {
  LLMError,
  type LLMProvider,
  type Message,
  type StopReason,
  type StreamEvent,
  type ToolCall,
  type ToolDefinition,
  type Usage,
} from "./types.js";

export class OpenAIProvider implements LLMProvider {
  readonly model: string;
  private client: OpenAI;

  constructor(model: string) {
    this.model = model;
    // The SDK would quietly retry failed requests twice by itself. We turn that
    // off: the agent loop does the retrying, so it can show the user what's happening.
    this.client = new OpenAI({ maxRetries: 0 });
  }

  // `async *` makes this an async generator: a function that can `yield`
  // values one at a time. The caller receives them with `for await`.
  async *stream(messages: Message[], tools: ToolDefinition[] = []): AsyncIterable<StreamEvent> {
    // 1. Start a streaming request. We send the whole history every time.
    let stream;
    try {
      stream = await this.client.chat.completions.create({
        model: this.model,
        messages: messages.map(toOpenAIMessage),
        // OpenAI rejects an empty tools list, so leave the field out when there are none.
        tools: tools.length > 0 ? tools.map(toOpenAITool) : undefined,
        stream: true,
        stream_options: { include_usage: true }, // ask for token counts at the end
      });
    } catch (err) {
      throw toLLMError(err, false);
    }

    // 2. Read the reply piece by piece as it arrives.
    let fullText = "";
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };

    const toolCalls: ToolCall[] = [];
    // Why the model stopped. Arrives on the last chunk that has a choice.
    let finishReason: string | null | undefined;
    let refused = false;

    try {
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const delta = choice?.delta;
        if (choice?.finish_reason) finishReason = choice.finish_reason;

        const text = delta?.content;
        if (text) {
          fullText += text;
          yield { type: "text", text };
        }

        // Some models refuse with a separate `refusal` text instead of normal
        // content. Show it like normal text, so the user sees the reason.
        if (delta?.refusal) {
          refused = true;
          fullText += delta.refusal;
          yield { type: "text", text: delta.refusal };
        }

        for (const piece of delta?.tool_calls ?? []) {
          // The first piece of a call carries its id and name; later pieces
          // only carry more characters of the arguments JSON.
          const call = (toolCalls[piece.index] ??= { id: "", name: "", arguments: "" });
          if (piece.id) call.id = piece.id;
          if (piece.function?.name) call.name = piece.function.name;
          if (piece.function?.arguments) call.arguments += piece.function.arguments;
        }

        // Only the last chunk has usage (and its `choices` array is empty).
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          };
        }
      }
    } catch (err) {
      // The request was accepted but the stream broke partway (e.g. the connection dropped).
      // Pass on the text received so far, so the retry can continue it instead of
      // starting over. Not if tool-call pieces had started: half a JSON object
      // can't be safely continued, so that case restarts from scratch.
      const partialText = toolCalls.length === 0 ? fullText : "";
      throw toLLMError(err, true, partialText);
    }

    // 3. The stream is finished: hand back the complete reply.
    yield {
      type: "done",
      message: {
        role: "assistant",
        content: fullText,
        // Only include the field when the model actually asked for tools.
        ...(toolCalls.length > 0 && { toolCalls }),
      },
      usage,
      stopReason: refused ? "refused" : toStopReason(finishReason, toolCalls.length > 0),
    };
  }
}

// OpenAI's finish_reason, in our provider-neutral words.
function toStopReason(finishReason: string | null | undefined, hasToolCalls: boolean): StopReason {
  switch (finishReason) {
    case "length":
      return "length";
    case "content_filter":
      return "refused";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    default:
      // "stop", or a provider that leaves it out: judge from the reply itself.
      return hasToolCalls ? "tool_calls" : "end";
  }
}

// --- Turning SDK errors into our LLMError ---

// Decides which failures are worth retrying. `midStream` is true when the
// request had already started streaming and then broke; `partialText` is the
// reply text received before that.
function toLLMError(err: unknown, midStream: boolean, partialText = ""): LLMError {
  // The user cancelled (we'll use this for Ctrl+C later): never retry.
  if (err instanceof OpenAI.APIUserAbortError) {
    return new LLMError("Request cancelled", false);
  }
  // Couldn't reach the server at all (no internet, DNS, timeout): try again.
  if (err instanceof OpenAI.APIConnectionError) {
    return new LLMError(`Could not connect: ${err.message}`, true, undefined, partialText);
  }
  // The server answered with an error status.
  if (err instanceof OpenAI.APIError && err.status !== undefined) {
    const status = err.status;
    // 408 timeout, 409 conflict, 429 rate limit, 5xx server trouble: temporary.
    // Anything else (400 bad request, 401 wrong key, 404 unknown model) won't
    // fix itself, so retrying would only waste time.
    const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
    // err.message already starts with the status, e.g. "404 model 'x' not found".
    return new LLMError(err.message, retryable, retryAfterMs(err.headers), partialText);
  }
  const message = err instanceof Error ? err.message : String(err);
  // A stream that breaks partway is almost always a network problem.
  return midStream
    ? new LLMError(`Connection lost during the reply: ${message}`, true, undefined, partialText)
    : new LLMError(message, false);
}

// Servers can say how long to wait with a "Retry-After: <seconds>" header.
function retryAfterMs(headers: Headers | undefined): number | undefined {
  const seconds = Number(headers?.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

// --- Translating our types into OpenAI's format ---

function toOpenAIMessage(message: Message): ChatCompletionMessageParam {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };
    case "assistant":
      if (!message.toolCalls?.length) {
        return { role: "assistant", content: message.content };
      }
      return {
        role: "assistant",
        content: message.content || null, // OpenAI wants null, not "", when there's no text
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
}

function toOpenAITool(tool: ToolDefinition): ChatCompletionTool {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}
