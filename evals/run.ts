// npm run eval                          run every task once
// npm run eval -- --runs 3              run each task 3 times (results vary run to run)
// npm run eval -- --only "fix bug,edit json"
import "dotenv/config";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { runAgent } from "../src/agent/agent.js";
import { buildSystemPrompt } from "../src/agent/system-prompt.js";
import { OpenAIProvider } from "../src/ai/openai.js";
import type { Message } from "../src/ai/types.js";
import { createBashTool } from "../src/tools/bash.js";
import { editTool } from "../src/tools/edit.js";
import { readTool } from "../src/tools/read.js";
import { writeTool } from "../src/tools/write.js";
import { tasks, type EvalTask } from "./tasks.js";

interface Result {
  task: string;
  pass: boolean;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  seconds: number;
  note: string;
}

const { values } = parseArgs({
  options: { runs: { type: "string", default: "1" }, only: { type: "string" } },
});
const runs = Number(values.runs);
const only = values.only?.split(",").map((name) => name.trim());
const selected = only ? tasks.filter((t) => only.includes(t.name)) : tasks;

const model = process.env.OPENAI_MODEL;
if (!model) throw new Error("Set OPENAI_MODEL in .env");
const provider = new OpenAIProvider(model);
const tools = [readTool, writeTool, editTool, createBashTool(async () => true)];

async function runTask(task: EvalTask): Promise<Result> {
  const dir = mkdtempSync(join(tmpdir(), "agent-eval-"));
  for (const [path, content] of Object.entries(task.files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }

  const startDir = process.cwd();
  process.chdir(dir); // the tools work relative to the current folder
  const history: Message[] = [
    { role: "system", content: buildSystemPrompt(dir) },
    { role: "user", content: task.prompt },
  ];
  const result: Result = {
    task: task.name,
    pass: false,
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    seconds: 0,
    note: "",
  };
  let answer = "";
  const started = Date.now();

  try {
    for await (const event of runAgent(provider, history, tools)) {
      if (event.type === "usage") {
        result.modelCalls++;
        result.inputTokens += event.usage.inputTokens;
        result.outputTokens += event.usage.outputTokens;
      } else if (event.type === "done") {
        answer = event.text;
        if (event.reason !== "answer") result.note = event.reason;
      }
    }
  } catch (err) {
    result.note = `error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    process.chdir(startDir);
  }

  result.seconds = (Date.now() - started) / 1000;
  try {
    result.pass = task.check(dir, answer);
  } catch {
    result.pass = false;
  }
  if (!result.pass && !result.note)
    result.note = `answer: ${JSON.stringify(answer.slice(0, 80))}`;

  rmSync(dir, { recursive: true, force: true });
  return result;
}

const results: Result[] = [];
for (let run = 1; run <= runs; run++) {
  if (runs > 1) console.log(`\n── run ${run} of ${runs} ──`);
  for (const task of selected) {
    const r = await runTask(task);
    results.push(r);
    console.log(
      `${r.pass ? "✅" : "❌"} ${r.task.padEnd(16)} ${String(r.modelCalls).padStart(2)} calls ` +
        `${String(r.inputTokens).padStart(6)} in ${String(r.outputTokens).padStart(5)} out ` +
        `${r.seconds.toFixed(1).padStart(5)}s  ${r.note}`,
    );
  }
}

const passed = results.filter((r) => r.pass).length;
const average = (pick: (r: Result) => number) =>
  results.reduce((sum, r) => sum + pick(r), 0) / results.length;
const flaky = selected
  .map((t) => ({
    name: t.name,
    passes: results.filter((r) => r.task === t.name && r.pass).length,
  }))
  .filter((t) => t.passes < runs);

console.log(`\n${model} · ${selected.length} tasks × ${runs} run(s)`);
console.log(
  `pass rate      ${passed}/${results.length} (${((100 * passed) / results.length).toFixed(0)}%)`,
);
console.log(
  `model calls    ${average((r) => r.modelCalls).toFixed(1)} per task`,
);
console.log(
  `tokens         ${average((r) => r.inputTokens).toFixed(0)} in / ${average((r) => r.outputTokens).toFixed(0)} out per task`,
);
console.log(`time           ${average((r) => r.seconds).toFixed(1)}s per task`);
if (flaky.length > 0) {
  console.log(
    `not always passing: ${flaky.map((t) => `${t.name} (${t.passes}/${runs})`).join(", ")}`,
  );
}
