// Public API: what other projects can import from agent-core.

// The agent
export { runAgent, type RunOptions } from "./agent/agent.js";
export type { AgentEvent, DoneReason } from "./agent/events.js";
export { closeInterruptedTurn } from "./agent/history.js";
export { buildSystemPrompt, loadAgentsFile } from "./agent/system-prompt.js";

// Models
export { OpenAIProvider } from "./ai/openai.js";
export {
  LLMError,
  type AssistantMessage,
  type LLMProvider,
  type Message,
  type StopReason,
  type StreamEvent,
  type ToolCall,
  type ToolDefinition,
  type Usage,
} from "./ai/types.js";

// Tools
export { defineTool, executeToolCall, toToolDefinition, type Tool, type ToolContext } from "./tools/tool.js";
export { readTool } from "./tools/read.js";
export { writeTool } from "./tools/write.js";
export { editTool } from "./tools/edit.js";
export { createBashTool } from "./tools/bash.js";

// Cost
export { costOf, formatCost, loadPrices, type Prices } from "./utils/cost.js";
