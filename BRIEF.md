# agent-core: Project Brief (revised, closer to Pi)

## What this project is
`agent-core` is a minimal terminal **coding agent** built from scratch in TypeScript, without an agent framework.
Its design follows [Pi](https://github.com/badlogic/pi-mono) (Mario Zechner): a small core, few tools, a short system prompt, and no hidden magic.
It is Step 1 of a larger plan. This loop will later be the "brain" of:
- Step 2: a Perplexity-style answer engine
- Steps 3–4: CutRoom, a cloud video-editing agent
- Step 5: Airport, a Go platform for running agents

So the code must be **clean, reusable and importable as a library**, not a throwaway script.

## How to work with me (important)
I am building this to **learn** how agents work. **I write all of the logic myself.**
- Claude may only: scaffold config/folders, explain concepts, give hints and small illustrative snippets, and review my code.
- Before each milestone, **explain the concept in a few lines** (e.g. how tool calling works).
- Work **one milestone at a time**. Stop after each one and wait for me.
- Keep code simple and readable. No clever abstractions I didn't ask for.
- When there is a design choice, give a short recommendation and the reason.

## Rules
- ❌ No agent frameworks: no LangChain, LangGraph, CrewAI, Mastra, OpenAI Agents SDK, Vercel AI SDK, or Pi's own packages.
- ✅ Allowed: the official `openai` SDK (for the API call only), `zod`, `dotenv`, `vitest`, and small utility libraries.
- Never commit API keys. Use `.env` and provide `.env.example`.

## Tech stack
| Area | Choice |
|---|---|
| Language | TypeScript (strict mode) |
| Runtime | Node.js 22+ |
| LLM | OpenAI via the `openai` SDK, behind my own `LLMProvider` interface so it can be swapped later |
| Validation | zod (tool input schemas) |
| Tests | vitest |
| CLI | Plain Node `readline` |

## Structure (mirrors Pi's package split)
```
src/
├── ai/       # like pi-ai: LLMProvider interface, OpenAI implementation, streaming, message types
├── agent/    # like pi-agent-core: the loop, message history, events, compaction
├── tools/    # the tool registry + read / write / edit / bash
├── cli.ts    # the coding-agent terminal UI
└── index.ts  # library exports
evals/  tests/
AGENTS.md     # (optional, per project) extra instructions loaded into the system prompt
```

## Milestones

### M1: A single streamed LLM call
- `LLMProvider` interface + OpenAI implementation.
- A CLI that sends a message and **streams** the reply, keeping chat history in memory.

### M2: The agent loop
- Send messages + tool definitions → model responds → if it requests tool calls, run them → append results → repeat until a final answer.
- Max-steps limit (e.g. 25).
- Print each step: `🔧 read(src/index.ts)` → `✅ 120 lines`.
- The loop emits **events** (text, tool start, tool end, done) and the CLI just renders them, so other UIs can reuse the loop (as in Pi).

### M3: Pi's four tools + registry
- Registry entry: `name`, `description`, zod `inputSchema`, `execute()`.
- Tools (same as Pi's defaults):
  - `read(path, offset?, limit?)`: read a file, optionally a range of lines
  - `write(path, content)`: create/overwrite a file, creating parent folders
  - `edit(path, oldText, newText)`: replace an exact, unique piece of text
  - `bash(command, timeout?)`: run a shell command in the cwd, with timeout and output truncation
- Listing folders, searching, etc. are done through `bash` (`ls`, `grep`), as in Pi.
- Invalid tool input returns an error message to the model instead of crashing.
- **Safety decision (decide at M3):** Pi is "YOLO" (no permission prompts). Recommendation: ask y/n before `bash` by default, with a `--yolo` flag to turn it off.
- **Minimal system prompt** (under ~1,000 tokens including tools), plus the contents of `AGENTS.md` if the cwd has one.

### M4: Reliability
- Retries with exponential backoff for rate limits and network errors.
- Clear handling of tool errors, refusals, max-steps reached, and Ctrl+C (abort the current turn, don't kill the app).
- Token counting per turn and per session, estimated cost at the end.

### M5: Context + sessions
- Truncate very large tool outputs.
- Compaction: past ~70% of the context window, summarize older messages into one and keep recent ones. Log tokens saved.
- **Sessions saved as JSONL** (one message per line), with `--continue` to resume the last session (as in Pi).

### M6: Mini eval + README
- `evals/tasks.json`: 10–15 small tasks with checkable outcomes.
- `npm run eval`: runs each task in a temp folder and reports pass rate, average steps, tokens, cost and time.
- README: architecture diagram, how the loop works, eval results, what I learned.

## Definition of done
- [ ] "What files are in this folder and what does package.json do?" works with tools chosen by the model.
- [ ] It survives tool errors and rate limits without crashing.
- [ ] Long sessions compact automatically and can be resumed.
- [ ] `npm run eval` prints a results table.
- [ ] `src/index.ts` exports the agent so Step 2 can import it.
- [ ] README explains the architecture and shows eval results.
