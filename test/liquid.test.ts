import { expect, test } from "bun:test";

import { ENDPOINT, liquidAsker, NotRead, POOL_SIZE, ratePacer, requestPool } from "../src/liquid.ts";
import { QUESTIONS, read } from "../src/read.ts";

type Sent = {
  url: string;
  method: string | undefined;
  authorization: string | null;
  body: { model: string; state: string; questions: unknown };
  signal: AbortSignal | null | undefined;
};
type Answer = (state: string, attempt: number, signal: AbortSignal | null | undefined) => Response | Promise<Response>;

const noul = (value: number) => ({ type: "noul", noul: value });
const answered = () =>
  Response.json({
    model: "d1.2-ultra",
    answers: { clear: noul(0.9), choppy: noul(0.1), tangled: noul(0.1) },
    usage: { input_tokens: 10 },
  });
const refusal = (status: number, message: string, headers: Record<string, string> = {}) =>
  Response.json({ error: { message, type: "invalid_request_error", param: null, code: null } }, { status, headers });

const untilAborted = (signal: AbortSignal | null | undefined) =>
  new Promise<Response>((_, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

function liquid(
  answer: Answer,
  options: {
    limit?: (ms: number) => AbortSignal;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    now?: () => number;
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {},
) {
  const sent: Sent[] = [];
  const slept: number[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Sent["body"];
    sent.push({ url, method: init.method, authorization: new Headers(init.headers).get("authorization"), body, signal: init.signal });
    return answer(body.state, sent.filter((one) => one.body.state === body.state).length, init.signal);
  };
  const sleep = async (ms: number, signal: AbortSignal) => {
    slept.push(ms);
    if (options.sleep) await options.sleep(ms, signal);
  };
  const controller = new AbortController();
  const asker = liquidAsker({
    key: "key-1",
    fetch,
    sleep,
    ...(options.limit ? { limit: options.limit } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.wait ? { wait: options.wait } : {}),
  });
  return { sent, slept, ask: asker(controller.signal), asker, controller };
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("it didn't fail");
}

test("each unit goes to Liquid AI's endpoint in one POST of its own, with the key as a bearer token and the model, the unit and the questions as its body", async () => {
  const l = liquid(() => answered());
  const outcomes = await l.ask(["One.", "Two."], QUESTIONS.sentence);
  expect(outcomes).toEqual([
    { answers: { clear: noul(0.9), choppy: noul(0.1), tangled: noul(0.1) } },
    { answers: { clear: noul(0.9), choppy: noul(0.1), tangled: noul(0.1) } },
  ]);
  expect(ENDPOINT).toBe("https://api.liquid.ai/decisions/v1/systemone");
  expect(l.sent.map((one) => [one.url, one.method, one.authorization, one.body.model, one.body.state])).toEqual([
    [ENDPOINT, "POST", "Bearer key-1", "d1.2-ultra", "One."],
    [ENDPOINT, "POST", "Bearer key-1", "d1.2-ultra", "Two."],
  ]);
  expect(l.sent.map((one) => one.body.questions)).toEqual([QUESTIONS.sentence, QUESTIONS.sentence]);
});

test("an answer that is asked again waits for its Retry-After, which counts for at most 60 s, or else for 0.5 s and then 1 s", async () => {
  const l = liquid((state, attempt) => {
    if (state === "Waits." && attempt === 1) return refusal(429, "Slow down.", { "retry-after": "3" });
    if (state === "Waits long." && attempt === 1) return refusal(429, "Slow down.", { "retry-after": "120" });
    if (state === "Fails.") return refusal(500, "Something broke.");
    return answered();
  });
  const outcomes = await l.ask(["First.", "Waits.", "Waits long.", "Fails."], QUESTIONS.sentence);
  expect(l.slept.toSorted((a, b) => a - b)).toEqual([500, 1000, 3000, 60000]);
  expect(outcomes.map((one) => ("answers" in one ? "answered" : one.error))).toEqual([
    "answered",
    "answered",
    "answered",
    { status: 500, message: "Something broke." },
  ]);
});

test("an empty or a negative Retry-After counts as none, so the wait is the backoff's", async () => {
  const l = liquid((state, attempt) => {
    if (state === "Empty." && attempt === 1) return refusal(429, "Slow down.", { "retry-after": "" });
    if (state === "Negative." && attempt === 1) return refusal(429, "Slow down.", { "retry-after": "-1" });
    return answered();
  });
  await l.ask(["First.", "Empty.", "Negative."], QUESTIONS.sentence);
  expect(l.slept).toEqual([500, 500]);
});

const ways: { answer: number | "no answer"; sends: number; way: "own" | "stop"; words?: string[] }[] = [
  { answer: 400, sends: 1, way: "own" },
  { answer: 401, sends: 1, way: "stop", words: ["Liquid AI answered 401", "LIQUID_API_KEY", "Whoever runs this server"] },
  { answer: 402, sends: 1, way: "stop", words: ["Liquid AI answered 402", "credits"] },
  { answer: 403, sends: 1, way: "stop", words: ["Liquid AI answered 403", "LIQUID_API_KEY", "Whoever runs this server"] },
  { answer: 404, sends: 1, way: "stop", words: ["Liquid AI answered 404", "whoever runs this server"] },
  { answer: 408, sends: 3, way: "own" },
  { answer: 422, sends: 1, way: "own" },
  { answer: 429, sends: 3, way: "own" },
  { answer: 500, sends: 3, way: "own" },
  { answer: 503, sends: 3, way: "stop", words: ["Liquid AI answered 503", "Calling again later may work", "every unit again"] },
  { answer: "no answer", sends: 3, way: "stop", words: ["Liquid AI didn't answer after 3 tries", "fetch failed", "Calling again later may work"] },
];

test("each answer to a later unit has its way: some are asked again, some stop the sending with what the person can do, and the others are their unit's own", async () => {
  for (const { answer, sends, way, words } of ways) {
    const l = liquid((state) => {
      if (state !== "Target.") return answered();
      if (answer === "no answer") throw new TypeError("fetch failed");
      return refusal(answer, `Refused with ${answer}.`);
    });
    const asking = l.ask(["First.", "Target."], QUESTIONS.sentence);
    if (way === "own") {
      const outcomes = await asking;
      expect([answer, outcomes[1]]).toEqual([answer, { error: { status: Number(answer), message: `Refused with ${answer}.` } }]);
    } else {
      const failure = await failureOf(asking);
      expect(failure).toBeInstanceOf(NotRead);
      const message = (failure as NotRead).message;
      expect(message).toStartWith("The read stopped:");
      for (const word of words ?? []) expect([answer, message]).toEqual([answer, expect.stringContaining(word)]);
    }
    expect([answer, l.sent.filter((one) => one.body.state === "Target.").length]).toEqual([answer, sends]);
  }
});

test("each request has its own limit of 10 s: a request that passes it has no answer and is tried again, and after three tries the sending stops with words that say so", async () => {
  const limits: number[] = [];
  const passed = (ms: number) => {
    limits.push(ms);
    return AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError"));
  };
  const l = liquid((_state, _attempt, signal) => untilAborted(signal), { limit: passed });
  const failure = await failureOf(l.ask(["Hangs.", "Never sent."], QUESTIONS.sentence));
  expect(failure).toBeInstanceOf(NotRead);
  expect((failure as NotRead).message).toStartWith("The read stopped: Liquid AI didn't answer after 3 tries");
  expect((failure as NotRead).message).toContain("within 10 s");
  expect((failure as NotRead).message).toContain("Calling again later may work");
  expect(limits).toEqual([10_000, 10_000, 10_000]);
  expect(l.slept).toEqual([500, 1000]);
  expect(l.sent.map((one) => one.body.state)).toEqual(["Hangs.", "Hangs.", "Hangs."]);
});

test("a 401 stops the sending: the ask fails once with Liquid AI's words and a check of the key, and the requests still open are aborted", async () => {
  const l = liquid((state, _attempt, signal) =>
    state === "First." ? answered() : state === "Refused." ? refusal(401, "Invalid API key.") : untilAborted(signal),
  );
  const states = ["First.", "Open 1.", "Open 2.", "Refused.", "Open 3.", ...Array.from({ length: 300 }, (_, i) => `Later ${i}.`)];
  const failure = await failureOf(l.ask(states, QUESTIONS.sentence));
  expect(failure).toBeInstanceOf(NotRead);
  const message = (failure as NotRead).message;
  expect(message).toStartWith("The read stopped:");
  expect(message).toContain("401");
  expect(message).toContain("Invalid API key.");
  expect(message).toContain("LIQUID_API_KEY");
  const open = l.sent.filter((one) => one.body.state !== "First." && one.body.state !== "Refused.");
  expect(open.length).toBeGreaterThan(0);
  expect(open.every((one) => one.signal?.aborted === true)).toBe(true);
  expect(l.sent.length).toBeLessThan(states.length);
});

test("a stop in one ask of a call aborts the other ask's open requests at once, and both asks fail with the stop's words", async () => {
  const l = liquid((state, _attempt, signal) => {
    if (state === "First paragraph." || state === "First sentence.") return answered();
    if (state === "Refused.") return refusal(401, "Invalid API key.");
    return untilAborted(signal);
  });
  const paragraphs = l.ask(["First paragraph.", "Held paragraph 1.", "Held paragraph 2."], QUESTIONS.paragraph);
  const sentences = l.ask(["First sentence.", "Held sentence.", "Refused."], QUESTIONS.sentence);
  const [p, s] = await Promise.allSettled([paragraphs, sentences]);
  for (const settled of [p, s]) {
    expect(settled.status).toBe("rejected");
    if (settled.status === "rejected") {
      expect(settled.reason).toBeInstanceOf(NotRead);
      expect((settled.reason as NotRead).message).toContain("Invalid API key.");
    }
  }
  const held = l.sent.filter((one) => one.body.state.startsWith("Held"));
  expect(held.map((one) => one.body.state).toSorted()).toEqual(["Held paragraph 1.", "Held paragraph 2.", "Held sentence."]);
  expect(held.every((one) => one.signal?.aborted === true)).toBe(true);
});

test("a 400 or a 422 for the first unit stops the sending, since the first request carries the model and the questions, and the words say what the person can do", async () => {
  for (const status of [400, 422]) {
    const l = liquid((state) => (state === "First." ? refusal(status, "Bad questions.") : answered()));
    const failure = await failureOf(l.ask(["First.", "Second.", "Third."], QUESTIONS.sentence));
    expect(failure).toBeInstanceOf(NotRead);
    const message = (failure as NotRead).message;
    expect(message).toStartWith(`The read stopped: Liquid AI answered ${status} (Bad questions.)`);
    expect(message).toContain("shorten it");
    expect(message).toContain("whoever runs this server");
    expect(l.sent.map((one) => one.body.state)).toEqual(["First."]);
  }
});

test("a 422 for the first unit that names only the unit's text is that unit's own, as for any unit", async () => {
  const l = liquid((state) =>
    state === "First."
      ? Response.json({ detail: [{ loc: ["body", "state"], msg: "String too long.", type: "string_too_long" }] }, { status: 422 })
      : answered(),
  );
  const outcomes = await l.ask(["First.", "Second."], QUESTIONS.sentence);
  expect(outcomes[0]).toEqual({ error: { status: 422, message: "String too long. at body.state" } });
  expect("answers" in outcomes[1]!).toBe(true);
});

test("once the model has answered a unit with the same questions, a 400 or a 422 for the first unit of a later ask is that unit's own", async () => {
  for (const status of [400, 422]) {
    const l = liquid((state) => (state === "Fine." ? answered() : refusal(status, "Too long.")));
    expect(await l.ask(["Fine."], QUESTIONS.sentence)).toHaveLength(1);
    expect(await l.ask(["Too long."], QUESTIONS.sentence)).toEqual([{ error: { status, message: "Too long." } }]);
    expect(await failureOf(l.ask(["Too long."], QUESTIONS.paragraph))).toBeInstanceOf(NotRead);
  }
});

test("when the call ends, a retry that waits sends nothing more", async () => {
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  const l = liquid(() => refusal(429, "Slow down.", { "retry-after": "30" }), {
    sleep: (_ms, signal) => {
      entered();
      return new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  const asking = l.ask(["Waits."], QUESTIONS.sentence);
  await waiting;
  l.controller.abort(new Error("The call ended."));
  const failure = await failureOf(asking);
  expect((failure as Error).message).toBe("The call ended.");
  expect(l.slept).toEqual([30_000]);
  expect(l.sent).toHaveLength(1);
});

test("a 422 about a later unit is that unit's own: its row shows the status and the reason, and the other rows have figures", async () => {
  const reason = "The prompt for question `tangled` is over the model's input limit of 65536 tokens, images included, or 250000 bytes of text.";
  const l = liquid((state) => (state === "Too long here." ? refusal(422, reason) : answered()));
  const reading = await read("note.md", "It starts here. Too long here. It ends here.", l.ask);
  const rows = reading.table.split("\n");
  const row = (label: string) => rows.find((each) => each.trimStart().startsWith(`${label} `))!;
  expect(row("1.2")).toContain("422");
  expect(row("1.2")).toContain(reason);
  for (const label of ["¶1", "1.1", "1.3"]) {
    expect(row(label)).not.toContain("422");
    expect(row(label)).toContain(".10");
  }
  expect(reading.counts.unanswered).toBe(1);
});

test("a request that waits for a place in the pool leaves it when its call ends, and the next free place goes to the next request that waits", async () => {
  const pool = requestPool(1);
  const releaseFirst = await pool(new AbortController().signal);
  const ended = new AbortController();
  const waiting = pool(ended.signal);
  const next = pool(new AbortController().signal);
  ended.abort(new Error("The call ended."));
  expect(((await failureOf(waiting)) as Error).message).toBe("The call ended.");
  releaseFirst();
  const releaseNext = await next;
  releaseNext();
  const releaseLast = await pool(new AbortController().signal);
  releaseLast();
});

test("the process keeps at most 256 requests open, Bun's own pool for fetch, shared by every ask of every call, and fills that many while units wait", async () => {
  let open = 0;
  let most = 0;
  const held: (() => void)[] = [];
  let releasing = false;
  const release = () => {
    releasing = false;
    for (const resolve of held.splice(0)) resolve();
  };
  const answer: Answer = async () => {
    open++;
    most = Math.max(most, open);
    await new Promise<void>((resolve) => {
      held.push(resolve);
      if (!releasing) {
        releasing = true;
        setImmediate(release);
      }
    });
    open--;
    return answered();
  };
  const l = liquid(answer);
  const calls = [l.ask, l.asker(new AbortController().signal)];
  const units = (call: number) => Array.from({ length: 150 }, (_, i) => `Call ${call}, unit ${i}.`);
  const outcomes = await Promise.all(
    calls.flatMap((ask, i) => [ask(units(i), QUESTIONS.paragraph), ask(units(i), QUESTIONS.sentence)]),
  );
  expect(POOL_SIZE).toBe(256);
  expect(most).toBe(POOL_SIZE);
  expect(outcomes.map((one) => one.length)).toEqual([150, 150, 150, 150]);
  expect(l.sent).toHaveLength(600);
});

const ruled = (limit: string | null, reset: string | null) => {
  const headers = new Headers();
  if (limit !== null) headers.set("x-ratelimit-limit-requests", limit);
  if (reset !== null) headers.set("x-ratelimit-reset-requests", reset);
  return headers;
};

function pacing() {
  const waits: number[] = [];
  const pacer = ratePacer(
    () => 0,
    async (ms) => {
      waits.push(ms);
    },
  );
  return { pacer, waits, signal: new AbortController().signal };
}

test("the pacer starts at most the key's limit of requests in each window, both read from an answer's headers, and an answer without them leaves what it learned", async () => {
  const p = pacing();
  p.pacer.learn(ruled("2", "1s"));
  p.pacer.learn(new Headers());
  await Promise.all(Array.from({ length: 5 }, () => p.pacer.start(p.signal)));
  expect(p.waits).toEqual([1000, 1000, 2000]);
});

test("a window reads as a duration in hours, minutes, seconds and milliseconds; with no such headers, or ones that can't be read, nothing is paced", async () => {
  for (const [reset, ms] of [["1s", 1000], ["1.5s", 1500], ["20ms", 20], ["6m0s", 360_000], ["1h", 3_600_000]] as const) {
    const p = pacing();
    p.pacer.learn(ruled("1", reset));
    await p.pacer.start(p.signal);
    await p.pacer.start(p.signal);
    expect([reset, p.waits]).toEqual([reset, [ms]]);
  }
  for (const [limit, reset] of [[null, null], ["100", null], [null, "1s"], ["many", "1s"], ["0", "1s"], ["2.5", "1s"], ["100", "soon"], ["100", ""], ["100", "0s"]] as const) {
    const p = pacing();
    p.pacer.learn(ruled(limit, reset));
    await Promise.all(Array.from({ length: 300 }, () => p.pacer.start(p.signal)));
    expect([limit, reset, p.waits]).toEqual([limit, reset, []]);
  }
});

test("a request that waits for its start leaves when its call ends, and gives its start back to the requests after it", async () => {
  const waits: number[] = [];
  const ended = new AbortController();
  const pacer = ratePacer(
    () => 0,
    (ms, signal) => {
      waits.push(ms);
      if (signal !== ended.signal) return Promise.resolve();
      return new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  );
  pacer.learn(ruled("1", "1s"));
  const kept = new AbortController().signal;
  await pacer.start(kept);
  const leaving = pacer.start(ended.signal);
  ended.abort(new Error("The call ended."));
  expect(((await failureOf(leaving)) as Error).message).toBe("The call ended.");
  await pacer.start(kept);
  expect(waits).toEqual([1000, 1000]);
});

test("every call of a server keeps to the limit that the answers carry, and a 429 is still asked again after its Retry-After", async () => {
  const waits: number[] = [];
  const headers = { "x-ratelimit-limit-requests": "3", "x-ratelimit-reset-requests": "1s" };
  const l = liquid(
    (state, attempt) =>
      state === "Unit 5." && attempt === 1
        ? refusal(429, "Slow down.", { ...headers, "retry-after": "2" })
        : Response.json({ answers: { clear: noul(0.9), choppy: noul(0.1), tangled: noul(0.1) } }, { headers }),
    {
      now: () => 0,
      wait: async (ms) => {
        waits.push(ms);
      },
    },
  );
  const outcomes = await l.ask(Array.from({ length: 10 }, (_, i) => `Unit ${i + 1}.`), QUESTIONS.sentence);
  expect(outcomes.every((one) => "answers" in one)).toBe(true);
  expect(waits.toSorted((a, b) => a - b)).toEqual([1000, 1000, 1000, 2000, 2000, 2000, 3000]);
  expect(l.slept).toEqual([2000]);
  const second = l.asker(new AbortController().signal);
  await second(["Another call."], QUESTIONS.sentence);
  expect(waits.toSorted((a, b) => a - b)).toEqual([1000, 1000, 1000, 2000, 2000, 2000, 3000, 3000]);
});
