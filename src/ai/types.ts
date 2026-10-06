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
export type StreamEvent =
  | { type: "text"; text: string } // a piece of the reply, printed as it arrives
  | { type: "done"; message: AssistantMessage; usage: Usage }; // the complete reply

export interface LLMProvider {
  readonly model: string;
  stream(messages: Message[], tools?: ToolDefinition[]): AsyncIterable<StreamEvent>;
}
