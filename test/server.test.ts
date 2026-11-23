import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { NotRead, type DecisionOutcome } from "../src/liquid.ts";
import { LINES, QUESTIONS, type Ask } from "../src/read.ts";
import { serveProofread, type Asker } from "../src/server.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

type Result = {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
type Listed = {
  tools: {
    name: string;
    description: string;
    inputSchema: { properties: Record<string, { description?: string }> };
    outputSchema: { properties: Record<string, unknown> };
  }[];
};

const noul = (value: number) => ({ type: "noul", noul: value });
const figures = (): DecisionOutcome => ({ answers: { clear: noul(0.9), choppy: noul(0.1), tangled: noul(0.1) } });

function serve(asker: Asker) {
  const input = new PassThrough();
  const output = new PassThrough();
  cleanup.push(() => {
    input.end();
    output.end();
  });
  serveProofread(asker, { input, output });
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    let end: number;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffered.slice(0, end)) as Record<string, unknown>;
      buffered = buffered.slice(end + 1);
      if (typeof message.id === "number") pending.get(message.id)?.(message);
    }
  });
  let ids = 0;
  const request = (method: string, params: Record<string, unknown>, id = ++ids) => {
    return new Promise<Record<string, unknown>>((resolve) => {
      pending.set(id, resolve);
      input.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        })}\n`,
      );
    });
  };
  const list = async () => (await request("tools/list", {})).result as Listed;
  const call = async (args: Record<string, unknown>) =>
    (await request("tools/call", { name: "read", arguments: args })).result as Result;
  const start = (args: Record<string, unknown>) => {
    const id = ++ids;
    void request("tools/call", { name: "read", arguments: args }, id);
    return id;
  };
  const cancel = (id: number) =>
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "The person moved on." } })}\n`);
  return { list, call, start, cancel };
}

function asking(answer: (states: readonly string[], signal: AbortSignal) => Promise<DecisionOutcome[]> = async (states) => states.map(figures)) {
  const asked: { states: readonly string[]; questions: unknown }[] = [];
  const signals: AbortSignal[] = [];
  const asker: Asker = (signal) => {
    signals.push(signal);
    const ask: Ask = (states, questions) => {
      asked.push({ states, questions });
      return answer(states, signal);
    };
    return ask;
  };
  return { asker, asked, signals };
}

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "proofread-mcp-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("the server lists one tool, read, which takes text or path, and whose description says what the tool does, holds the lines, and says that every unit goes to Liquid AI", async () => {
  const { list } = serve(asking().asker);
  const listed = await list();
  expect(listed.tools.map((tool) => tool.name)).toEqual(["read"]);
  const [tool] = listed.tools;
  expect(Object.keys(tool!.inputSchema.properties).toSorted()).toEqual(["path", "text"]);
  expect(Object.keys(tool!.outputSchema.properties).toSorted()).toEqual(["marks", "paragraphs", "sentences", "unanswered"]);
  expect(tool!.description).toStartWith("Proofread a text as a first reader meets it.");
  expect(tool!.description).toContain(LINES);
  expect(tool!.description).toContain("Every paragraph and sentence goes to Liquid AI, an outside service.");
  expect(tool!.description).toContain(
    "Use it on a text that a person will read, such as a report, a design or a message to someone outside your team, before it goes.",
  );
});

test("a call with text sends each paragraph and each sentence to the asker, and answers with the table and the counts", async () => {
  const tangled = (): DecisionOutcome => ({ answers: { clear: noul(0.9), choppy: noul(0.1), tangled: noul(0.9) } });
  const a = asking(async (states) => states.map((state) => (state === "The second one." ? tangled() : figures())));
  const { call } = serve(a.asker);
  const result = await call({ text: "The first one. The second one.\n\nA paragraph of its own." });
  expect(result.isError).toBeUndefined();
  expect(a.asked.map((one) => one.states).toSorted((x, y) => x.length - y.length)).toEqual([
    ["The first one. The second one.", "A paragraph of its own."],
    ["The first one.", "The second one.", "A paragraph of its own."],
  ]);
  expect(a.asked.map((one) => one.questions)).toContain(QUESTIONS.paragraph);
  expect(a.asked.map((one) => one.questions)).toContain(QUESTIONS.sentence);
  const rows = result.content[0]!.text.split("\n");
  expect(rows[0]).toStartWith("text: 2 paragraphs, 3 sentences.");
  const row = (label: string) => rows.find((each) => each.trimStart().startsWith(`${label} `));
  expect(row("¶1")).toContain("| The first one. The second one.");
  expect(row("1.1")).toContain("| The first one.");
  expect(row("1.2")).toContain(".90!");
  expect(row("1.2")).toContain("| The second one.");
  expect(row("¶2")).toContain("| A paragraph of its own.");
  expect(row("2.1")).toContain("| A paragraph of its own.");
  expect(result.structuredContent).toEqual({
    paragraphs: 2,
    sentences: 3,
    unanswered: 0,
    marks: { paragraphs: { unclear: 0, choppy: 0, tangled: 0 }, sentences: { unclear: 0, choppy: 0, tangled: 1 } },
  });
});

