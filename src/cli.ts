// Terminal entry point (npm run dev).
import "dotenv/config"; // loads .env into process.env
import * as readline from "node:readline/promises";
import { OpenAIProvider } from "./ai/openai.js";
import type { Message } from "./ai/types.js";
import { runAgent, type Tool } from "./agent/agent.js";
import { listFilesTool } from "./tools/test-tools.js";

async function main() {
  const model = process.env.OPENAI_MODEL;
  if (!process.env.OPENAI_API_KEY || !model) {
    console.error(
      "Set OPENAI_API_KEY and OPENAI_MODEL in .env (see .env.example).",
    );
    process.exit(1);
  }

  const provider = new OpenAIProvider(model);
  const history: Message[] = [];
  const tools: Tool[] = [listFilesTool];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(`agent-core (${model}). Type "exit" to quit.\n`);

  while (true) {
    const input = (await rl.question("you> ")).trim();
    if (input === "exit") break;
    if (input === "") continue;

    history.push({ role: "user", content: input });
    process.stdout.write("\nassistant> ");

    let inputTokens = 0;
    let outputTokens = 0;

    for await (const event of runAgent(provider, history, tools)) {
      switch (event.type) {
        case "text":
          process.stdout.write(event.text);
          break;
        case "tool_start":
          process.stdout.write(`\n🔧 ${event.call.name}(${event.call.arguments})`);
          break;
        case "tool_end": {
          const lines = event.result.split("\n").length;
          const status = event.result.startsWith("Error:")
            ? `❌ ${event.result}`
            : `✅ ${lines} lines`;
          process.stdout.write(` → ${status}\n`);
          break;
        }
        case "usage":
          inputTokens += event.usage.inputTokens;
          outputTokens += event.usage.outputTokens;
          break;
        case "done":
          console.log(`\n[tokens: ${inputTokens} in, ${outputTokens} out]\n`);
          break;
      }
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
});
