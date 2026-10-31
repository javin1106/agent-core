import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { defineTool } from "../agent/agent.js";

export const writeTool = defineTool({
  name: "write",
  description:
    "Create a new file, or overwrite an existing file completely, with the given content. " +
    "Missing parent folders are created. To change part of an existing file, use edit instead.",
  inputSchema: z.object({
    path: z.string().describe("Path of the file to write, e.g. src/hello.ts"),
    content: z.string().describe("The full content of the file"),
  }),
  async execute(args) {
    // Make sure the folder exists first, e.g. "src/utils" for "src/utils/log.ts".
    await mkdir(dirname(args.path), { recursive: true });
    await writeFile(args.path, args.content, "utf8");

    const lines = args.content.split("\n").length;
    return `Wrote ${lines} lines to ${args.path}`;
  },
});
