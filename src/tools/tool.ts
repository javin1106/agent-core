import { z } from "zod";
import type { ToolCall, ToolDefinition } from "../ai/types.js";

export interface Tool<Input extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  inputSchema: Input;
  execute(args: z.infer<Input>): Promise<string>;
}

// Lets TypeScript infer `args` from the schema.
export function defineTool<Input extends z.ZodType>(tool: Tool<Input>): Tool<Input> {
  return tool;
}

export function toToolDefinition(tool: Tool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.inputSchema),
  };
}

// Never throws: every problem goes back to the model as "Error: ..." so it can correct itself.
export async function executeToolCall(call: ToolCall, tools: Tool[]): Promise<string> {
  const requiredTool = tools.find((tool) => tool.name === call.name);
  if (!requiredTool) {
    return `Error: unknown tool "${call.name}"`;
  }

  let args: unknown;
  try {
    args = call.arguments.trim() === "" ? {} : JSON.parse(call.arguments);
  } catch {
    return `Error: the arguments for "${call.name}" are not valid JSON: ${call.arguments}`;
  }

  const parsed = requiredTool.inputSchema.safeParse(args);
  if (!parsed.success) {
    return `Error: invalid arguments for "${call.name}":\n${z.prettifyError(parsed.error)}`;
  }

  try {
    return await requiredTool.execute(parsed.data);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
