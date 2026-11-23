import { expect, test } from "bun:test";

import type { DecisionOutcome } from "../src/liquid.ts";
import { QUESTIONS, read, sentencesOf, units, type Ask } from "../src/read.ts";

const flat = (md: string) => units(md).paragraphs.map((p) => p.sentences);

test("a sentence ends at . ? ! or … before a word of any case, a digit, a quote, a bracket or an emphasis mark", () => {
  expect(
    sentencesOf("she asked. 320 sentences took 6.4 s. *Then* it ended! (Done.) [x] too?"),
  ).toEqual(["she asked.", "320 sentences took 6.4 s.", "*Then* it ended!", "(Done.)", "[x] too?"]);
});

test("no end after a common abbreviation, inside a pair of quotes or backticks, at an ellipsis before a lowercase word, or at a quoted end before a lowercase word", () => {
  expect(
    sentencesOf("Versions, e.g. 1.2, i.e. numbers, etc. are fine vs. names, cf. the list."),
  ).toEqual(["Versions, e.g. 1.2, i.e. numbers, etc. are fine vs. names, cf. the list."]);
  expect(
    sentencesOf(
      'It said "Stop. go on." and `a. b` here. Yes... and on. "A whole one." she said. Next.',
    ),
  ).toEqual([
    'It said "Stop. go on." and `a. b` here.',
    "Yes... and on.",
    '"A whole one." she said.',
    "Next.",
  ]);
  expect(sentencesOf('An unpaired " mark. still one? No: Two.')).toEqual([
    'An unpaired " mark.',
    "still one?",
    "No: Two.",
  ]);
});

test("in a list, an item of two or more sentences starts a paragraph unless the paragraph before has one sentence only, and an item of one sentence stays in the paragraph before", () => {
  expect(
    flat("- Item one. Item two.\n- Item three.\n- Item four.\n- Item five. Item six.\n- Item seven."),
  ).toEqual([
    ["Item one.", "Item two.", "Item three.", "Item four."],
    ["Item five.", "Item six.", "Item seven."],
  ]);
  expect(
    flat("- Lone item here.\n- Item two here. With more.\n- Item three here. And more."),
  ).toEqual([
    ["Lone item here.", "Item two here.", "With more."],
    ["Item three here.", "And more."],
  ]);
  expect(flat("Intro line.\n- a item.\n- b item.")).toEqual([["Intro line."], ["a item.", "b item."]]);
});

test("a sentence of one word joins the sentence after it with a colon, in bold or not, at a line's start or inside it; bold marks change no split", () => {
  expect(
    flat(
      "**Family.** A session and its forks.\n\n- **FD1.** An ended family moves.\n\n**Why:** because.\n\nIt ended. **Quiet.** Then on. Yes. I do.",
    ),
  ).toEqual([
    ["Family: A session and its forks."],
    ["FD1: An ended family moves."],
    ["Why: because."],
    ["It ended.", "Quiet: Then on.", "Yes: I do."],
  ]);
  expect(
    flat(
      "**Yes, in two ways. They differ.** A wry note: x.\n\n**FD1. A family moves whole.** When a move runs.\n\nOne word at the end. Done.",
    ),
  ).toEqual([
    ["Yes, in two ways.", "They differ.", "A wry note: x."],
    ["FD1: A family moves whole.", "When a move runs."],
    ["One word at the end.", "Done."],
  ]);
});

test("a line is a heading only when it is one bold run and nothing else that does not end as a sentence does", () => {
  expect(
    flat(
      "**Credits**\n\n<ins>**Credits**</ins>\n\n**What I did:**\n\n**The tool runs. Anyone can call it now.**\n\n**Start bold** and then plain and **end bold**",
    ),
  ).toEqual([
    ["The tool runs.", "Anyone can call it now."],
    ["Start bold and then plain and end bold"],
  ]);
});

test("a paragraph that ends with a colon joins the paragraph after it", () => {
  expect(flat("What it showed:\n\n- One item here.\n- Two items here.\n\nThen a plain one.")).toEqual(
    [["What it showed:", "One item here.", "Two items here."], ["Then a plain one."]],
  );
});

