import { z } from "zod";
import {
  LLMError,
  type ToolCall,
  type ToolDefinition,
  type AssistantMessage,
  type LLMProvider,
  type Message,
  type Usage,
} from "../ai/types.js";
import { backoffMs, MAX_RETRIES, sleep } from "../utils/retry.js";

// A tool's input is described once, as a zod schema. From it we get the JSON
// Schema sent to the model, the check on what the model sends, and the TS type of `args`.
export interface Tool<Input extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  inputSchema: Input;
  execute(args: z.infer<Input>): Promise<string>;
}

// Helper so TypeScript works out `args` from the schema when you write a tool.
export function defineTool<Input extends z.ZodType>(tool: Tool<Input>): Tool<Input> {
  return tool;
}

// The part of a tool the model sees: no code, just name, description and schema.
export function toToolDefinition(tool: Tool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.inputSchema),
  };
}

// don't throw any unhandled error, it will break the execution loop, instead use returns to LLM so it will correct itself
export async function executeToolCall(
  call: ToolCall,
  tools: Tool[],
): Promise<string> {
  const requiredTool = tools.find((tool) => tool.name === call.name);
  if (!requiredTool) {
    return `Error: unknown tool "${call.name}"`;
  }

  // turn JSON text into an object, empty text means no arguments
  let args: unknown;
  try {
    args = call.arguments.trim() === "" ? {} : JSON.parse(call.arguments);
  } catch {
    return `Error: the arguments for "${call.name}" are not valid JSON: ${call.arguments}`;
  }

  // check the arguments match the tool's schema before running anything
  const parsed = requiredTool.inputSchema.safeParse(args);
  if (!parsed.success) {
    return `Error: invalid arguments for "${call.name}":\n${z.prettifyError(parsed.error)}`;
  }

  // execute the tool call
  try {
    return await requiredTool.execute(parsed.data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: ${msg}`;
  }
}

export async function* runAgent(
  provider: LLMProvider,
  history: Message[],
  tools: Tool[],
  maxSteps = 25,
): AsyncGenerator<AgentEvent> {
  // Converted once, not on every step: the tools don't change during a run.
  const definitions = tools.map(toToolDefinition);

  for (let step = 1; step <= maxSteps; step++) {
    // `yield*` passes on every event callModel yields (text, usage, retry),
    // then gives us the value it returns: the finished reply.
    const reply = yield* callModel(provider, history, definitions);
    history.push(reply);

    // no tool calls
    if (!reply.toolCalls?.length) {
      // Some models end a turn with no tool calls and no text: report that
      // instead of finishing silently, so the user knows the agent gave up.
      const reason = reply.content.trim() === "" ? "empty" : "answer";
      yield { type: "done", reason, text: reply.content };
      return;
    }

    // run all tools it asked for and add each result to history
    for (const call of reply.toolCalls) {
      yield { type: "tool_start", call };
      const result = await executeToolCall(call, tools);
      history.push({ role: "tool", toolCallId: call.id, content: result });
      yield { type: "tool_end", call, result };
    }
  }

  yield {
    type: "done",
    reason: "max_steps",
    text: `Stopped after ${maxSteps} steps without a final answer.`,
  };
}

// One model call, retried when the failure is temporary (rate limit, server
// error, dropped connection). Returns the finished reply. If it still fails
// after MAX_RETRIES, or the error can't be fixed by waiting, it throws.
async function* callModel(
  provider: LLMProvider,
  history: Message[],
  definitions: ToolDefinition[],
): AsyncGenerator<AgentEvent, AssistantMessage> {
  // Reply text already sent (and printed) before a connection drop. When it's
  // not empty, the next attempt continues it instead of starting over.
  let resumeText = "";

  for (let attempt = 1; ; attempt++) {
    try {
      let reply: AssistantMessage | undefined;
      for await (const event of provider.stream(withResume(history, resumeText), definitions)) {
        if (event.type === "text") {
          yield event;
        } else if (event.type === "done") {
          reply = event.message;
          yield { type: "usage", usage: event.usage };
        }
      }
      if (!reply) {
        throw new Error("The model's stream ended without a reply");
      }
      // Join what was sent before the drop with the continuation, so history
      // gets one normal reply, as if the connection had never broken.
      return { ...reply, content: resumeText + reply.content };
    } catch (err) {
      // Only provider errors marked retryable are worth another try.
      if (!(err instanceof LLMError) || !err.retryable || attempt > MAX_RETRIES) {
        throw err;
      }
      // If this attempt got some text out before breaking, keep it: the next
      // attempt carries on from the end of it.
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
      await sleep(delayMs);
    }
  }
}

// The messages for a resumed attempt: the history, the interrupted reply so
// far, and a note asking the model to continue it. These two extra messages
// are only sent for this one call; they're never added to the real history.
function withResume(history: Message[], resumeText: string): Message[] {
  if (resumeText === "") return history;
  return [
    ...history,
    { role: "assistant", content: resumeText },
    {
      role: "user",
      content:
        "[Automatic message, not from the user] Your previous reply was cut off by a " +
        "connection problem. Continue it from exactly where it stopped, mid-word if needed. " +
        "Your text will be joined directly onto the end of it, so if the cut fell between " +
        "two words, start with a space. Don't repeat any of it and don't mention the interruption.",
    },
  ];
}

// Cleans up the history after a turn that failed partway (e.g. retries ran out).
// `turnStart` is where the turn began (the index of the user's message).
//
// - If no tool step finished, the turn left no trace in the world: remove it
//   completely, so the user can simply send the message again.
// - If tool steps finished (files may have been written, commands run), keep
//   them so the model remembers what it really did, and close the turn with a
//   note saying it was interrupted.
//
// Returns how many tool steps were kept (0 = the turn was removed).
export function closeInterruptedTurn(history: Message[], turnStart: number, error: string): number {
  // Every tool call needs a matching result, or the API rejects the whole
  // history. Only the last assistant message can be missing some (tools run in
  // order), so give any call without a result an "interrupted" one.
  const last = history.findLast((m) => m.role === "assistant");
  const answered = new Set(
    history.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : [])),
  );
  for (const call of last?.toolCalls ?? []) {
    if (!answered.has(call.id)) {
      history.push({
        role: "tool",
        toolCallId: call.id,
        content: "Error: not run, because the turn was interrupted.",
      });
    }
  }

  const finishedSteps = history
    .slice(turnStart)
    .filter((m) => m.role === "tool" && !m.content.startsWith("Error: not run, because the turn"))
    .length;

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

// What the agent reports while it works. The CLI decides how to show each one.
export type AgentEvent =
  | { type: "text"; text: string } // a piece of the model's reply
  | { type: "tool_start"; call: ToolCall } // about to run a tool
  | { type: "tool_end"; call: ToolCall; result: string } // the tool finished
  | { type: "usage"; usage: Usage } // tokens used by one model call
  // a model call failed; trying again. `resuming`: the reply continues where it
  // stopped instead of starting over.
  | { type: "retry"; attempt: number; maxRetries: number; delayMs: number; error: string; resuming: boolean }
  | {
      type: "done";
      // answer = normal final answer; empty = the model stopped with no text;
      // max_steps = we stopped it at the step limit
      reason: "answer" | "empty" | "max_steps";
      text: string;
    };
