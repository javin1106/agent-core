import type { ToolCall, Usage } from "../ai/types.js";

export type DoneReason =
  | "answer" // a normal final answer
  | "empty" // the model stopped without saying anything
  | "max_steps" // stopped at the step limit
  | "cut_off" // still cut off by the length limit
  | "refused"; // the model or provider refused

// What the agent reports while it works. The CLI decides how to show each one.
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_end"; call: ToolCall; result: string }
  | { type: "usage"; usage: Usage }
  | { type: "retry"; attempt: number; maxRetries: number; delayMs: number; error: string; resuming: boolean }
  | { type: "continue"; count: number; max: number }
  | { type: "done"; reason: DoneReason; text: string };