test("left out: frontmatter, fenced, indented and details blocks, headings of both kinds, tables, rules and a line that is only a URL; each block is counted", () => {
  const md = [
    "---",
    "title: x",
    "refs:",
    "  - a",
    "---",
    "Setext",
    "======",
    "",
    "Kept one.",
    "",
    "```",
    "code. Here.",
    "```",
    "",
    "    indented. code.",
    "",
    "<details>",
    "<summary>For agents</summary>",
    "",
    "Inside. Gone.",
    "",
    "</details>",
    "",
    "| a | b |",
    "|---|---|",
    "",
    "***",
    "",
    "https://example.com/x",
    "",
    "# Heading",
    "",
    "Kept two.",
  ].join("\n");
  const got = units(md);
  expect(got.paragraphs.map((p) => p.sentences)).toEqual([["Kept one."], ["Kept two."]]);
  expect(got.left).toEqual({ frontmatter: 1, fenced: 1, indented: 1, details: 1, code: 0 });
});

test("a sentence that is only code, its code spans with nothing but spaces and punctuation, gets no row and is counted; a sentence with code and words keeps its row; a paragraph left with no sentence gets no row", () => {
  const md = [
    "The handle closes once. `close(): void`. Then `open()` starts it again.",
    "",
    "`read(path: string): Buffer`.",
    "`write(path, data): void`;",
    "",
    "- `stop(): void`.",
    "- The list keeps `start()` here.",
  ].join("\n");
  const got = units(md);
  expect(got.paragraphs).toEqual([
    {
      text: "The handle closes once. `close(): void`. Then `open()` starts it again.",
      sentences: ["The handle closes once.", "Then `open()` starts it again."],
    },
    {
      text: "`stop(): void`.\nThe list keeps `start()` here.",
      sentences: ["The list keeps `start()` here."],
    },
  ]);
  expect(got.left.code).toBe(4);
});

test("leaving out a sentence of code alone changes no paragraph: one after a paragraph that ends with a colon still joins it, and the paragraph after both stays its own", () => {
  const got = units("The call is:\n\n`read(path): Buffer`.\n\nIt returns the file.");
  expect(got.paragraphs).toEqual([
    { text: "The call is:\n`read(path): Buffer`.", sentences: ["The call is:"] },
    { text: "It returns the file.", sentences: ["It returns the file."] },
  ]);
  expect(got.left.code).toBe(1);
});

test("the first line counts the sentences of code alone that it left out, and a text of nothing else has no paragraph to read", async () => {
  const ask: Ask = async (states) => states.map(() => answer(0.9, 0.1, 0.1));
  const got = await read("spec.md", "It returns a buffer. `read(): Buffer`.", ask);
  expect(got.table.split("\n")[0]).toMatch(
    /^spec\.md: 1 paragraph, 1 sentence\. "!" in paragraphs: none; in sentences: none\. Left out: 1 sentence of code alone\. d1\.2-ultra, \d+ ms\.$/,
  );
  const none = await read("sigs.md", "`a(): void`.\n\n`b(): void`.", ask);
  expect(none.table).toBe("sigs.md: no paragraph to read. Left out: 2 sentences of code alone.");
});

test("a first line --- that is a rule keeps the text after it", () => {
  const got = units("---\nA paragraph after a rule.\n\n---\nAnother one.");
  expect(got.paragraphs.map((p) => p.sentences)).toEqual([
    ["A paragraph after a rule."],
    ["Another one."],
  ]);
  expect(got.left.frontmatter).toBe(0);
});

test("markers and markup go, code spans stay whole: quotes, tasks, images, links, tags with a space, ** outside backticks, footnote marks", () => {
  expect(
    flat(
      "> It is quoted. It has two.\n\n- [ ] open task.\n- [x] done task.\n\nAn ![alt text](a.png) and [a link](http://x) and inline HTML<br>here, `**kept** <b>`, **bold**.[^1]",
    ),
  ).toEqual([
    ["It is quoted.", "It has two."],
    ["open task.", "done task."],
    ["An alt text and a link and inline HTML here, `**kept** <b>`, bold."],
  ]);
});

const answer = (clear: number, choppy: number, tangled: number): DecisionOutcome => ({
  answers: {
    clear: { type: "noul", noul: clear },
    choppy: { type: "noul", noul: choppy },
    tangled: { type: "noul", noul: tangled },
  },
});

