import { readFile, writeFile } from "node:fs/promises";
import type { Tool } from "../agent/agent.js";

// Counts how many times `search` appears in `text`.
function countOccurrences(text: string, search: string): number {
  let count = 0;
  let index = text.indexOf(search);
  while (index !== -1) {
    count++;
    index = text.indexOf(search, index + search.length);
  }
  return count;
}

export const editTool: Tool = {
  name: "edit",
  description:
    "Change part of an existing file by replacing an exact piece of text. " +
    "oldText must match the file exactly (spaces and indentation included) and appear only once; " +
    "include a few surrounding lines to make it unique. Don't include the line numbers that read shows. " +
    "Read the file before editing it.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to change" },
      oldText: { type: "string", description: "The exact text to find (must appear once)" },
      newText: { type: "string", description: "The text to put in its place" },
    },
    required: ["path", "oldText", "newText"],
  },
  async execute(args) {
    let content = await readFile(args.path, "utf8");
    let oldText: string = args.oldText;
    let newText: string = args.newText;

    // Windows files often end lines with "\r\n", but models write "\n".
    // Match the file's style so the search doesn't fail on invisible characters.
    if (content.includes("\r\n")) {
      oldText = oldText.replace(/\r?\n/g, "\r\n");
      newText = newText.replace(/\r?\n/g, "\r\n");
    }

    if (oldText === "") {
      return "Error: oldText is empty. To add text, include a nearby existing line in oldText and repeat it in newText.";
    }

    // The search text must point to exactly one place, so we never edit the wrong spot.
    const count = countOccurrences(content, oldText);
    if (count === 0) {
      return `Error: oldText was not found in ${args.path}. Read the file again and copy the text exactly, including indentation.`;
    }
    if (count > 1) {
      return `Error: oldText appears ${count} times in ${args.path}. Include more surrounding lines so it matches only one place.`;
    }

    // Cut out the old text and put the new text in its place.
    const start = content.indexOf(oldText);
    content = content.slice(0, start) + newText + content.slice(start + oldText.length);
    await writeFile(args.path, content, "utf8");

    const oldLines = oldText.split("\n").length;
    const newLines = newText.split("\n").length;
    return `Edited ${args.path}: replaced ${oldLines} line(s) with ${newLines} line(s).`;
  },
};
