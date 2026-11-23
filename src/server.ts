import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";

import { fromJsonSchema, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { NotRead } from "./liquid.ts";
import { LINES, read, type Ask } from "./read.ts";

export const VERSION = "0.1.0";

export const DESCRIPTION =
  "Proofread a text as a first reader meets it. The tool splits the text into paragraphs and sentences, and Liquid AI's decision model d1.2-ultra reads each unit alone and gives it a figure for three troubles: unclear, choppy and tangled. The answer is a table with a row for every paragraph and, under it, a row for each of its sentences, the same shape in every run, so that you can see what a change moved. A `!` stands after a figure at or above its column's line: " +
  LINES +
  ". Its first line counts the units, the `!` in each column, and what it leaves out: the blocks of frontmatter and code, and the sentences that are only code; headings, tables and rules are left out too. Use it on a text that a person will read, such as a report, a design or a message to someone outside your team, before it goes. A chat message does not need it. A text that its writer finds clear is often hard for a person, and this tool is the second pair of eyes for that. So a mark on a sentence means that a person will have to work at it, also when the sentence looks clear to you. Write the sentence again and read it again, until the mark is gone. Leave a mark only for a reason that you can state: the unit is no sentence, such as a title, a label or code, or each rewording that you tried changes what it says. \"It is clear to me\" is no such reason. Every paragraph and sentence goes to Liquid AI, an outside service. Give exactly one of `text`, the text itself, and `path`, a file's absolute path, which the tool reads whole.";

const input = z.strictObject({
  text: z.string().optional().describe("The text itself."),
  path: z.string().optional().describe("A file's absolute path, read whole."),
});
const oneOf = z.union([z.strictObject({ text: z.string() }), z.strictObject({ path: z.string() })]);

const marks = z.strictObject({ unclear: z.number(), choppy: z.number(), tangled: z.number() });
const output = z.strictObject({
  paragraphs: z.number().describe("The paragraphs read."),
  sentences: z.number().describe("The sentences read."),
  unanswered: z.number().describe("The units with no figures, each row saying why."),
  marks: z
    .strictObject({ paragraphs: marks, sentences: marks })
    .describe("The `!` in each column, for paragraphs and for sentences."),
});

const schemaOf = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;

export type Asker = ((signal: AbortSignal) => Ask) | null;

const NO_KEY =
  "this server has no key for Liquid AI. Whoever runs the server can put one in the environment variable LIQUID_API_KEY of its process, and start it again. A key is made at console.liquid.ai, under API Keys. Until then, another call gets the same answer.";

const failed = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});
const refused = (text: string) => failed(`Nothing was read: ${text}`);

export function createProofreadServer(asker: Asker): McpServer {
  const server = new McpServer({ name: "proofread-mcp", version: VERSION });
  server.registerTool(
    "read",
    {
      description: DESCRIPTION,
      inputSchema: fromJsonSchema(schemaOf(input)),
      outputSchema: fromJsonSchema(schemaOf(output)),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args, context): Promise<CallToolResult> => {
      if (asker === null) return refused(NO_KEY);
      const given = oneOf.safeParse(args);
      if (!given.success)
        return refused(
          "give exactly one of `text`, the text itself, and `path`, a file's absolute path.",
        );
      let name = "text";
      let body: string;
      if ("text" in given.data) body = given.data.text;
      else {
        const { path } = given.data;
        if (!isAbsolute(path))
          return refused(`\`path\` must be a file's absolute path, and ${JSON.stringify(path)} isn't one.`);
        try {
          if (!(await stat(path)).isFile())
            return refused(`${path} isn't a regular file. Give a file's absolute path, or the text itself as \`text\`.`);
          body = await readFile(path, "utf8");
        } catch (error) {
          return refused(
            `${path} can't be read (${error instanceof Error ? error.message : String(error)}). Give a readable file's absolute path, or the text itself as \`text\`.`,
          );
        }
        name = basename(path);
      }
      const ended = new AbortController();
      const ask = asker(AbortSignal.any([context.mcpReq.signal, ended.signal]));
      let reading: Awaited<ReturnType<typeof read>>;
      try {
        reading = await read(name, body, ask);
      } catch (error) {
        if (error instanceof NotRead) return failed(error.message);
        throw error;
      } finally {
        ended.abort();
      }
      const units = reading.counts.paragraphs + reading.counts.sentences;
      return {
        content: [{ type: "text", text: reading.table }],
        structuredContent: reading.counts,
        ...(units > 0 && reading.counts.unanswered === units ? { isError: true } : {}),
      };
    },
  );
  return server;
}

export function serveProofread(
  asker: Asker,
  streams: { input?: Readable; output?: Writable } = {},
): void {
  const transport = new StdioServerTransport(streams.input ?? process.stdin, streams.output ?? process.stdout, {
    maxBufferSize: Number.POSITIVE_INFINITY,
  });
  serveStdio(() => createProofreadServer(asker), { legacy: "serve", transport });
}
