import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgent } from "../src/agent/agent.js";
import { buildSystemPrompt, loadAgentsFile, MAX_AGENTS_CHARS } from "../src/agent/system-prompt.js";
import { ScriptedProvider } from "./helpers/scripted-provider.js";

let dir: string; // a fresh, empty temp folder for each test

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-core-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loading AGENTS.md", () => {
  it("adds nothing when there is no AGENTS.md", () => {
    expect(loadAgentsFile(dir)).toBeUndefined();
    expect(buildSystemPrompt(dir)).not.toContain("AGENTS.md. Follow");
  });

  it("adds nothing when AGENTS.md is empty", () => {
    writeFileSync(join(dir, "AGENTS.md"), "   \n\n");
    expect(loadAgentsFile(dir)).toBeUndefined();
  });

  it("puts the file's instructions in the system prompt", () => {
    writeFileSync(join(dir, "AGENTS.md"), "Use pnpm, not npm.");
    expect(buildSystemPrompt(dir)).toContain("Use pnpm, not npm.");
  });

  it("cuts a very long AGENTS.md and says so", () => {
    writeFileSync(join(dir, "AGENTS.md"), "x".repeat(MAX_AGENTS_CHARS + 500));
    const file = loadAgentsFile(dir)!;
    expect(file.truncated).toBe(true);
    expect(file.originalLength).toBe(MAX_AGENTS_CHARS + 500);
    expect(file.text).toContain("[AGENTS.md was cut here: too long]");
    expect(file.text.length).toBeLessThan(MAX_AGENTS_CHARS + 100);
  });
});

describe("the agent sees AGENTS.md", () => {
  it("sends the project info from AGENTS.md to the model on every call", async () => {
    writeFileSync(join(dir, "AGENTS.md"), "The project codename is BLUEFIN.");
    const provider = new ScriptedProvider([{ role: "assistant", content: "It's BLUEFIN." }]);
    const history = [
      { role: "system" as const, content: buildSystemPrompt(dir) },
      { role: "user" as const, content: "What is the project codename?" },
    ];

    for await (const _ of runAgent(provider, history, [])) {
      // just run to the end
    }

    // We test OUR code: did the model receive the info? Whether a real model
    // then answers correctly is an eval question (M6), not a unit test.
    const systemMessage = provider.received[0]![0]!;
    expect(systemMessage.role).toBe("system");
    expect(systemMessage.content).toContain("The project codename is BLUEFIN.");
  });
});
