import { expect, test } from "bun:test";

const main = new URL("../src/main.ts", import.meta.url).pathname;

const environment = () => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && name !== "LIQUID_API_KEY") env[name] = value;
  return env;
};

test("--help prints the usage, which names the key's variable", async () => {
  const run = Bun.spawn([process.execPath, main, "--help"], { env: environment(), stdout: "pipe", stderr: "pipe" });
  const out = await new Response(run.stdout).text();
  expect(await run.exited).toBe(0);
  expect(out).toContain("proofread-mcp mcp");
  expect(out).toContain("LIQUID_API_KEY");
});

test("with no key, the launcher still serves: it lists the tool, and a call fails with words that say there is no key", async () => {
  const run = Bun.spawn([process.execPath, main, "mcp"], { env: environment(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  run.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } })}\n`);
  run.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read", arguments: { text: "A sentence." }, _meta: meta } })}\n`,
  );
  await run.stdin.flush();
  const answers = new Map<number, Record<string, unknown>>();
  const reader = run.stdout.getReader();
  let buffered = "";
  while (answers.size < 2) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += new TextDecoder().decode(value);
    let end: number;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffered.slice(0, end)) as { id?: number };
      buffered = buffered.slice(end + 1);
      if (typeof message.id === "number") answers.set(message.id, message);
    }
  }
  run.stdin.end();
  run.kill();
  await run.exited;
  const listed = answers.get(1)?.result as { tools: { name: string }[] };
  expect(listed.tools.map((tool) => tool.name)).toEqual(["read"]);
  const called = answers.get(2)?.result as { content: { text: string }[]; isError?: boolean };
  expect(called.isError).toBe(true);
  expect(called.content[0]!.text).toContain("no key");
  expect(called.content[0]!.text).toContain("LIQUID_API_KEY");
});
