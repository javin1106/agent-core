import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type {
  LLMProvider,
  Message,
  StreamEvent,
  ToolCall,
  ToolDefinition,
  Usage,
} from "./types.js";

export class OpenAIProvider implements LLMProvider {
  readonly model: string;
  private client: OpenAI;

  constructor(model: string) {
    this.model = model;
    this.client = new OpenAI();
  }

  // `async *` makes this an async generator: a function that can `yield`
  // values one at a time. The caller receives them with `for await`.
  async *stream(messages: Message[], tools: ToolDefinition[] = []): AsyncIterable<StreamEvent> {
    // 1. Start a streaming request. We send the whole history every time.
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map(toOpenAIMessage),
      // OpenAI rejects an empty tools list, so leave the field out when there are none.
      tools: tools.length > 0 ? tools.map(toOpenAITool) : undefined,
      stream: true,
      stream_options: { include_usage: true }, // ask for token counts at the end
    });

    // 2. Read the reply piece by piece as it arrives.
    let fullText = "";
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    
    const toolCalls: ToolCall[] = [];

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      const text = delta?.content;
      if (text) {
        fullText += text;
        yield { type: "text", text };
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
    };
  }
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
