import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface EvalTask {
  name: string;
  files: Record<string, string>; // created in the temp folder before the run
  prompt: string;
  check: (dir: string, answer: string) => boolean;
}

function fileText(dir: string, path: string): string {
  const full = join(dir, path);
  return existsSync(full) ? readFileSync(full, "utf8") : "";
}

function fileJson(dir: string, path: string): any {
  try {
    return JSON.parse(fileText(dir, path));
  } catch {
    return undefined;
  }
}

const csvRows = Array.from({ length: 10 }, (_, i) => `${i},user${i}`).join(
  "\n",
);

export const tasks: EvalTask[] = [
  // --- create ---
  {
    name: "create file",
    files: {},
    prompt: "Create hello.txt containing exactly: hello world",
    check: (dir) => fileText(dir, "hello.txt").trim() === "hello world",
  },
  {
    name: "nested file",
    files: {},
    prompt: "Create notes/todo.md with a single line: - buy milk",
    check: (dir) => fileText(dir, "notes/todo.md").trim() === "- buy milk",
  },
  {
    name: "create json",
    files: {},
    prompt:
      'Create users.json containing a JSON array of two objects with "name" fields: alice and bob.',
    check: (dir) => {
      const users = fileJson(dir, "users.json");
      return (
        Array.isArray(users) && users.map((u) => u.name).join() === "alice,bob"
      );
    },
  },

  // --- edit ---
  {
    name: "rename function",
    files: {
      "app.ts":
        'export function greet(name: string) {\n  return "Hi " + name;\n}\n\nconsole.log(greet("Sam"));\n',
    },
    prompt: "In app.ts, rename the function greet to welcome everywhere.",
    check: (dir) => {
      const text = fileText(dir, "app.ts");
      return (
        !text.includes("greet") && (text.match(/welcome/g) ?? []).length === 2
      );
    },
  },
  {
    name: "fix bug",
    files: {
      "math.ts":
        "// Returns the sum of a and b\nexport function add(a: number, b: number) {\n  return a - b;\n}\n",
    },
    prompt: "add() in math.ts has a bug. Fix it.",
    check: (dir) => fileText(dir, "math.ts").includes("a + b"),
  },
  {
    name: "append line",
    files: { "log.txt": "start\nstep 1\n" },
    prompt:
      'Add a new last line "step 2" to log.txt, keeping the existing lines.',
    check: (dir) =>
      fileText(dir, "log.txt").trim().split(/\r?\n/).join("|") ===
      "start|step 1|step 2",
  },
  {
    name: "delete line",
    files: { "config.txt": "name=demo\nDEBUG=true\nport=80\n" },
    prompt: "Remove the DEBUG line from config.txt and keep the others.",
    check: (dir) => {
      const text = fileText(dir, "config.txt");
      return (
        !text.includes("DEBUG") &&
        text.includes("name=demo") &&
        text.includes("port=80")
      );
    },
  },
  {
    name: "edit json",
    files: { "config.json": '{\n  "host": "localhost",\n  "port": 3000\n}\n' },
    prompt: "Change the port in config.json to 8080.",
    check: (dir) => {
      const config = fileJson(dir, "config.json");
      return config?.port === 8080 && config?.host === "localhost";
    },
  },

  // --- read and search ---
  {
    name: "read version",
    files: { "package.json": '{ "name": "demo", "version": "2.3.1" }' },
    prompt: "What version is in package.json? Answer with just the version.",
    check: (_, answer) => answer.includes("2.3.1"),
  },
  {
    name: "find text",
    files: {
      "a.ts": "const x = 1;\n",
      "b.ts": "// TODO: refactor this\nconst y = 2;\n",
      "c.ts": "const z = 3;\n",
    },
    prompt:
      'Which file contains "TODO: refactor"? Answer with just the file name.',
    check: (_, answer) => answer.includes("b.ts") && !answer.includes("a.ts"),
  },
  {
    name: "understand code",
    files: {
      "index.ts":
        "function helper() { return 1; }\nexport default function startServer() { return helper(); }\n",
    },
    prompt:
      "What is the name of the default export in index.ts? Answer with just the name.",
    check: (_, answer) => answer.includes("startServer"),
  },
  {
    name: "count ts files",
    files: {
      "src/a.ts": "",
      "src/b.ts": "",
      "src/lib/c.ts": "",
      "src/lib/d.ts": "",
      "src/e.js": "",
    },
    prompt:
      "How many .ts files are inside src (including subfolders)? Answer with just the number.",
    check: (_, answer) => /\b4\b/.test(answer) && !/\b5\b/.test(answer),
  },
  {
    name: "count rows",
    files: { "data.csv": `id,name\n${csvRows}\n` },
    prompt:
      "How many data rows (not counting the header) are in data.csv? Answer with just the number.",
    check: (_, answer) => /\b10\b/.test(answer),
  },
  {
    name: "largest file",
    files: {
      "small.txt": "a",
      "big.txt": "x".repeat(5000),
      "medium.txt": "y".repeat(300),
    },
    prompt:
      "Which file in this folder is the largest? Answer with just the file name.",
    check: (_, answer) => answer.includes("big.txt"),
  },

  // --- multi-step ---
  {
    name: "write + run",
    files: {},
    prompt:
      "Create sum.js that prints the sum of 17 and 25, run it with node, and tell me the output.",
    check: (dir, answer) =>
      fileText(dir, "sum.js") !== "" && answer.includes("42"),
  },
];
