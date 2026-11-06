// Provider-neutral types. Only src/ai/openai.ts knows about the OpenAI SDK;
// everything else in the agent speaks these types.

// The model asking us to run a tool.
export interface ToolCall {
  id: string; // we send this id back with the result, so the model can match them up
  name: string;
  arguments: string; // JSON text written by the model, e.g. '{"path":"package.json"}'
}

// One message in the conversation. `role` decides which other fields exist.
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string }; // the result of one tool call

export type AssistantMessage = Extract<Message, { role: "assistant" }>;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema for the tool's input
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

// What a provider emits while streaming one reply.
// Why the model stopped writing a reply:
// end = finished normally; tool_calls = stopped to ask for tools;
// length = hit the output limit and was cut off; refused = the provider
// blocked or the model refused the reply.
export type StopReason = "end" | "tool_calls" | "length" | "refused";

export type StreamEvent =
  | { type: "text"; text: string } // a piece of the reply, printed as it arrives
  | { type: "done"; message: AssistantMessage; usage: Usage; stopReason: StopReason }; // the complete reply

// A failed model call, in a provider-neutral form. Each provider turns its SDK's
// errors into this, so the agent loop can decide whether to retry without
// knowing anything about OpenAI (or any other provider).
export class LLMError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean, // worth trying again? (rate limit, server error, network)
    readonly retryAfterMs?: number, // how long the server asked us to wait, if it said
    // Text the model had already sent before the stream broke. Only set when the
    // partial reply was plain text (no tool-call pieces), so it's safe to resume from.
    readonly partialText = "",
  ) {
    super(message);
    this.name = "LLMError";
  }
}

export interface LLMProvider {
  readonly model: string;
  stream(messages: Message[], tools?: ToolDefinition[], signal?: AbortSignal): AsyncIterable<StreamEvent>;
}
