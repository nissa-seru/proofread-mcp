import { z } from "zod";

import type { DecisionOutcome } from "./liquid.ts";

export const MODEL = "d1.2-ultra";

const NOUL_CHOPPY = {
  true: "It is a run of short pieces or fragments that do not connect.",
  false: "Its parts have a natural length and connect.",
};
const NOUL_TANGLED = {
  true: "Its parts are nested or wound together, so a reader has to work out which part goes with which.",
  false: "Its parts follow one after another in a clear order.",
};

/** The three questions, asked of each unit alone. */
export const QUESTIONS = {
  sentence: {
    clear: { type: "noul", instructions: "Is it clear what this sentence means?" },
    choppy: { type: "noul", instructions: "Is this sentence choppy?", criteria: NOUL_CHOPPY },
    tangled: { type: "noul", instructions: "Is this sentence tangled?", criteria: NOUL_TANGLED },
  },
  paragraph: {
    clear: { type: "noul", instructions: "Is it clear what this paragraph means?" },
    choppy: { type: "noul", instructions: "Is this paragraph choppy?", criteria: NOUL_CHOPPY },
    tangled: { type: "noul", instructions: "Is this paragraph tangled?", criteria: NOUL_TANGLED },
  },
} as const;

type Answers = { clear: number; choppy: number; tangled: number };

type Kind = "paragraph" | "sentence";

const COLUMNS = [
  { key: "unclear", line: { paragraph: 50, sentence: 70 }, of: (a: Answers) => 1 - a.clear },
  { key: "choppy", line: { paragraph: 50, sentence: 50 }, of: (a: Answers) => a.choppy },
  { key: "tangled", line: { paragraph: 30, sentence: 30 }, of: (a: Answers) => a.tangled },
] as const;
type Column = (typeof COLUMNS)[number];
export type Marks = Record<Column["key"], number>;

const figure = (value: number) => value.toFixed(2).replace(/^0/, "");
const over = (column: Column, kind: Kind, value: number) =>
  Math.round(Number(figure(value)) * 100) >= column.line[kind];

const ITEM = /^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/;
const QUOTE = /^\s*(>\s?)+/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const SETEXT = /^\s{0,3}(=+|-+)\s*$/;
const RULE = /^\s{0,3}((-\s*){3,}|(\*\s*){3,}|(_\s*){3,})$/;
const HEADING = /^\s{0,3}#{1,6}(\s|$)/;
const TABLE = /^\s*\|/;
const URL_ONLY = /^\s*<?https?:\/\/\S+>?\s*$/;
const INDENTED = /^( {4,}|\t)/;
const ABBREVIATIONS = new Set(["e.g.", "i.e.", "etc.", "vs.", "cf."]);

const point = (line: number) => `.${String(line).padStart(2, "0")}`;
export const LINES = COLUMNS.map(({ key, line }) =>
  line.paragraph === line.sentence
    ? `${key} ${point(line.paragraph)}`
    : `${key} ${point(line.paragraph)} for a paragraph and ${point(line.sentence)} for a sentence`,
).join(", ");

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

