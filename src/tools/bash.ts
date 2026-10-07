import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Tool } from "../agent/agent.js";

const DEFAULT_TIMEOUT_SECONDS = 120;
// About 2,500 tokens. Every tool result is re-sent on every later model call,
// so one huge output makes the whole rest of the conversation expensive.
const MAX_OUTPUT_CHARS = 10_000;

// On Windows, "bash" on the PATH is often WSL (a separate Linux system), so we
// point straight at Git Bash, which works on the normal Windows files.
function findBash(): string {
  if (process.platform !== "win32") return "/bin/bash";
  const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
  if (existsSync(gitBash)) return gitBash;
  throw new Error("bash not found. Install Git for Windows, which includes Git Bash.");
}

interface CommandResult {
  output: string; // stdout and stderr mixed, in the order they were printed
  exitCode: number | null; // 0 = success; null if the process was killed
  timedOut: boolean;
}

// Runs one command and waits for it to finish (or time out).
function runCommand(command: string, timeoutSeconds: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(findBash(), ["-c", command], { cwd: process.cwd() });

    let output = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutSeconds * 1000);

    // "error" = the shell couldn't even start; "close" = it finished.
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ output, exitCode, timedOut });
    });
  });
}

// Keep the END of long output: errors and summaries are usually printed last.
function truncate(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const cut = output.length - MAX_OUTPUT_CHARS;
  return `[${cut} characters cut from the start]\n` + output.slice(cut);
}

// The tool needs a way to ask the user before running a command, but asking is
// the CLI's job (it owns the terminal). So the CLI passes in a `confirm` function.
export function createBashTool(confirm: (command: string) => Promise<boolean>): Tool {
  return {
    name: "bash",
    description:
      "Run a bash command in the working directory and return its output (stdout and stderr) and exit code. " +
      "Use it to list folders (ls), find files (find), search text (grep), run scripts, tests and git. " +
      "Commands must finish on their own: don't start servers or interactive programs.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to run" },
        timeout: {
          type: "number",
          description: `Seconds before the command is stopped. Optional, default ${DEFAULT_TIMEOUT_SECONDS}.`,
        },
      },
      required: ["command"],
    },
    async execute(args) {
      if (!(await confirm(args.command))) {
        return "The user declined to run this command.";
      }

      const { output, exitCode, timedOut } = await runCommand(
        args.command,
        args.timeout ?? DEFAULT_TIMEOUT_SECONDS,
      );

      const status = timedOut
        ? `Stopped: the command took longer than ${args.timeout ?? DEFAULT_TIMEOUT_SECONDS}s.`
        : `Exit code: ${exitCode}`;
      return `${truncate(output.trim()) || "(no output)"}\n\n${status}`;
    },
  };
}
