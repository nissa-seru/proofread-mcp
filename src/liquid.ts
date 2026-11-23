import { MODEL, type Ask } from "./read.ts";

export const ENDPOINT = "https://api.liquid.ai/decisions/v1/systemone";
export const POOL_SIZE = 256;
const RETRIES = 2;
const RETRY_WAIT_CAP_MS = 60_000;
const REQUEST_LIMIT_MS = 10_000;

export type DecisionOutcome =
  | { answers: Record<string, unknown> }
  | { error: { status: number | null; message: string } };

export class NotRead extends Error {}

export type Pool = (signal: AbortSignal) => Promise<() => void>;

export interface Pacer {
  start(signal: AbortSignal): Promise<void>;
  learn(headers: Headers): void;
}

export interface LiquidAsking {
  key: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  limit?: (ms: number) => AbortSignal;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

type Failure = { status: number | null; message: string };
type Reach = "route" | "request" | undefined;
type Attempt = { answers: Record<string, unknown> } | { error: Failure; reach: Reach };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function messageOf(body: unknown, status: number): string {
  if (isObject(body)) {
    if (isObject(body.error) && typeof body.error.message === "string") return body.error.message;
    const detail = body.detail;
    if (typeof detail === "string") return detail;
    if (isObject(detail) && typeof detail.message === "string") return detail.message;
    if (Array.isArray(detail)) {
      const fields = detail.flatMap((item) =>
        isObject(item) && typeof item.msg === "string"
          ? [`${item.msg}${Array.isArray(item.loc) ? ` at ${item.loc.join(".")}` : ""}`]
          : [],
      );
      if (fields.length) return fields.join("; ");
    }
  }
  return `HTTP ${status}`;
}

const retryable = (status: number) => status === 408 || status === 429 || status >= 500;

function reachOf(status: number, body: unknown): Reach {
  if ([401, 402, 403, 404, 503].includes(status)) return "route";
  if (status === 400) return "request";
  if (status !== 422) return undefined;
  const detail = isObject(body) ? body.detail : undefined;
  const inState = (item: unknown) =>
    isObject(item) && Array.isArray(item.loc) && item.loc[0] === "body" && item.loc[1] === "state";
  return Array.isArray(detail) && detail.length > 0 && detail.every(inState) ? undefined : "request";
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  if (/^[+-]?[\d.]+$/.test(value)) return /^\d+$/.test(value) ? Math.min(Number(value) * 1000, RETRY_WAIT_CAP_MS) : undefined;
  const ms = Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), RETRY_WAIT_CAP_MS) : undefined;
}

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

export function requestPool(size: number): Pool {
  let open = 0;
  const waiting: (() => void)[] = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else open--;
  };
  return (signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      if (open < size) {
        open++;
        return resolve(release);
      }
      const take = () => {
        signal.removeEventListener("abort", onAbort);
        resolve(release);
      };
      const onAbort = () => {
        const index = waiting.indexOf(take);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      waiting.push(take);
    });
}

const UNITS_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1 };

function durationMs(value: string | null): number | undefined {
  const text = value?.trim() ?? "";
  if (!/^(?:\d+(?:\.\d+)?(?:ms|h|m|s))+$/.test(text)) return undefined;
  let ms = 0;
  for (const [, amount, unit] of text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) ms += Number(amount) * UNITS_MS[unit!]!;
  return ms;
}

export function ratePacer(now: () => number = () => performance.now(), wait: (ms: number, signal: AbortSignal) => Promise<void> = pause): Pacer {
  let rule: { limit: number; windowMs: number } | undefined;
  const starts: number[] = [];
  return {
    async start(signal) {
      signal.throwIfAborted();
      if (!rule) return;
      const t = now();
      while (starts.length > 0 && starts[0]! <= t - rule.windowMs) starts.shift();
      const at = starts.length < rule.limit ? t : Math.max(t, starts[starts.length - rule.limit]! + rule.windowMs);
      let index = starts.length;
      while (index > 0 && starts[index - 1]! > at) index--;
      starts.splice(index, 0, at);
      if (at <= t) return;
      try {
        await wait(at - t, signal);
      } catch (error) {
        const index = starts.indexOf(at);
        if (index >= 0) starts.splice(index, 1);
        throw error;
      }
    },
    learn(headers) {
      const limit = Number(headers.get("x-ratelimit-limit-requests"));
      const windowMs = durationMs(headers.get("x-ratelimit-reset-requests"));
      if (Number.isInteger(limit) && limit > 0 && windowMs !== undefined && windowMs > 0) rule = { limit, windowMs };
    },
  };
}

const AGAIN_LATER = "Calling again later may work, and a new call sends every unit again.";

