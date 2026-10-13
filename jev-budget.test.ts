// jev request-budget harness — the retry loop must fit inside the MCP client
// timeout ("jev": { "timeout": 15000 } in opencode.jsonc). Worst case must
// stay <= ~10s so the client never abandons the request mid-retry (which
// would drop the `_jev` envelope AND pile duplicated load on a free-tier
// endpoint). Node builtin test runner, no new deps:
//
//     node --test jev-budget.test.ts
//
// All failure paths are offline (injected fetch + fake clock); no test hits
// the network. Conventions mirror jev-core.test.ts: unique state per case
// (cache keys are exact-match), token seam (no filesystem/auth touch),
// injected now/sleep/rng.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  FIRST_ATTEMPT_TIMEOUT_MS,
  MAX_ATTEMPTS,
  OVERALL_BUDGET_MS,
  TIMEOUT_MS,
  _clearBearerCache,
  _clearJevCache,
  decide,
  discoverPayload,
} from "./jev-core.ts";

// opencode's MCP client timeout for this server (opencode.jsonc). The
// server-side worst case must stay strictly under it with headroom left for
// transport + serialization.
const CLIENT_TIMEOUT_MS = 15_000;

const FALLBACK_PREFIX = "fallback:true | ";

describe("request budget fits inside the MCP client timeout", () => {
  let t: number;
  const now = () => t;
  const zeroRng = () => 0;
  const okJson = (v: unknown) =>
    new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  const statusResp = (status: number, headers?: Record<string, string>) =>
    new Response("err", { status, headers });

  test("ceiling: budget <= ~10s, strictly under the 15000ms client timeout", () => {
    assert.ok(OVERALL_BUDGET_MS <= 10_000, `budget ${OVERALL_BUDGET_MS}ms must be <= ~10s`);
    assert.ok(OVERALL_BUDGET_MS < CLIENT_TIMEOUT_MS, `budget ${OVERALL_BUDGET_MS}ms must be < ${CLIENT_TIMEOUT_MS}ms`);
    assert.ok(
      FIRST_ATTEMPT_TIMEOUT_MS <= 5_000,
      `first attempt ${FIRST_ATTEMPT_TIMEOUT_MS}ms must stay short (4-5s) so retries fit the budget`,
    );
    assert.ok(
      FIRST_ATTEMPT_TIMEOUT_MS < OVERALL_BUDGET_MS,
      "first attempt must leave room for retries inside the budget",
    );
    assert.equal(MAX_ATTEMPTS, 3, "retry depth unchanged");
  });

  test("advertised timeout_ms equals the budget the retry loop enforces", () => {
    assert.equal(TIMEOUT_MS, OVERALL_BUDGET_MS, "TIMEOUT_MS must not drift from the loop budget");
    const payload = discoverPayload() as Record<string, unknown>;
    assert.equal(
      payload.timeout_ms,
      OVERALL_BUDGET_MS,
      "discover must advertise the real budget, never a stale number",
    );
    assert.ok((payload.timeout_ms as number) < CLIENT_TIMEOUT_MS);
  });

  test("worst case (every attempt times out, max retries): elapsed stays within budget", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 40_000_000;
    const t0 = t;
    let calls = 0;
    const slept: number[] = [];
    // Simulate each attempt burning 1s of fake-clock time before failing:
    // the loop caps every fetch timeout and every sleep by the remaining
    // budget, so the total can never run past the deadline on a sane clock.
    const deps = {
      fetchImpl: async () => {
        calls++;
        t += 1000;
        throw new Error("timeout");
      },
      token: "tok-test",
      now,
      sleep: async (ms: number) => {
        slept.push(ms);
        t += ms;
      },
      rng: zeroRng,
    };
    const r = await decide("budget-all-timeout-state", undefined, deps);
    const elapsed = t - t0;
    assert.equal(calls, MAX_ATTEMPTS, "all attempts are still used before giving up");
    assert.ok(r.startsWith(FALLBACK_PREFIX));
    assert.ok(elapsed <= OVERALL_BUDGET_MS, `fake-clock elapsed ${elapsed}ms must stay within the budget`);
    assert.ok(elapsed < CLIENT_TIMEOUT_MS);
  });

  test("worst case (maximal Retry-After every attempt): sleeps saturate but never exceed the budget", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 41_000_000;
    const t0 = t;
    let calls = 0;
    const deps = {
      fetchImpl: async () => {
        calls++;
        return statusResp(503, { "retry-after": "100" }); // capped at 8s, then by remaining budget
      },
      token: "tok-test",
      now,
      sleep: async (ms: number) => {
        t += ms;
      },
      rng: zeroRng,
    };
    const r = await decide("budget-retry-after-state", undefined, deps);
    const elapsed = t - t0;
    assert.ok(r.startsWith(FALLBACK_PREFIX));
    assert.ok(elapsed <= OVERALL_BUDGET_MS, `fake-clock elapsed ${elapsed}ms must stay within the budget`);
    assert.ok(elapsed < CLIENT_TIMEOUT_MS);
  });

  test("misbehaving clock (jumps past the deadline mid-run): loop still terminates within MAX_ATTEMPTS", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 42_000_000;
    let calls = 0;
    const deps = {
      fetchImpl: async () => {
        calls++;
        if (calls === 1) t += 50_000; // clock leaps past the deadline during attempt 1
        return statusResp(503);
      },
      token: "tok-test",
      now,
      sleep: async (_ms: number) => {},
      rng: zeroRng,
    };
    const wall0 = Date.now();
    const r = await decide("budget-clock-jump-state", undefined, deps);
    assert.ok(Date.now() - wall0 < 5000, "no hang on a misbehaving clock");
    assert.ok(calls <= MAX_ATTEMPTS, `calls ${calls} must stay within the attempt cap`);
    assert.ok(r.startsWith(FALLBACK_PREFIX));
  });

  test("retry eligibility unchanged: 429/5xx retried; 422/401/403 never retried", async () => {
    t = 43_000_000;
    for (const status of [429, 500, 502, 503, 504]) {
      _clearJevCache();
      _clearBearerCache();
      let calls = 0;
      const deps = {
        fetchImpl: async () => {
          calls++;
          return calls === 1 ? statusResp(status) : okJson({ expert: "coder" });
        },
        token: "tok-test",
        now,
        sleep: async (_ms: number) => {},
        rng: zeroRng,
      };
      const r = await decide(`budget-retryable-${status}`, undefined, deps);
      assert.equal(calls, 2, `${status} must be retried`);
      assert.ok(!r.startsWith(FALLBACK_PREFIX), `${status} must recover on retry`);
      assert.equal((JSON.parse(r) as any)._jev.attempts, 2);
    }
    for (const status of [422, 401, 403]) {
      _clearJevCache();
      _clearBearerCache();
      let calls = 0;
      const deps = {
        fetchImpl: async () => {
          calls++;
          return statusResp(status);
        },
        token: "tok-test",
        now,
        sleep: async (_ms: number) => {},
        rng: zeroRng,
      };
      const r = await decide(`budget-nonretryable-${status}`, undefined, deps);
      assert.equal(calls, 1, `${status} must never be retried`);
      assert.ok(r.startsWith(FALLBACK_PREFIX));
    }
  });
});
