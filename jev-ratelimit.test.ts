// jev rate-limit regression harness — DEFECT 1 + DEFECT 2 (live free-tier 429).
//
// Found by hitting the real free-tier rate limit during live battle testing:
// HTTP 429 FreeUsageLimitError with a Retry-After header. The loop honoured
// Retry-After at the 8s cap inside the 10s budget, burned the budget sleeping,
// then hit the deadline guard and returned the bare generic string
// ("upstream request failed") — discarding the real 429. Synthetic tests had
// never exercised a real Retry-After on a 429.
//
// Offline only (injected fetch + fake clock); no test hits the network.
// Conventions mirror jev-core.test.ts: unique state per case (exact-match
// cache keys), token seam (no filesystem/auth touch), injected now/sleep/rng.
//
//     node --test jev-ratelimit.test.ts
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  OVERALL_BUDGET_MS,
  _clearBearerCache,
  _clearJevCache,
  decide,
} from "./jev-core.ts";

const FALLBACK_PREFIX = "fallback:true | ";
const GENERIC_FALLBACK = "fallback:true | error: upstream request failed";

describe("rate-limit regressions (offline — injected fetch/time)", () => {
  let t: number;
  const now = () => t;
  const zeroRng = () => 0;
  const okJson = (v: unknown) =>
    new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  const statusResp = (status: number, body: string, headers?: Record<string, string>) =>
    new Response(body, { status, headers });

  test("DEFECT 2: 429 with Retry-After exceeding remaining budget => ONE fetch, no long sleep, 429 surfaced", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 50_000_000;
    const t0 = t;
    let calls = 0;
    const slept: number[] = [];
    const deps = {
      // Simulate a slow first attempt that burns 9s: only 1s of the 10s
      // budget remains when the 429's Retry-After: 8 arrives, so the retry
      // is futile by construction and must be skipped.
      fetchImpl: async () => {
        calls++;
        t += 9000;
        return statusResp(429, "FreeUsageLimitError: free tier limit exceeded", { "retry-after": "8" });
      },
      token: "tok-test",
      now,
      sleep: async (ms: number) => {
        slept.push(ms);
        t += ms;
      },
      rng: zeroRng,
    };
    const r = await decide("ratelimit-futile-retry-state", undefined, deps);
    assert.equal(calls, 1, "futile retry must not issue a second fetch");
    assert.deepEqual(slept, [], "must not burn the remaining budget on an 8s sleep that cannot fit");
    assert.ok(r.startsWith(FALLBACK_PREFIX), "prefix contract holds");
    assert.ok(r.includes("429"), "final message names the 429 status");
    assert.ok(r.includes("FreeUsageLimitError"), "final message carries the upstream body text");
    assert.ok(r.includes("retry after 8s"), "final message carries the Retry-After so the caller can schedule");
    assert.ok(t - t0 < OVERALL_BUDGET_MS, `fake-clock elapsed ${t - t0}ms stays inside the budget`);
  });

  test("429 with NO Retry-After retries per policy and the FINAL message names the 429, not the generic string", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 51_000_000;
    let calls = 0;
    const slept: number[] = [];
    const deps = {
      fetchImpl: async () => {
        calls++;
        return statusResp(429, "slow down, no header here");
      },
      token: "tok-test",
      now,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
      rng: zeroRng,
    };
    const r = await decide("ratelimit-no-header-state", undefined, deps);
    assert.equal(calls, 3, "pure-jitter 429s still retry up to the attempt cap");
    assert.deepEqual(slept, [300, 600], "backoff policy unchanged");
    assert.ok(r.startsWith(FALLBACK_PREFIX));
    assert.notEqual(r, GENERIC_FALLBACK, "must never return the bare generic string after real 429s");
    assert.ok(r.includes("429"), "final message names the 429 status");
    assert.ok(r.includes("slow down, no header here"), "final message carries the upstream body");
  });

  test("DEFECT 1: deadline break after real 429s still reports the 429 (not the generic string)", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 52_000_000;
    let calls = 0;
    const deps = {
      fetchImpl: async () => {
        calls++;
        t += 6000; // each attempt burns 6s: the second consumes the budget
        return statusResp(429, "FreeUsageLimitError: quota gone");
      },
      token: "tok-test",
      now,
      sleep: async (ms: number) => {
        t += ms;
      },
      rng: zeroRng,
    };
    const r = await decide("ratelimit-deadline-break-state", undefined, deps);
    assert.ok(calls >= 1 && calls <= 3, `calls ${calls} stay within the attempt cap`);
    assert.ok(r.startsWith(FALLBACK_PREFIX));
    assert.notEqual(r, GENERIC_FALLBACK, "deadline break must not discard the observed 429");
    assert.ok(r.includes("429"), "deadline-break message names the 429 status");
    assert.ok(r.includes("FreeUsageLimitError"), "deadline-break message carries the upstream body");
  });

  test("budget already exhausted at loop entry => explicit never-tried message, zero fetches", async () => {
    _clearJevCache();
    _clearBearerCache();
    const T = 53_000_000;
    let nowCalls = 0;
    let fetchCalls = 0;
    const deps = {
      fetchImpl: async () => {
        fetchCalls++;
        return okJson({ expert: "coder" });
      },
      token: "tok-test",
      // t0 lands on T; every later read is past the 10s deadline, so the
      // loop guard trips before the first attempt.
      now: () => (nowCalls++ === 0 ? ((t = T), T) : T + OVERALL_BUDGET_MS + 1000),
      sleep: async (_ms: number) => {},
      rng: zeroRng,
    };
    const r = await decide("ratelimit-never-tried-state", undefined, deps);
    assert.equal(fetchCalls, 0, "no attempt must be made once the budget is gone");
    assert.ok(r.startsWith(FALLBACK_PREFIX));
    assert.ok(r.includes("before any attempt"), "caller must distinguish never-tried from tried-and-limited");
    assert.ok(r.includes("no request was made"), "message says explicitly that nothing was sent");
  });

  test("last exception preserved: final-attempt network throw reports the exception, not the generic string", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 54_000_000;
    let calls = 0;
    const deps = {
      fetchImpl: async () => {
        calls++;
        throw new Error("boom: simulated outage-xyz");
      },
      token: "tok-test",
      now,
      sleep: async (_ms: number) => {},
      rng: zeroRng,
    };
    const r = await decide("ratelimit-exception-state", undefined, deps);
    assert.equal(calls, 3, "network errors still retry up to the attempt cap");
    assert.ok(r.startsWith(FALLBACK_PREFIX));
    assert.notEqual(r, GENERIC_FALLBACK);
    assert.ok(r.includes("boom: simulated outage-xyz"), "final message reports the real exception");
  });

  test("exception followed by deadline break still reports the exception", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 55_000_000;
    let calls = 0;
    const deps = {
      fetchImpl: async () => {
        calls++;
        t += 20_000; // clock leaps past the deadline during the attempt
        throw new Error("kaboom-final: socket hangup");
      },
      token: "tok-test",
      now,
      sleep: async (_ms: number) => {},
      rng: zeroRng,
    };
    const r = await decide("ratelimit-exception-deadline-state", undefined, deps);
    assert.equal(calls, 1, "deadline guard stops the loop after the clock jump");
    assert.ok(r.startsWith(FALLBACK_PREFIX));
    assert.notEqual(r, GENERIC_FALLBACK);
    assert.ok(r.includes("kaboom-final"), "deadline-break message preserves the exception");
  });

  test("a cached entry still wins over a 429 (degraded path keeps priority)", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 56_000_000;
    let mode = "ok";
    let calls = 0;
    const deps = {
      fetchImpl: async () => {
        calls++;
        if (mode === "ok") return okJson({ expert: "reviewer", needs_review: { score: 2.2 } });
        return statusResp(429, "FreeUsageLimitError: limited", { "retry-after": "1" });
      },
      token: "tok-test",
      now,
      sleep: async (_ms: number) => {},
      rng: zeroRng,
    };
    const r1 = await decide("ratelimit-degrade-state", undefined, deps);
    assert.equal((JSON.parse(r1) as any).expert, "reviewer");
    const callsAfterPrime = calls;
    t += 61_000; // past the 60s score TTL, inside the 6h choice TTL
    mode = "fail";
    const r2 = await decide("ratelimit-degrade-state", undefined, deps);
    assert.ok(calls > callsAfterPrime, "the 429 path still attempts the network (no silent cache bypass)");
    assert.ok(!r2.startsWith(FALLBACK_PREFIX), `degraded hit must not be a fallback: ${r2.slice(0, 120)}`);
    const p2 = JSON.parse(r2) as any;
    assert.equal(p2._jev.cached, "choice");
    assert.equal(p2._jev.stale, true, "degraded envelope is flagged stale");
    assert.equal(p2.expert, "reviewer", "degraded hit keeps the cached expert over the 429");
  });
});
