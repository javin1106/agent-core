import { readFile } from "node:fs/promises";
import type { Tool } from "../agent/agent.js";

const MAX_LINES = 2000; // never send more than this many lines in one go

export const readTool: Tool = {
  name: "read",
  description:
    "Read a text file. Returns the file's lines, numbered. " +
    "For big files, use offset and limit to read one part at a time.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file, e.g. src/index.ts",
      },
      offset: {
        type: "number",
        description: "Line number to start from (1 = first line). Optional.",
      },
      limit: {
        type: "number",
        description: "How many lines to read. Optional.",
      },
    },
    required: ["path"],
  },
  async execute(args) {
    const text = await readFile(args.path, "utf8");
    const lines = text.split("\n");

    const start = Math.max(1, args.offset ?? 1); // first line to show (1-based)
    const count = Math.min(args.limit ?? MAX_LINES, MAX_LINES);
    const selected = lines.slice(start - 1, start - 1 + count);

    // Number each line, like "12: const x = 1;", so the model can point at lines.
    const numbered = selected
      .map((line, i) => `${start + i}: ${line}`)
      .join("\n");

    const end = start + selected.length - 1;
    if (end < lines.length) {
      return `${numbered}\n\n[Showing lines ${start}-${end} of ${lines.length}. Use offset=${end + 1} to read more.]`;
    }
    return numbered;
  },
};
