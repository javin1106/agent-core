import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod";
import { defineTool } from "./tool.js";

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
  exitCode: number | null; // null if the process was killed
  stopped?: "timeout" | "cancelled";
}

function runCommand(
  command: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(findBash(), ["-c", command], { cwd: process.cwd() });

    let output = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));

    let stopped: CommandResult["stopped"];
    const stop = (why: "timeout" | "cancelled") => {
      stopped = why;
      killTree(child);
    };
    const timer = setTimeout(() => stop("timeout"), timeoutSeconds * 1000);
    const onAbort = () => stop("cancelled");
    signal?.addEventListener("abort", onAbort);

    const cleanUp = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    // "error" = the shell couldn't even start; "close" = it finished.
    child.on("error", (err) => {
      cleanUp();
      reject(err);
    });
    child.on("close", (exitCode) => {
      cleanUp();
      resolve({ output, exitCode, stopped });
    });
  });
}

// On Windows, child.kill() only stops bash itself; programs it started keep
// running. taskkill /T stops the whole process tree.
function killTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  } else {
    child.kill();
  }
}

// Keep the END of long output: errors and summaries are usually printed last.
function truncate(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const cut = output.length - MAX_OUTPUT_CHARS;
  return `[${cut} characters cut from the start]\n` + output.slice(cut);
}

// The tool needs a way to ask the user before running a command, but asking is
// the CLI's job (it owns the terminal). So the CLI passes in a `confirm` function.
export function createBashTool(confirm: (command: string) => Promise<boolean>) {
  return defineTool({
    name: "bash",
    description:
      "Run a bash command in the working directory and return its output (stdout and stderr) and exit code. " +
      "Use it to list folders (ls), find files (find), search text (grep), run scripts, tests and git. " +
      "Commands must finish on their own: don't start servers or interactive programs.",
    inputSchema: z.object({
      command: z.string().min(1).describe("The bash command to run"),
      timeout: z
        .number()
        .positive()
        .optional()
        .describe(`Seconds before the command is stopped (default ${DEFAULT_TIMEOUT_SECONDS})`),
    }),
    async execute(args, { signal }) {
      if (!(await confirm(args.command))) {
        return "The user declined to run this command.";
      }

      const timeout = args.timeout ?? DEFAULT_TIMEOUT_SECONDS;
      const { output, exitCode, stopped } = await runCommand(args.command, timeout, signal);

      const status =
        stopped === "timeout" ? `Stopped: the command took longer than ${timeout}s.`
        : stopped === "cancelled" ? "Stopped: the user cancelled it (Ctrl+C)."
        : `Exit code: ${exitCode}`;
      return `${truncate(output.trim()) || "(no output)"}\n\n${status}`;
    },
  });
}
