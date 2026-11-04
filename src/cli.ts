// Terminal entry point (npm run dev).
import "dotenv/config"; // loads .env into process.env
import * as readline from "node:readline/promises";
import { OpenAIProvider } from "./ai/openai.js";
import type { Message } from "./ai/types.js";
import { runAgent, type Tool } from "./agent/agent.js";
import { buildSystemPrompt, loadAgentsFile, MAX_AGENTS_CHARS } from "./agent/system-prompt.js";
import { readTool } from "./tools/read.js";
import { writeTool } from "./tools/write.js";
import { editTool } from "./tools/edit.js";
import { createBashTool } from "./tools/bash.js";

async function main() {
  const model = process.env.OPENAI_MODEL;
  if (!process.env.OPENAI_API_KEY || !model) {
    console.error(
      "Set OPENAI_API_KEY and OPENAI_MODEL in .env (see .env.example).",
    );
    process.exit(1);
  }

  const provider = new OpenAIProvider(model);
  const history: Message[] = [{ role: "system", content: buildSystemPrompt() }];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // `npm run dev -- --yolo` runs commands without asking (Pi's default).
  const yolo = process.argv.includes("--yolo");
  const confirmCommand = async (command: string): Promise<boolean> => {
    if (yolo) return true;
    const answer = await rl.question(`\n⚠️  Run: ${command}\n   Allow? (y/n) `);
    return answer.trim().toLowerCase() === "y";
  };

  const tools: Tool[] = [readTool, writeTool, editTool, createBashTool(confirmCommand)];

  console.log(`agent-core (${model})${yolo ? " [yolo: commands run without asking]" : ""}. Type "exit" to quit.`);

  // Always say when AGENTS.md is in use: it steers the agent, and in a repo
  // someone else wrote, the user should know it's there.
  const agentsFile = loadAgentsFile(process.cwd());
  if (agentsFile) {
    console.log(`📄 Using AGENTS.md (${agentsFile.originalLength} characters)`);
    if (agentsFile.truncated) {
      console.log(`⚠️  AGENTS.md is too long: only the first ${MAX_AGENTS_CHARS} characters are used.`);
    }
  }
  console.log();

  while (true) {
    const input = (await rl.question("you> ")).trim();
    if (input === "exit") break;
    if (input === "") continue;

    // Remember where this turn starts, so a failed turn can be undone cleanly.
    const historyLengthBefore = history.length;
    history.push({ role: "user", content: input });
    process.stdout.write("\nassistant> ");

    let inputTokens = 0;
    let outputTokens = 0;

    try {
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
          case "retry": {
            const seconds = (event.delayMs / 1000).toFixed(1);
            // Any text already printed for the failed attempt will be repeated
            // by the retry, so say clearly that the reply is starting over.
            process.stdout.write(
              `\n⏳ ${event.error}\n   Retrying in ${seconds}s (attempt ${event.attempt} of ${event.maxRetries})...\n`,
            );
            break;
          }
          case "done":
            // A normal answer was already streamed as text; only explain the other endings.
            if (event.reason === "empty") {
              console.log("\n⚠️  The model ended its turn without an answer.");
            } else if (event.reason === "max_steps") {
              console.log(`\n⚠️  ${event.text} Ask it to continue, or give it a smaller task.`);
            }
            console.log(`\n[tokens: ${inputTokens} in, ${outputTokens} out]\n`);
            break;
        }
      }
    } catch (err) {
      // The turn failed for good (retries used up, or an error waiting can't fix,
      // like a wrong API key). Undo this turn's messages so the history isn't left
      // half-finished, and keep the session running.
      history.length = historyLengthBefore;
      const message = err instanceof Error ? err.message : String(err);
      console.log(`\n❌ ${message}\n   Your message wasn't kept. Send it again to retry.\n`);
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
});
