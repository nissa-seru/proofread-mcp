#!/usr/bin/env bun
import { liquidAsker } from "./liquid.ts";
import { serveProofread, VERSION } from "./server.ts";

const usage = `proofread-mcp ${VERSION}: proofread a text with Liquid AI's decision model, as an MCP server over stdio.

  proofread-mcp mcp
      Serve over stdin and stdout. The key for Liquid AI comes from the environment variable
      LIQUID_API_KEY. With no key, the server still starts, and each call answers that it has none.
  proofread-mcp --help`;

function fail(message: string, code = 1): never {
  process.stderr.write(`proofread-mcp: ${message}\n`);
  process.exit(code);
}

const [command, ...rest] = process.argv.slice(2);
if (command === undefined || command === "--help" || command === "-h") {
  console.log(usage);
} else if (command !== "mcp") {
  fail(`unknown command ${JSON.stringify(command)}\n\n${usage}`, 2);
} else if (rest.length) {
  fail(`unknown option ${JSON.stringify(rest[0])}\n\n${usage}`, 2);
} else {
  const key = process.env.LIQUID_API_KEY?.trim();
  serveProofread(key ? liquidAsker({ key }) : null);
}
