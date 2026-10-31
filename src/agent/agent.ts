import { z } from "zod";
import type {
  ToolCall,
  ToolDefinition,
  AssistantMessage,
  LLMProvider,
  Message,
  Usage,
} from "../ai/types.js";

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
    let reply: AssistantMessage | undefined;
    for await (const event of provider.stream(history, definitions)) {
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
    history.push(reply);

    // no tool calls
    if (!reply.toolCalls?.length) {
      // Some models end a turn with no tool calls and no text. Say so instead
      // of finishing silently, so the user knows the agent gave up.
      const text =
        reply.content.trim() === ""
          ? "[The model ended its turn without an answer.]"
          : reply.content;
      yield { type: "done", text };
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
    text: `Stopped: reached the limit of ${maxSteps} steps.`,
  };
}

// What the agent reports while it works. The CLI decides how to show each one.
export type AgentEvent =
  | { type: "text"; text: string } // a piece of the model's reply
  | { type: "tool_start"; call: ToolCall } // about to run a tool
  | { type: "tool_end"; call: ToolCall; result: string } // the tool finished
  | { type: "usage"; usage: Usage } // tokens used by one model call
  | { type: "done"; text: string }; // the final answer (or why we stopped)