test("a call with an absolute path reads the file whole and names it on the table's first line; a relative path, a file that can't be read, both arguments and neither are refused, and nothing is asked", async () => {
  const dir = await scratch();
  const file = join(dir, "notes.md");
  await writeFile(file, "A sentence in a file.\n\nThe file's last paragraph.\n");
  const fifo = join(dir, "fifo");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  await mkdir(join(dir, "folder"));
  const a = asking();
  const { call } = serve(a.asker);
  const read = await call({ path: file });
  expect(read.isError).toBeUndefined();
  expect(read.content[0]!.text).toStartWith("notes.md: 2 paragraphs, 2 sentences.");
  expect(a.asked.flatMap((one) => one.states)).toContain("A sentence in a file.");
  expect(a.asked.flatMap((one) => one.states)).toContain("The file's last paragraph.");
  const before = a.asked.length;
  for (const [args, why] of [
    [{ path: "notes.md" }, "must be a file's absolute path"],
    [{ path: join(dir, "missing.md") }, "can't be read"],
    [{ path: fifo }, "isn't a regular file"],
    [{ path: join(dir, "folder") }, "isn't a regular file"],
    [{ text: "A.", path: file }, "exactly one"],
    [{}, "exactly one"],
  ] as const) {
    const refused = await call(args);
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toStartWith("Nothing was read:");
    expect(refused.content[0]!.text).toContain(why);
  }
  expect(a.asked.length).toBe(before);
});

test("when the asker fails for the whole call, the call fails once with the asker's words, and the requests still open are aborted", async () => {
  const words = "Nothing was read: Liquid AI refused the key (401: Invalid API key.).";
  const a = asking(
    (states, signal) =>
      states.length === 1
        ? Promise.reject(new NotRead(words))
        : new Promise<DecisionOutcome[]>((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
  );
  const { call } = serve(a.asker);
  const result = await call({ text: "One sentence here. And a second one." });
  expect(result.isError).toBe(true);
  expect(result.content.map((c) => c.text)).toEqual([words]);
  expect(a.signals).toHaveLength(1);
  expect(a.signals[0]!.aborted).toBe(true);
});

test("however a reading ends, the requests that the call still has open are aborted, also when the asker fails with another error", async () => {
  const a = asking((states, signal) =>
    states.length === 1
      ? Promise.reject(new Error("Something else broke."))
      : new Promise<DecisionOutcome[]>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
  );
  const { call } = serve(a.asker);
  const result = await call({ text: "One sentence here. And a second one." });
  expect(result.isError).toBe(true);
  expect(a.asked).toHaveLength(2);
  expect(a.signals[0]!.aborted).toBe(true);
});

test("a call that its client cancels aborts its open requests", async () => {
  let entered!: () => void;
  const asked = new Promise<void>((resolve) => (entered = resolve));
  const a = asking((_states, signal) => {
    entered();
    return new Promise<DecisionOutcome[]>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const { start, cancel } = serve(a.asker);
  const id = start({ text: "A sentence that waits." });
  await asked;
  expect(a.signals[0]!.aborted).toBe(false);
  cancel(id);
  await new Promise<void>((resolve) => a.signals[0]!.addEventListener("abort", () => resolve(), { once: true }));
  expect(a.signals[0]!.aborted).toBe(true);
});

test("when no unit has figures, the call answers with its table as an error, with the counts", async () => {
  const a = asking(async (states) => states.map(() => ({ error: { status: 429, message: "Slow down." } })));
  const { call } = serve(a.asker);
  const result = await call({ text: "One sentence here. And a second one." });
  expect(result.isError).toBe(true);
  const rows = result.content[0]!.text.split("\n");
  expect(rows[0]).toStartWith("text: 1 paragraph, 2 sentences, 3 with no answer.");
  expect(rows.filter((row) => row.includes("429") && row.includes("Slow down."))).toHaveLength(3);
  expect(result.structuredContent).toMatchObject({ paragraphs: 1, sentences: 2, unanswered: 3 });
});

test("a text with no paragraph gets its table, and the asker isn't called", async () => {
  const a = asking();
  const { call } = serve(a.asker);
  const result = await call({ text: "# A heading\n\n```\ncode\n```\n" });
  expect(result.isError).toBeUndefined();
  expect(result.content[0]!.text).toBe("text: no paragraph to read. Left out: 1 fenced block.");
  expect(a.asked).toEqual([]);
});

test("a server with no key lists its tool, and each call fails with words that say it has no key and where to put one", async () => {
  const { list, call } = serve(null);
  expect((await list()).tools.map((tool) => tool.name)).toEqual(["read"]);
  for (const args of [{ text: "A sentence." }, {}, { text: "A.", path: "/a/file.md" }]) {
    const result = await call(args);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toStartWith("Nothing was read: this server has no key for Liquid AI.");
    expect(result.content[0]!.text).toContain("LIQUID_API_KEY");
    expect(result.content[0]!.text).toContain("Whoever runs the server");
  }
});