function stopText(failure: Failure, first: boolean): string {
  const what =
    failure.status === null ? failure.message : `Liquid AI answered ${failure.status} (${failure.message})`;
  const remedy =
    failure.status === null || failure.status === 503
      ? AGAIN_LATER
      : failure.status === 401 || failure.status === 403
        ? "Whoever runs this server can check its key in LIQUID_API_KEY, and start the server again with a key that Liquid AI takes. Until then, another call gets the same answer."
        : failure.status === 402
          ? "Whoever holds the account at Liquid AI can check its credits. Until then, another call gets the same answer."
          : failure.status === 404
            ? "Liquid AI's endpoint or its model may have changed, and then the server's code needs the new one: tell whoever runs this server."
            : first
              ? "That request also carried the model and the questions, so the refusal may be about them, or about the unit itself, such as a unit too long for the model. If the text's first paragraph or first sentence is very long, shorten it and call again. Otherwise, tell whoever runs this server."
              : "";
  return `The read stopped: ${what}, so no table is given.${remedy ? ` ${remedy}` : ""}`;
}

export function liquidAsker({
  key,
  fetch: fetcher = fetch,
  sleep = pause,
  limit = (ms) => AbortSignal.timeout(ms),
  now,
  wait,
}: LiquidAsking): (signal: AbortSignal) => Ask {
  const pool = requestPool(POOL_SIZE);
  const pacer = ratePacer(now, wait);
  return (signal) => liquidAsk({ key, signal, fetcher, sleep, limit, pool, pacer });
}

function liquidAsk({
  key,
  signal,
  fetcher,
  sleep,
  limit,
  pool,
  pacer,
}: {
  key: string;
  signal: AbortSignal;
  fetcher: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  limit: (ms: number) => AbortSignal;
  pool: Pool;
  pacer: Pacer;
}): Ask {
  const accepted = new WeakSet<object>();
  const stopping = new AbortController();
  const open = AbortSignal.any([signal, stopping.signal]);
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  let stopped: NotRead | undefined;
  const stop = (failure: Failure, first: boolean) => {
    stopped ??= new NotRead(stopText(failure, first));
    stopping.abort(stopped);
  };

  const send = async (state: string, questions: object): Promise<Attempt> => {
    const body = JSON.stringify({ model: MODEL, state, questions });
    for (let attempt = 0; ; attempt++) {
      open.throwIfAborted();
      const release = await pool(open);
      let passed: AbortSignal | undefined;
      let got: { response: Response; text: string } | { failed: unknown };
      try {
        await pacer.start(open);
        passed = limit(REQUEST_LIMIT_MS);
        const response = await fetcher(ENDPOINT, { method: "POST", headers, body, signal: AbortSignal.any([open, passed]) });
        pacer.learn(response.headers);
        got = { response, text: await response.text() };
      } catch (error) {
        got = { failed: error };
      } finally {
        release();
      }
      if ("failed" in got) {
        if (open.aborted) throw got.failed;
        if (attempt < RETRIES) {
          await sleep(500 * 2 ** attempt, open);
          continue;
        }
        const message = passed?.aborted
          ? `the last had no answer within ${REQUEST_LIMIT_MS / 1000} s`
          : got.failed instanceof Error
            ? got.failed.message
            : String(got.failed);
        return { error: { status: null, message: `Liquid AI didn't answer after ${RETRIES + 1} tries (${message})` }, reach: "route" };
      }
      const { response, text } = got;
      const answer = parsed(text);
      if (response.ok && isObject(answer) && isObject(answer.answers)) return { answers: answer.answers };
      if (!response.ok && retryable(response.status) && attempt < RETRIES) {
        await sleep(retryAfterMs(response) ?? 500 * 2 ** attempt, open);
        continue;
      }
      if (response.ok) return { error: { status: response.status, message: "the answer held no answers" }, reach: undefined };
      return { error: { status: response.status, message: messageOf(answer, response.status) }, reach: reachOf(response.status, answer) };
    }
  };

  return async (states, questions) => {
    if (states.length === 0) return [];
    const outcomes: DecisionOutcome[] = new Array(states.length);
    const keep = (index: number, attempt: Attempt) => {
      if ("answers" in attempt) accepted.add(questions);
      outcomes[index] = "answers" in attempt ? { answers: attempt.answers } : { error: attempt.error };
    };
    const first = await send(states[0]!, questions);
    if ("error" in first && (first.reach === "route" || (first.reach === "request" && !accepted.has(questions)))) {
      stop(first.error, first.reach === "request");
      throw stopped;
    }
    keep(0, first);

    let next = 1;
    const workers = Array.from({ length: Math.min(POOL_SIZE, states.length - 1) }, async () => {
      while (!stopped && next < states.length) {
        const index = next++;
        const attempt = await send(states[index]!, questions);
        if ("error" in attempt && attempt.reach === "route") {
          stop(attempt.error, false);
          return;
        }
        keep(index, attempt);
      }
    });
    const settled = await Promise.allSettled(workers);
    if (stopped) throw stopped;
    const thrown = settled.find((each) => each.status === "rejected");
    if (thrown) throw thrown.reason;
    return outcomes;
  };
}
