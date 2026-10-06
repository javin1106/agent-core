// Terminal entry point (npm run dev).
import "dotenv/config"; // loads .env into process.env
import * as readline from "node:readline/promises";
import { OpenAIProvider } from "./ai/openai.js";
import type { Message } from "./ai/types.js";

async function main() {
  const model = process.env.OPENAI_MODEL;
  if (!process.env.OPENAI_API_KEY || !model) {
    console.error("Set OPENAI_API_KEY and OPENAI_MODEL in .env (see .env.example).");
    process.exit(1);
  }

  const provider = new OpenAIProvider(model);
  const history: Message[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`agent-core (${model}). Type "exit" to quit.\n`);

  while (true) {
    const input = (await rl.question("you> ")).trim();
    if (input === "exit") break;
    if (input === "") continue;

    history.push({ role: "user", content: input });
    process.stdout.write("\nassistant> ");

    for await (const event of provider.stream(history)) {
      if (event.type === "text") {
        process.stdout.write(event.text);
      } else if (event.type === "done") {
        history.push(event.message);
        const { inputTokens, outputTokens } = event.usage;
        console.log(`\n[tokens: ${inputTokens} in, ${outputTokens} out]\n`);
      }
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
});
