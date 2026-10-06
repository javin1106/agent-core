// Provider-neutral types. Only src/ai/openai.ts knows about the OpenAI SDK;
// everything else in the agent speaks these types.

export type Role = "system" | "user" | "assistant";

// One message in the conversation. M2 adds tool calls and tool results.
export interface Message {
  role: Role;
  content: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

// What a provider emits while streaming one reply.
export type StreamEvent =
  | { type: "text"; text: string } // a piece of the reply, printed as it arrives
  | { type: "done"; message: Message; usage: Usage }; // the complete reply

export interface LLMProvider {
  readonly model: string;
  stream(messages: Message[]): AsyncIterable<StreamEvent>;
}
