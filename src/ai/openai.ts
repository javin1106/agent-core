import OpenAI from "openai";
import type { LLMProvider, Message, StreamEvent, Usage } from "./types.js";

export class OpenAIProvider implements LLMProvider {
  readonly model: string;
  private client: OpenAI;

  constructor(model: string) {
    this.model = model;
    this.client = new OpenAI();
  }

  // `async *` makes this an async generator: a function that can `yield`
  // values one at a time. The caller receives them with `for await`.
  async *stream(messages: Message[]): AsyncIterable<StreamEvent> {
    // 1. Start a streaming request. We send the whole history every time.
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages,
      stream: true,
      stream_options: { include_usage: true }, // ask for token counts at the end
    });

    // 2. Read the reply piece by piece as it arrives.
    let fullText = "";
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) {
        fullText += text;
        yield { type: "text", text };
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
      message: { role: "assistant", content: fullText },
      usage,
    };
  }
}
