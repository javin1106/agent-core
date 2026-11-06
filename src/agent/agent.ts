import type { AssistantMessage, LLMProvider, Message, StopReason, ToolCall } from "../ai/types.js";
import { executeToolCall, toToolDefinition, type Tool } from "../tools/tool.js";
import { callModel } from "./call-model.js";
import type { AgentEvent, DoneReason } from "./events.js";

// The agent loop: ask the model, run the tools it asks for, and repeat until it
// answers without asking for tools.
export async function* runAgent(
  provider: LLMProvider,
  history: Message[],
  tools: Tool[],
  maxSteps = 25,
): AsyncGenerator<AgentEvent> {
  const definitions = tools.map(toToolDefinition);

  for (let step = 1; step <= maxSteps; step++) {
    const { reply, stopReason } = yield* callModel(provider, history, definitions);

    // A refused reply or a tool call cut off mid-JSON must never run: keep only
    // the text, since a tool call in history must always have a result.
    if (stopReason === "refused" || (stopReason === "length" && reply.toolCalls?.length)) {
      history.push({ role: "assistant", content: reply.content });
      yield { type: "done", reason: stopReason === "refused" ? "refused" : "cut_off", text: reply.content };
      return;
    }

    history.push(reply);

    if (!reply.toolCalls?.length) {
      yield { type: "done", reason: finalReason(reply, stopReason), text: reply.content };
      return;
    }

    yield* runTools(reply.toolCalls, tools, history);
  }

  yield { type: "done", reason: "max_steps", text: `Stopped after ${maxSteps} steps without a final answer.` };
}

function finalReason(reply: AssistantMessage, stopReason: StopReason): DoneReason {
  if (stopReason === "length") return "cut_off"; // still cut off after the automatic continues
  if (reply.content.trim() === "") return "empty";
  return "answer";
}

async function* runTools(calls: ToolCall[], tools: Tool[], history: Message[]): AsyncGenerator<AgentEvent> {
  for (const call of calls) {
    yield { type: "tool_start", call };
    const result = await executeToolCall(call, tools);
    history.push({ role: "tool", toolCallId: call.id, content: result });
    yield { type: "tool_end", call, result };
  }
}
