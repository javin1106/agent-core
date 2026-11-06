import {
  LLMError,
  type AssistantMessage,
  type LLMProvider,
  type Message,
  type StopReason,
  type ToolDefinition,
} from "../ai/types.js";
import { backoffMs, MAX_RETRIES, sleep } from "../utils/retry.js";
import type { AgentEvent } from "./events.js";

const MAX_CONTINUES = 3;

const RESUME_NOTE =
  "[Automatic message, not from the user] Your previous reply was cut off before it " +
  "finished (a connection problem or the length limit). Continue it from exactly " +
  "where it stopped, mid-word if needed. Your text will be joined directly onto the " +
  "end of it, so if the cut fell between two words, start with a space. Don't repeat " +
  "any of it and don't mention the interruption.";

export interface ModelReply {
  reply: AssistantMessage;
  stopReason: StopReason;
}

// Gets one complete reply: retries temporary failures, continues replies cut off
// by the length limit, and joins the pieces. Throws when it can't recover.
export async function* callModel(
  provider: LLMProvider,
  history: Message[],
  definitions: ToolDefinition[],
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent, ModelReply> {
  let resumeText = ""; // reply text received so far, before a drop or a cut
  let attempt = 1;
  let continues = 0;

  while (true) {
    try {
      const { reply, stopReason } = yield* streamReply(
        provider,
        withResume(history, resumeText),
        definitions,
        signal,
      );

      if (canContinue(reply, stopReason) && continues < MAX_CONTINUES) {
        continues++;
        resumeText += reply.content;
        yield { type: "continue", count: continues, max: MAX_CONTINUES };
        continue;
      }

      return { reply: { ...reply, content: resumeText + reply.content }, stopReason };
    } catch (err) {
      // After Ctrl+C, never retry: the error is the cancellation itself.
      if (signal?.aborted || !isRetryable(err) || attempt > MAX_RETRIES) {
        throw err;
      }
      resumeText += err.partialText;
      const delayMs = backoffMs(attempt, err.retryAfterMs);
      yield {
        type: "retry",
        attempt,
        maxRetries: MAX_RETRIES,
        delayMs,
        error: err.message,
        resuming: resumeText !== "",
      };
      await sleep(delayMs, signal);
      attempt++;
    }
  }
}

// One request: passes text and usage on as they arrive, returns the finished reply.
async function* streamReply(
  provider: LLMProvider,
  messages: Message[],
  definitions: ToolDefinition[],
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent, ModelReply> {
  for await (const event of provider.stream(messages, definitions, signal)) {
    if (event.type === "text") {
      yield event;
    } else {
      yield { type: "usage", usage: event.usage };
      // Some SDKs end an aborted stream quietly instead of throwing, which would
      // make a cut-off reply look finished.
      signal?.throwIfAborted();
      return { reply: event.message, stopReason: event.stopReason };
    }
  }
  signal?.throwIfAborted();
  throw new Error("The model's stream ended without a reply");
}

// Only plain text that made progress can be continued. With no text (e.g. the
// limit went on hidden reasoning), asking again would get cut the same way.
function canContinue(reply: AssistantMessage, stopReason: StopReason): boolean {
  return stopReason === "length" && !reply.toolCalls?.length && reply.content !== "";
}

function isRetryable(err: unknown): err is LLMError {
  return err instanceof LLMError && err.retryable;
}

// The extra messages are only for this one request; they never go into history.
function withResume(history: Message[], resumeText: string): Message[] {
  if (resumeText === "") return history;
  return [
    ...history,
    { role: "assistant", content: resumeText },
    { role: "user", content: RESUME_NOTE },
  ];
}