function outsideCode(text: string, change: (part: string) => string): string {
  const parts = text.split(/(`[^`]*`)/);
  return parts.map((part, i) => (i % 2 === 1 ? part : change(part))).join("");
}

const onlyCode = (sentence: string) =>
  /`[^`]*`/.test(sentence) && /^[\s\p{P}]*$/u.test(sentence.replace(/`[^`]*`/g, ""));

const untagged = (text: string) =>
  outsideCode(text, (part) => part.replace(/<\/?[A-Za-z][^>]*>/g, " "));

const onlyBold = (line: string) => {
  const bare = untagged(line).trim();
  const bold = /^\*\*([^*]+)\*\*:?$/.exec(bare) ?? /^__([^_]+)__:?$/.exec(bare);
  return bold !== null && !/[.?!]["'”’)\]]*$/.test(bold[1]!.trim());
};

function clean(line: string): string {
  const text = untagged(line.replace(QUOTE, "").replace(ITEM, "")).trim();
  return outsideCode(text, (part) =>
    part
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\[\^[^\]]+\]:?/g, "")
      .replace(/\*\*|__/g, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function paired(text: string): boolean[] {
  const inside = new Array<boolean>(text.length + 1).fill(false);
  const pairs = (open: string, close: string) => {
    let start = -1;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (start < 0 && open === c) start = i;
      else if (start >= 0 && close === c) {
        for (let k = start + 1; k < i; k++) inside[k] = true;
        start = -1;
      }
    }
  };
  pairs('"', '"');
  pairs("“", "”");
  pairs("`", "`");
  return inside;
}

export function sentencesOf(text: string): string[] {
  const inside = paired(text);
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (!".?!…".includes(text[i]!)) continue;
    let end = i + 1;
    while (end < text.length && `"'”’)]`.includes(text[end]!)) end++;
    if (end >= text.length || !/\s/.test(text[end]!) || inside[end]) continue;
    let next = end;
    while (next < text.length && /\s/.test(text[next]!)) next++;
    if (next >= text.length || !/[\p{L}\p{N}`"'“‘(\[*_]/u.test(text[next]!)) continue;
    const lower = /\p{Ll}/u.test(text[next]!);
    const word = text.slice(0, i + 1).split(/\s/).pop()!.toLowerCase();
    if (text[i] === "." && ABBREVIATIONS.has(word.replace(/^[("'“‘[]+/, ""))) continue;
    if (lower && (text[i] === "…" || text.slice(i - 2, i + 1) === "...")) continue;
    if (lower && end > i + 1 && `"'”’`.includes(text[end - 1]!)) continue;
    out.push(text.slice(from, end).trim());
    from = next;
    i = next - 1;
  }
  const rest = text.slice(from).trim();
  if (rest) out.push(rest);
  const joined: string[] = [];
  for (const sentence of out.filter((s) => s.length > 0)) {
    const last = joined.at(-1);
    if (last !== undefined && !/\s/.test(last) && /[.?!…]$/.test(last))
      joined[joined.length - 1] = `${last.replace(/[.?!…]+$/, "")}: ${sentence}`;
    else joined.push(sentence);
  }
  return joined;
}

function frontmatterEnd(lines: string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (close < 0) return 0;
  const yaml = lines
    .slice(1, close)
    .every((line) => !line.trim() || /^[A-Za-z0-9_.-]+:(\s|$)/.test(line) || /^(\s|- )/.test(line));
  return yaml ? close + 1 : 0;
}

export interface Paragraph {
  text: string;
  sentences: string[];
}
export interface Left {
  frontmatter: number;
  fenced: number;
  indented: number;
  details: number;
  code: number;
}

export function units(source: string): { paragraphs: Paragraph[]; left: Left } {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const left: Left = { frontmatter: 0, fenced: 0, indented: 0, details: 0, code: 0 };
  let at = frontmatterEnd(lines);
  if (at > 0) left.frontmatter = 1;
  const blocks: string[][] = [];
  let block: string[] = [];
  let afterBlank = true;
  let lastWasList = false;
  const end = () => {
    if (block.length) {
      blocks.push(block);
      lastWasList = block.some((line) => ITEM.test(line.replace(QUOTE, "")));
    }
    block = [];
  };
  while (at < lines.length) {
    const raw = lines[at]!;
    const line = raw.trim();
    if (!line) {
      end();
      afterBlank = true;
      at++;
      continue;
    }
    if (/^<details\b/i.test(line)) {
      end();
      left.details++;
      while (at < lines.length && !/<\/details>/i.test(lines[at]!)) at++;
      at++;
      afterBlank = false;
      continue;
    }
    const fence = FENCE.exec(raw);
    if (fence) {
      end();
      left.fenced++;
      at++;
      while (at < lines.length && !lines[at]!.trim().startsWith(fence[1]!)) at++;
      at++;
      afterBlank = false;
      continue;
    }
    if (afterBlank && block.length === 0 && !lastWasList && INDENTED.test(raw)) {
      left.indented++;
      while (at < lines.length && (INDENTED.test(lines[at]!) || !lines[at]!.trim())) at++;
      afterBlank = true;
      continue;
    }
    afterBlank = false;
    if (block.length > 0 && SETEXT.test(raw) && !ITEM.test(raw)) {
      block = [];
      at++;
      continue;
    }
    if (
      RULE.test(raw) ||
      HEADING.test(raw) ||
      TABLE.test(raw) ||
      URL_ONLY.test(raw) ||
      onlyBold(raw.replace(QUOTE, ""))
    ) {
      end();
      at++;
      continue;
    }
    block.push(raw);
    at++;
  }
  end();
  const paragraphs: (Paragraph & { items?: string[] })[] = [];
  for (const raw of blocks) {
    const lines = raw.map((line) => line.replace(QUOTE, ""));
    const lead: string[] = [];
    const items: string[] = [];
    for (const line of lines) {
      if (ITEM.test(line)) items.push(clean(line));
      else if (items.length) items[items.length - 1] += ` ${clean(line)}`;
      else lead.push(clean(line));
    }
    if (lead.length) {
      const text = lead.join(" ");
      paragraphs.push({ text, sentences: sentencesOf(text) });
    }
    let current: { text: string; items: string[]; sentences: string[] } | null = null;
    for (const item of items) {
      const sentences = sentencesOf(item);
      if (sentences.length === 0) continue;
      if (current === null || (sentences.length >= 2 && current.sentences.length >= 2)) {
        current = { text: "", items: [item], sentences: [...sentences] };
        paragraphs.push(current);
      } else {
        current.items.push(item);
        current.sentences.push(...sentences);
      }
    }
  }
  const joined: Paragraph[] = [];
  for (const p of paragraphs) {
    const paragraph = p.items ? { text: p.items.join("\n"), sentences: p.sentences } : p;
    if (paragraph.sentences.length === 0) continue;
    const last = joined.at(-1);
    if (last !== undefined && last.text.trimEnd().endsWith(":"))
      joined[joined.length - 1] = {
        text: `${last.text}\n${paragraph.text}`,
        sentences: [...last.sentences, ...paragraph.sentences],
      };
    else joined.push({ text: paragraph.text, sentences: paragraph.sentences });
  }
  const read: Paragraph[] = [];
  for (const paragraph of joined) {
    const sentences = paragraph.sentences.filter((sentence) => !onlyCode(sentence));
    left.code += paragraph.sentences.length - sentences.length;
    if (sentences.length > 0) read.push({ text: paragraph.text, sentences });
  }
  return { paragraphs: read, left };
}

export type Ask = (
  states: readonly string[],
  questions: (typeof QUESTIONS)[keyof typeof QUESTIONS],
) => Promise<DecisionOutcome[]>;

type Got = { row: number[] } | { why: string };

const IDS = ["clear", "choppy", "tangled"] as const;
const noul = z.looseObject({ noul: z.number().min(0).max(1) });
const answersSchema = z.looseObject({ clear: noul, choppy: noul, tangled: noul });

const figures = (outcome: DecisionOutcome | undefined): Got => {
  if (!outcome) return { why: "no answer" };
  if ("error" in outcome) {
    const { status, message } = outcome.error;
    return { why: status === null ? message : `${status}: ${message}` };
  }
  const parsed = answersSchema.safeParse(outcome.answers);
  if (!parsed.success) {
    const missing = IDS.find((id) => !noul.safeParse(outcome.answers[id]).success);
    return { why: `no figure for ${missing ?? "a question"}` };
  }
  const { clear, choppy, tangled } = parsed.data;
  const read: Answers = { clear: clear.noul, choppy: choppy.noul, tangled: tangled.noul };
  return { row: COLUMNS.map((column) => column.of(read)) };
};

async function judged(
  ask: Ask,
  paragraphs: readonly string[],
  sentences: readonly string[],
): Promise<{ paragraphs: Got[]; sentences: Got[] }> {
  const [p, s] = await Promise.all([
    ask(paragraphs, QUESTIONS.paragraph),
    ask(sentences, QUESTIONS.sentence),
  ]);
  const got = { paragraphs: p.map(figures), sentences: s.map(figures) };
  const again = {
    paragraphs: got.paragraphs.flatMap((f, i) => ("row" in f ? [] : [i])),
    sentences: got.sentences.flatMap((f, i) => ("row" in f ? [] : [i])),
  };
  if (again.paragraphs.length + again.sentences.length === 0) return got;
  const [p2, s2] = await Promise.all([
    again.paragraphs.length
      ? ask(
          again.paragraphs.map((i) => paragraphs[i]!),
          QUESTIONS.paragraph,
        )
      : [],
    again.sentences.length
      ? ask(
          again.sentences.map((i) => sentences[i]!),
          QUESTIONS.sentence,
        )
      : [],
  ]);
  again.paragraphs.forEach((i, k) => (got.paragraphs[i] = figures(p2[k])));
  again.sentences.forEach((i, k) => (got.sentences[i] = figures(s2[k])));
  return got;
}

const cut = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ");
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
};
const count = (): Marks => ({ unclear: 0, choppy: 0, tangled: 0 });
const byColumn = (counts: Marks) =>
  COLUMNS.filter((column) => counts[column.key] > 0)
    .map((column) => `${column.key} ${counts[column.key]}`)
    .join(", ") || "none";

export interface Reading {
  table: string;
  counts: {
    paragraphs: number;
    sentences: number;
    unanswered: number;
    marks: { paragraphs: Marks; sentences: Marks };
  };
}

export async function read(name: string, body: string, ask: Ask): Promise<Reading> {
  const { paragraphs, left } = units(body);
  const sentences = paragraphs.flatMap((p, i) =>
    p.sentences.map((s, k) => ({ paragraph: i, number: k + 1, text: s })),
  );
  const leftOut = [
    left.frontmatter ? "a frontmatter block" : "",
    left.fenced ? plural(left.fenced, "fenced block") : "",
    left.indented ? plural(left.indented, "indented code block") : "",
    left.details ? plural(left.details, "details block") : "",
    left.code ? `${left.code} ${left.code === 1 ? "sentence" : "sentences"} of code alone` : "",
  ].filter(Boolean);
  const leftLine = leftOut.length ? ` Left out: ${leftOut.join(", ")}.` : "";
  const marks = { paragraphs: count(), sentences: count() };
  if (paragraphs.length === 0)
    return {
      table: `${name}: no paragraph to read.${leftLine}`,
      counts: { paragraphs: 0, sentences: 0, unanswered: 0, marks },
    };
  const started = Date.now();
  const got = await judged(
    ask,
    paragraphs.map((p) => p.text),
    sentences.map((s) => s.text),
  );
  const ms = Date.now() - started;
  type Unit = { label: string; text: string; got: Got; kind: Kind | null; counts?: Marks };
  const table: Unit[] = [];
  paragraphs.forEach((paragraph, i) => {
    table.push({
      label: `¶${i + 1}`,
      text: paragraph.text,
      got: got.paragraphs[i]!,
      kind: "paragraph",
      counts: marks.paragraphs,
    });
    sentences.forEach((sentence, j) => {
      if (sentence.paragraph === i)
        table.push({
          label: `  ${i + 1}.${sentence.number}`,
          text: sentence.text,
          got: got.sentences[j]!,
          kind: "sentence",
          counts: marks.sentences,
        });
    });
  });
  for (const unit of table) {
    const { got: each, counts, kind } = unit;
    if ("row" in each && counts && kind)
      COLUMNS.forEach((column, c) => {
        if (over(column, kind, each.row[c]!)) counts[column.key]++;
      });
  }
  const mean = (level: Got[], one: string): Unit => {
    const rows = level.flatMap((each) => ("row" in each ? [each.row] : []));
    return {
      label: "mean",
      text:
        rows.length === level.length
          ? `the mean of the ${plural(level.length, one)}`
          : `the mean of the ${rows.length} of ${plural(level.length, one)} with figures`,
      got: rows.length
        ? {
            row: COLUMNS.map((_, c) => rows.reduce((sum, row) => sum + row[c]!, 0) / rows.length),
          }
        : { why: "no unit has figures" },
      kind: null,
    };
  };
  const means = [mean(got.paragraphs, "paragraph"), mean(got.sentences, "sentence")];
  const width = Math.max(...table.map((unit) => unit.label.length), "mean".length);
  const row = (unit: Unit) => {
    const start = unit.label.padEnd(width);
    if (!("row" in unit.got))
      return `${start}  no answer (${unit.got.why})  | ${cut(unit.text, 80)}`;
    const { row: figures } = unit.got;
    const cells = COLUMNS.map((column, c) => {
      const value = figures[c]!;
      return `${figure(value)}${unit.kind && over(column, unit.kind, value) ? "!" : ""}`.padEnd(
        column.key.length,
      );
    });
    return `${start}  ${cells.join("  ")}  | ${cut(unit.text, 80)}`;
  };
  const rows = [
    `${"".padEnd(width)}  ${COLUMNS.map((column) => column.key).join("  ")}`,
    ...means.map(row),
    ...table.map(row),
  ];
  const unanswered = table.filter((unit) => !("row" in unit.got)).length;
  const first = `${name}: ${plural(paragraphs.length, "paragraph")}, ${plural(sentences.length, "sentence")}${unanswered ? `, ${unanswered} with no answer` : ""}. "!" in paragraphs: ${byColumn(marks.paragraphs)}; in sentences: ${byColumn(marks.sentences)}.${leftLine} ${MODEL}, ${ms} ms.`;
  const last = `"!" is a figure at or above its column's line: ${LINES}. Each unit is read alone. A figure moves a little between runs.`;
  return {
    table: [first, ...rows, last].join("\n"),
    counts: { paragraphs: paragraphs.length, sentences: sentences.length, unanswered, marks },
  };
}
