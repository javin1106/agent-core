import type { AssistantMessage, LLMProvider, Message, StreamEvent } from "../../src/ai/types.js";

// A fake model for tests. Instead of calling an API, it returns replies we
// wrote in advance, one per call, and records the messages it was sent.
// Tests stay fast, free, offline, and give the same result every run.
export class ScriptedProvider implements LLMProvider {
  readonly model = "scripted";
  readonly received: Message[][] = []; // what each call was sent

  constructor(private replies: AssistantMessage[]) {}

  async *stream(messages: Message[]): AsyncIterable<StreamEvent> {
    this.received.push(structuredClone(messages)); // a copy: history keeps changing after this
    const message = this.replies.shift();
    if (!message) throw new Error("ScriptedProvider: no scripted reply left");
    if (message.content) yield { type: "text", text: message.content };
    yield { type: "done", message, usage: { inputTokens: 0, outputTokens: 0 } };
  }
}
