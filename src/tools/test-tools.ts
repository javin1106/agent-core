// JUST A TEMPORARY TESTING TOOL

import { readdir } from "node:fs/promises"; // file systems should be asynch => returns a promise
import type { Tool } from "../agent/agent.js";

// TEMPORARY: only here to test the agent loop. M3 replaces it with read/write/edit/bash.
export const listFilesTool: Tool = {
  name: "list_files",
  description: "List the files and folders inside a directory.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: 'Directory to list, e.g. "." or "src"',
      },
    },
    required: ["path"],
  },
  async execute(args) {
    const entries = await readdir(args.path, { withFileTypes: true });
    // Put a "/" after folder names so the model can tell them apart from files.
    return entries
      .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
      .join("\n");
  },
};
