// Terminal entry point (npm run dev).
import "dotenv/config"; // loads .env into process.env
import * as readline from "node:readline/promises";
import { OpenAIProvider } from "./ai/openai.js";
import type { Message, Usage } from "./ai/types.js";
import { costOf, formatCost, loadPrices, type Prices } from "./utils/cost.js";
import { runAgent } from "./agent/agent.js";
import { closeInterruptedTurn } from "./agent/history.js";
import type { Tool } from "./tools/tool.js";
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

  const prices = loadPrices(); // undefined = no prices set, so no cost is shown

  const provider = new OpenAIProvider(model);
  const history: Message[] = [{ role: "system", content: buildSystemPrompt() }];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let turnAbort: AbortController | undefined; // set while the agent is working
  let questionAbort = new AbortController(); // the question waiting for input
  let closed = false;
  let lastPromptCtrlC = 0;

  // Ctrl+D. A waiting question never settles on its own when input closes, so cancel it.
  rl.on("close", () => {
    closed = true;
    questionAbort.abort();
  });

  rl.on("SIGINT", () => {
    if (turnAbort) {
      if (!turnAbort.signal.aborted) process.stdout.write("\n⏹  Stopping...\n");
      turnAbort.abort();
      questionAbort.abort(); // e.g. a pending y/n prompt
      return;
    }
    // At the prompt: a second Ctrl+C within 2s exits, so one stray press doesn't.
    if (Date.now() - lastPromptCtrlC < 2000) {
      rl.close();
      return;
    }
    lastPromptCtrlC = Date.now();
    process.stdout.write("\n(Press Ctrl+C again to exit)\n");
    questionAbort.abort(); // shows a fresh prompt
  });

  // Returns undefined if the question was cancelled (Ctrl+C) or input closed (Ctrl+D).
  const ask = async (query: string): Promise<string | undefined> => {
    questionAbort = new AbortController();
    try {
      return await rl.question(query, { signal: questionAbort.signal });
    } catch {
      return undefined;
    }
  };

  // `npm run dev -- --yolo` runs commands without asking (Pi's default).
  const yolo = process.argv.includes("--yolo");
  const confirmCommand = async (command: string): Promise<boolean> => {
    if (yolo) return true;
    const answer = await ask(`\n⚠️  Run: ${command}\n   Allow? (y/n) `);
    return answer?.trim().toLowerCase() === "y";
  };

  const tools: Tool[] = [readTool, writeTool, editTool, createBashTool(confirmCommand)];

  console.log(
    `agent-core (${model})${yolo ? " [yolo: commands run without asking]" : ""}. ` +
      `Ctrl+C stops the current task; "exit", Ctrl+D or Ctrl+C twice quits.`,
  );

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

  // Running totals for the whole session, printed when you exit.
  const session = { turns: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0 };

  while (true) {
    const line = await ask("you> ");
    if (closed) break;
    if (line === undefined) continue; // Ctrl+C at the prompt
    const input = line.trim();
    if (input === "exit") break;
    if (input === "") continue;
    session.turns++;

    // Remember where this turn starts, so a failed turn can be undone cleanly.
    const historyLengthBefore = history.length;
    history.push({ role: "user", content: input });
    process.stdout.write("\nassistant> ");

    // Tokens for this turn only (one turn can be several model calls).
    const turn: Usage = { inputTokens: 0, outputTokens: 0 };
    // True right after a "resuming" notice, until the continuation's first text arrives.
    let resumedReply = false;

    turnAbort = new AbortController();
    try {
      for await (const event of runAgent(provider, history, tools, { signal: turnAbort.signal })) {
        switch (event.type) {
          case "text":
            // Mark where a resumed reply picks up again, e.g. "…lo, world".
            if (resumedReply) {
              process.stdout.write("…");
              resumedReply = false;
            }
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
            // Added to the session right away, so tokens spent on a turn that
            // later fails are still counted: they were used (and billed).
            turn.inputTokens += event.usage.inputTokens;
            turn.outputTokens += event.usage.outputTokens;
            session.modelCalls++;
            session.inputTokens += event.usage.inputTokens;
            session.outputTokens += event.usage.outputTokens;
            break;
          case "continue":
            // Same visual marker as a resumed reply: the text picks up after "…".
            process.stdout.write(
              `\n↪ The reply hit the length limit. Asking for the rest (${event.count} of ${event.max})...\n`,
            );
            resumedReply = true;
            break;
          case "retry": {
            const seconds = (event.delayMs / 1000).toFixed(1);
            const attempt = `(attempt ${event.attempt} of ${event.maxRetries})`;
            if (event.resuming) {
              // The reply will carry on from where it stopped: nothing gets repeated.
              process.stdout.write(`\n⏳ ${event.error}\n   Resuming the reply in ${seconds}s ${attempt}...\n`);
              resumedReply = true;
            } else {
              // Nothing usable to continue from, so the reply starts over.
              process.stdout.write(`\n⏳ ${event.error}\n   Retrying in ${seconds}s ${attempt}...\n`);
            }
            break;
          }
          case "done":
            // A normal answer was already streamed as text; only explain the other endings.
            if (event.reason === "empty") {
              console.log("\n⚠️  The model ended its turn without an answer.");
            } else if (event.reason === "max_steps") {
              console.log(`\n⚠️  ${event.text} Ask it to continue, or give it a smaller task.`);
            } else if (event.reason === "cut_off") {
              console.log(
                "\n⚠️  The reply was cut off by the length limit, even after continuing. " +
                  "Any unfinished tool call was not run. Try asking for a shorter answer, or split the task.",
              );
            } else if (event.reason === "refused") {
              console.log("\n⚠️  The model or provider refused to answer this request.");
            }
            console.log(`\n[${describeUsage(turn, prices)}]\n`);
            break;
        }
      }
    } catch (err) {
      // The turn was stopped (Ctrl+C) or failed for good. Tidy the history and keep going.
      const stopped = turnAbort.signal.aborted;
      const message = stopped
        ? "Stopped by the user (Ctrl+C)"
        : err instanceof Error ? err.message : String(err);
      const keptSteps = closeInterruptedTurn(history, historyLengthBefore, message);

      const headline = stopped ? "⏹  Stopped." : `❌ ${message}`;
      if (keptSteps === 0) {
        console.log(`\n${headline}\n   Your message wasn't kept. Send it again to retry.\n`);
      } else {
        console.log(
          `\n${headline}\n   The ${keptSteps} finished tool step(s) were kept, so the agent ` +
            `remembers what it already did. Ask it to continue.\n`,
        );
      }
    } finally {
      turnAbort = undefined;
    }
  }

  if (!closed) rl.close();

  console.log("\nSession summary");
  console.log(`  turns: ${session.turns}, model calls: ${session.modelCalls}`);
  console.log(`  ${describeUsage(session, prices)}`);
  if (!prices) {
    console.log("  cost: not shown (set PRICE_INPUT_PER_M and PRICE_OUTPUT_PER_M in .env)");
  }
}

// "tokens: 1,234 in, 56 out, cost $0.0031" (cost only when prices are set).
function describeUsage(usage: Usage, prices: Prices | undefined): string {
  const n = (count: number) => count.toLocaleString("en-US"); // 12345 -> "12,345"
  const tokens = `tokens: ${n(usage.inputTokens)} in, ${n(usage.outputTokens)} out`;
  return prices ? `${tokens}, cost ${formatCost(costOf(usage, prices))}` : tokens;
}

main().catch((err) => {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
});