test("each paragraph and each of its sentences has a row of three figures, a `!` stands at or above a column's line as printed and never on a mean, and the first and last lines count and explain them", async () => {
  const asked: { states: readonly string[]; questions: unknown }[] = [];
  const ask: Ask = async (states, questions) => {
    asked.push({ states, questions });
    return states.map((state) =>
      state === "A one. A two."
        ? answer(0.5, 0.5, 0.29)
        : state === "A one."
          ? answer(0.296, 0.495, 0.3)
          : answer(0.9, 0.1, 0.1),
    );
  };
  const got = await read("draft.md", "A one. A two.\n\n```\nleft out\n```\n", ask);
  expect(asked.map((each) => each.questions)).toEqual([QUESTIONS.paragraph, QUESTIONS.sentence]);
  expect(asked.map((each) => each.states)).toEqual([["A one. A two."], ["A one.", "A two."]]);
  const lines = got.table.split("\n");
  expect(lines[0]).toMatch(
    /^draft\.md: 1 paragraph, 2 sentences\. "!" in paragraphs: unclear 1, choppy 1; in sentences: unclear 1, tangled 1\. Left out: 1 fenced block\. d1\.2-ultra, \d+ ms\.$/,
  );
  expect(lines.slice(1, -1)).toEqual([
    "       unclear  choppy  tangled",
    "mean   .50      .50     .29      | the mean of the 1 paragraph",
    "mean   .40      .30     .20      | the mean of the 2 sentences",
    "¶1     .50!     .50!    .29      | A one. A two.",
    "  1.1  .70!     .49     .30!     | A one.",
    "  1.2  .10      .10     .10      | A two.",
  ]);
  expect(lines.at(-1)).toBe(
    `"!" is a figure at or above its column's line: unclear .50 for a paragraph and .70 for a sentence, choppy .50, tangled .30. Each unit is read alone. A figure moves a little between runs.`,
  );
  expect(got.counts).toEqual({
    paragraphs: 1,
    sentences: 2,
    unanswered: 0,
    marks: {
      paragraphs: { unclear: 1, choppy: 1, tangled: 0 },
      sentences: { unclear: 1, choppy: 0, tangled: 1 },
    },
  });
});

test("a sentence's line for unclear is .70 and a paragraph's stays .50: a sentence at .69 has no `!` for unclear, one at .70 has one, and a paragraph at .50 has one", async () => {
  const ask: Ask = async (states) =>
    states.map((state) =>
      state === "B one. B two." ? answer(0.5, 0.1, 0.1) : state === "B one." ? answer(0.31, 0.1, 0.1) : answer(0.3, 0.1, 0.1),
    );
  const got = await read("lines.md", "B one. B two.", ask);
  const rows = got.table.split("\n").filter((line) => line.includes("| B"));
  expect(rows).toEqual([
    "¶1     .50!     .10     .10      | B one. B two.",
    "  1.1  .69      .10     .10      | B one.",
    "  1.2  .70!     .10     .10      | B two.",
  ]);
  expect(got.counts.marks).toEqual({
    paragraphs: { unclear: 1, choppy: 0, tangled: 0 },
    sentences: { unclear: 1, choppy: 0, tangled: 0 },
  });
});

test("a unit with no answer is asked once more, and one still without has a row that says why, with no figure, counted on the first line", async () => {
  const asked: (readonly string[])[] = [];
  let tries = 0;
  const ask: Ask = async (states) => {
    asked.push(states);
    return states.map((state) => {
      if (state === "Comes back.")
        return ++tries === 1 ? { error: { status: 429, message: "busy" } } : answer(1, 0, 0);
      if (state === "Never answers.") return { error: { status: 422, message: "too long" } };
      return { answers: { clear: { noul: 1 } } };
    });
  };
  const got = await read("text", "Comes back. Never answers.", ask);
  expect(asked).toEqual([
    ["Comes back. Never answers."],
    ["Comes back.", "Never answers."],
    ["Comes back. Never answers."],
    ["Comes back.", "Never answers."],
  ]);
  const rows = got.table.split("\n");
  expect(rows[0]).toStartWith("text: 1 paragraph, 2 sentences, 2 with no answer.");
  expect(rows).toContain("¶1     no answer (no figure for choppy)  | Comes back. Never answers.");
  expect(rows).toContain("  1.1  .00      .00     .00      | Comes back.");
  expect(rows).toContain("  1.2  no answer (422: too long)  | Never answers.");
  expect(got.counts.unanswered).toBe(2);
});

test("a figure outside 0 to 1 is no figure, so its unit has a row saying which, and is asked once more", async () => {
  let asked = 0;
  const ask: Ask = async (states) => {
    asked++;
    return states.map(() => answer(1.2, 0.1, 0.1));
  };
  const got = await read("text", "It reads well.", ask);
  expect(asked).toBe(4);
  expect(got.table).toContain("¶1     no answer (no figure for clear)  | It reads well.");
  expect(got.counts.unanswered).toBe(2);
});
