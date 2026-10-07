import type {
  ToolCall,
  ToolDefinition,
  AssistantMessage,
  LLMProvider,
  Message,
  Usage,
} from "../ai/types.js";

export interface Tool extends ToolDefinition {
  execute(args: any): Promise<string>;
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
  let args: any;
  try {
    args = call.arguments.trim() === "" ? {} : JSON.parse(call.arguments);
  } catch {
    return `Error: the arguments for "${call.name}" are not valid JSON: ${call.arguments}`;
  }

  // execute the tool call
  try {
    return await requiredTool.execute(args);
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
  for (let step = 1; step <= maxSteps; step++) {
    let reply: AssistantMessage | undefined;
    for await (const event of provider.stream(history, tools)) {
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
      yield { type: "done", text: reply.content };
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
