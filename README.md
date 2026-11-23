# proofread-mcp

An MCP server with one tool, `read`, which proofreads a text as a first reader meets it.

A writer knows what a text means, so the text often looks clear to its writer when a reader finds it hard. The tool is a second pair of eyes for that: it marks each paragraph and sentence that a reader will have to work at.

## What it does

The tool splits a Markdown text into paragraphs and sentences. Liquid AI's decision model `d1.2-ultra` reads each unit alone and answers three questions about it: is it clear what it means, is it choppy, and is it tangled. The answer is a table with a row for every paragraph and, under it, a row for each of its sentences. Each row has a figure from 0 to 1 for each of three troubles: unclear, choppy and tangled. Each column has a line, and a figure at or above it gets a `!`. The line for unclear is .50 for a paragraph and .70 for a sentence. The line for choppy is .50, and the line for tangled is .30.

For this text:

> The tool reads each unit alone. When a sentence, which a writer who knows what it means wrote in one breath while thinking of three other things, runs on like this one, a reader has to work at it.

the tool answered:

```text
text: 1 paragraph, 2 sentences. "!" in paragraphs: tangled 1; in sentences: tangled 1. d1.2-ultra, 431 ms.
       unclear  choppy  tangled
mean   .49      .18     .80      | the mean of the 1 paragraph
mean   .46      .27     .48      | the mean of the 2 sentences
¶1     .49      .18     .80!     | The tool reads each unit alone. When a sentence, which a writer who knows what …
  1.1  .45      .41     .06      | The tool reads each unit alone.
  1.2  .46      .14     .91!     | When a sentence, which a writer who knows what it means wrote in one breath whi…
"!" is a figure at or above its column's line: unclear .50 for a paragraph and .70 for a sentence, choppy .50, tangled .30. Each unit is read alone. A figure moves a little between runs.
```

The table's first line counts the units and the `!` in each column. Some parts of a text get no row: frontmatter, fenced, indented and details blocks, headings, tables, rules, and a line that is only a link. A sentence that is only code gets no row either. A paragraph with other sentences still gets a row, and its text keeps the code. The first line names the frontmatter, the blocks and the sentences of code that it left out. The table has the same shape in every run, so that you can see what a change moved. A figure moves a little between runs.

## What leaves your machine

Every paragraph and sentence of the text goes to Liquid AI, an outside service, in a request of its own. An HTML comment is read as a paragraph, so it goes too.

A call can give the path of a file in place of the text. Three things are true of such a call.

- The server reads any file that its process can read, whoever calls it.
- It sends that file's text to Liquid AI.
- The table shows each paragraph and each sentence, cut at 80 characters. So the caller gets parts of the file back. An agent may have fewer rights than the server, and such an agent can still read a file in this way.

Run the server with the rights of the agent that calls it.

## A key, and what a read costs

The server needs a key for Liquid AI's API. To get one, go to `console.liquid.ai`, register and join an organization, then go to Dashboard > API Keys, and create a key. Liquid AI's page for the model says how: https://docs.liquid.ai/lfm/models/d1

`d1.2-ultra` costs $0.042 for each million input tokens, and output is free. Each request pays for its unit's text once, and each of the three questions adds its own tokens. A unit can be sent more than once: a request that fails can be tried again, and a unit with no figures is asked once more. So a read can pay for some units more than once. Liquid AI's pricing page has the current prices.

## Install

The server runs on [Bun](https://bun.sh) 1.4 or newer. Clone this repository, and run `bun install` in it.

## Add it to an MCP client

The server speaks MCP over stdio. A client starts it with the command `bun /path/to/proofread-mcp/src/main.ts mcp`, and gives it the key in the environment variable `LIQUID_API_KEY`. Many clients take a configuration of this form:

```json
{
  "mcpServers": {
    "proofread": {
      "command": "bun",
      "args": ["/path/to/proofread-mcp/src/main.ts", "mcp"],
      "env": { "LIQUID_API_KEY": "your key" }
    }
  }
}
```

Without a key, the server still starts and lists its tool. Each call then gets an answer. The answer says that the server has no key, and it says where to put one.

## The tool

`read` takes exactly one of two arguments:

- `text`: the text itself.
- `path`: a regular file's absolute path. The server reads the file whole.

It answers with the table as text. Its structured content has these counts:

- `paragraphs` and `sentences`: the units that it read.
- `unanswered`: the units with no figures. Each of these units has a row that says why.
- `marks`: the `!` in each column, for paragraphs and for sentences.

Liquid AI's answers state a rate limit for the key, and the server sends its requests no faster than that limit. At 100 requests a second, a text of 551 units took about 6 s.

Some failures stop the whole read: Liquid AI refuses the key, refuses for the account's credits, or doesn't answer. A request waits at most 10 s for its answer, and a request with no answer is tried three times. The call then fails. Its answer says what Liquid AI answered, what can be done, and who can do it. Other failures belong to one unit. The row of that unit says why, and the other rows keep their figures. A unit that is too long for the model is one example. The first paragraph and the first sentence of the text are an exception. The request for each of them also carries the questions. If Liquid AI refuses either of them, the whole call fails, since the refusal may be about the questions.

## Development

`bun run check` runs the typecheck and the tests. The tests use stand-ins for Liquid AI, and they send nothing.

## A snapshot

This repository is a snapshot, taken on 23 November 2026.
