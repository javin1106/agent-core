import type { Message } from "../ai/types.js";

const NOT_RUN = "Error: not run, because the turn was interrupted.";

// Tidies the history after a turn that failed partway. If no tool step finished,
// the turn is removed so the user can resend it. If some did (files may have
// changed), they're kept so the model remembers them, plus a note that the turn
// was interrupted. Returns how many tool steps were kept.
export function closeInterruptedTurn(history: Message[], turnStart: number, error: string): number {
  answerUnansweredToolCalls(history);

  const finishedSteps = history
    .slice(turnStart)
    .filter((m) => m.role === "tool" && m.content !== NOT_RUN).length;

  if (finishedSteps === 0) {
    history.length = turnStart;
    return 0;
  }

  history.push({
    role: "assistant",
    content:
      `[This turn was interrupted by an error before I could finish: ${error}. ` +
      `The tool steps above really happened.]`,
  });
  return finishedSteps;
}

// The API rejects a history where a tool call has no result. Tools run in order,
// so only the last assistant message can be missing some.
function answerUnansweredToolCalls(history: Message[]): void {
  const lastAssistant = history.findLast((m) => m.role === "assistant");
  const answered = new Set(history.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : [])));

  for (const call of lastAssistant?.toolCalls ?? []) {
    if (!answered.has(call.id)) {
      history.push({ role: "tool", toolCallId: call.id, content: NOT_RUN });
    }
  }
}
