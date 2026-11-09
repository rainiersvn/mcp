// jev inflight gate + shared wall-clock budget tests — Node builtin runner,
// no new deps.
//
// Covers improvement items #1 (process-wide concurrency gate) and #2
// (wall-clock budget inheritance + per-tool-call request cap) in jev-core.ts.
// All offline: the network is replaced by the injected `fetch` seam
// (deps.fetchImpl); clocks/sleeps are injected fakes except where a real
// timer is needed to let concurrent fetches overlap. Conventions mirror
// jev-budget.test.ts: unique state per case (exact-match cache keys), token
// seam (no filesystem/auth touch), injected now/sleep/rng.
//
// Run: node --test jev-inflight.test.ts
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_INFLIGHT,
  MAX_REQUESTS_PER_CALL,
  OVERALL_BUDGET_MS,
  _clearBearerCache,
  _clearInflightGate,
  _clearJevCache,
  _gateStats,
  _inflightActive,
  acquireInflight,
  decide,
  decideBatch,
  maxInflight,
  releaseInflight,
} from "./jev-core.ts";

const FALLBACK_PREFIX = "fallback:true | ";
const NO_REQUEST_MADE = "fallback:true | budget exhausted before any attempt (no request was made)";

const okJson = (v: unknown) =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const statusResp = (status: number) => new Response("err", { status });

function fresh() {
  _clearJevCache();
  _clearBearerCache();
  _clearInflightGate();
}

// Env hygiene: JEV_MAX_INFLIGHT flips are always restored.
function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

describe("maxInflight(): default 4, JEV_MAX_INFLIGHT clamped 1..8 read at call time", () => {
  test("defaults, clamping, and garbage handling", async () => {
    assert.equal(DEFAULT_MAX_INFLIGHT, 4);
    assert.equal(MAX_REQUESTS_PER_CALL, 12);
    await withEnv({ JEV_MAX_INFLIGHT: undefined }, async () => assert.equal(maxInflight(), 4));
    await withEnv({ JEV_MAX_INFLIGHT: "" }, async () => assert.equal(maxInflight(), 4));
    await withEnv({ JEV_MAX_INFLIGHT: "2" }, async () => assert.equal(maxInflight(), 2));
    await withEnv({ JEV_MAX_INFLIGHT: " 3 " }, async () => assert.equal(maxInflight(), 3));
    await withEnv({ JEV_MAX_INFLIGHT: "0" }, async () => assert.equal(maxInflight(), 1));
    await withEnv({ JEV_MAX_INFLIGHT: "-5" }, async () => assert.equal(maxInflight(), 1));
    await withEnv({ JEV_MAX_INFLIGHT: "99" }, async () => assert.equal(maxInflight(), 8));
    await withEnv({ JEV_MAX_INFLIGHT: "garbage" }, async () => assert.equal(maxInflight(), 4));
  });
});

describe("acquireInflight unit: FIFO order, budget-exhausted is immediate false", () => {
  test("head-of-line wins; expired deadline never waits; gate drains", async () => {
    fresh();
    await withEnv({ JEV_MAX_INFLIGHT: "1" }, async () => {
      const now = () => 0;
      const sleep = async (_ms: number) => {};
      assert.equal(await acquireInflight(1000, now, sleep), true);
      assert.equal(_inflightActive(), 1);
      const order: string[] = [];
      const pB = acquireInflight(100_000, now, sleep).then((v) => {
        order.push("B");
        return v;
      });
      const pC = acquireInflight(100_000, now, sleep).then((v) => {
        order.push("C");
        return v;
      });
      // Expired budget while queued: false at once, slot count untouched.
      assert.equal(await acquireInflight(0, now, sleep), false);
      assert.equal(_inflightActive(), 1);
      releaseInflight();
      assert.equal(await pB, true);
      releaseInflight();
      assert.equal(await pC, true);
      assert.deepEqual(order, ["B", "C"]);
      releaseInflight();
      assert.equal(_inflightActive(), 0, "every acquire must pair with a release");
    });
    fresh();
  });
});

describe("gate bounds concurrent fetches (instrumented real-delay fetch)", () => {
  function counterDeps() {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const deps = {
      fetchImpl: async () => {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((r) => setTimeout(r, 25));
        active--;
        return okJson({ expert: "coder" });
      },
      token: "tok-test",
      now: () => 80_000_000,
      sleep: async (_ms: number) => {},
      rng: () => 0,
    };
    return { deps, stats: () => ({ active, maxActive, calls }) };
  }

  test("10 parallel decide() calls: maxActive <= 4, all succeed, gate drains", async () => {
    fresh();
    const { deps, stats } = counterDeps();
    const rs = await Promise.all(
      Array.from({ length: 10 }, (_, i) => decide(`gate-10-parallel-${i}`, undefined, deps)),
    );
    const { maxActive, calls } = stats();
    assert.equal(calls, 10, "distinct states need 10 fetches");
    assert.ok(maxActive <= DEFAULT_MAX_INFLIGHT, `maxActive ${maxActive} exceeds the gate`);
    assert.ok(maxActive > 1, `requests must still overlap: max was ${maxActive}`);
    for (const r of rs) assert.ok(!r.startsWith(FALLBACK_PREFIX), `must succeed: ${r.slice(0, 80)}`);
    assert.equal(_inflightActive(), 0, "gate must drain after the burst");
  });

  test("JEV_MAX_INFLIGHT=2 shrinks the bound at call time", async () => {
    fresh();
    await withEnv({ JEV_MAX_INFLIGHT: "2" }, async () => {
      const { deps, stats } = counterDeps();
      const rs = await Promise.all(
        Array.from({ length: 10 }, (_, i) => decide(`gate-env2-parallel-${i}`, undefined, deps)),
      );
      const { maxActive, calls } = stats();
      assert.equal(calls, 10);
      assert.ok(maxActive <= 2, `maxActive ${maxActive} exceeds the env override`);
      for (const r of rs) assert.ok(!r.startsWith(FALLBACK_PREFIX), r.slice(0, 80));
      assert.equal(_inflightActive(), 0);
    });
    fresh();
  });

  test("4x5 nested batches share one process-wide gate: maxActive <= 4", async () => {
    fresh();
    const { deps, stats } = counterDeps();
    const batches = await Promise.all(
      Array.from({ length: 4 }, (_, b) =>
        decideBatch(
          Array.from({ length: 5 }, (_, i) => ({ state: `nested-b${b}-e${i}` })),
          deps,
        )),
    );
    let ok = 0;
    for (const text of batches) {
      assert.ok(!text.startsWith(FALLBACK_PREFIX), `batch must succeed: ${text.slice(0, 80)}`);
      const p = JSON.parse(text) as { results: string[]; summary: Record<string, number> };
      assert.equal(p.results.length, 5);
      ok += p.summary.ok;
    }
    const { maxActive, calls } = stats();
    assert.equal(calls, 20, "20 distinct states need 20 fetches");
    assert.equal(ok, 20);
    assert.ok(maxActive <= DEFAULT_MAX_INFLIGHT, `maxActive ${maxActive} exceeds the gate`);
    assert.ok(maxActive > 1, `batches must still overlap: max was ${maxActive}`);
    assert.equal(_inflightActive(), 0);
  });
});

describe("shared wall-clock budget: slow batch degrades per-entry, never hangs", () => {
  test("batch(8) with 6.5s fake-slow fetch: partial success inside OVERALL_BUDGET_MS", async () => {
    fresh();
    let t = 50_000_000;
    const t0 = t;
    let calls = 0;
    const deps = {
      // Fake-slow: a real 5ms overlap delay (so all first-wave guards run
      // before any clock advance — deterministic), then one 6.5s virtual
      // advance per fetch. Later waves find no budget left and fall back
      // with zero new fetches.
      fetchImpl: async () => {
        calls++;
        await new Promise<void>((r) => setTimeout(r, 5));
        t += 6500;
        return okJson({ expert: "coder" });
      },
      token: "tok-test",
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      rng: () => 0,
    };
    const wall0 = Date.now();
    const text = await decideBatch(
      Array.from({ length: 8 }, (_, i) => ({ state: `slow-batch-task-${i}` })),
      deps,
    );
    const wallElapsed = Date.now() - wall0;
    assert.ok(!text.startsWith(FALLBACK_PREFIX), "batch returns partial success, never a wholesale fallback");
    const p = JSON.parse(text) as { results: string[]; summary: Record<string, number> };
    assert.equal(p.results.length, 8);
    assert.equal(p.summary.total, 8);
    assert.equal(p.summary.ok + p.summary.fallback, 8);
    assert.ok(p.summary.ok >= 1, "first wave must succeed");
    assert.ok(p.summary.fallback >= 1, "late entries must fall back solo");
    for (const r of p.results) {
      if (typeof r === "string" && r.startsWith(FALLBACK_PREFIX)) {
        assert.equal(r, NO_REQUEST_MADE, `late entries use the existing budget text: ${r.slice(0, 80)}`);
      }
    }
    assert.ok(calls >= 4, `first wave must fetch (got ${calls})`);
    assert.ok(calls <= 8, `no entry may fetch past the shared deadline (got ${calls})`);
    assert.ok(
      wallElapsed < OVERALL_BUDGET_MS,
      `wall elapsed ${wallElapsed}ms must stay inside the ${OVERALL_BUDGET_MS}ms budget`,
    );
    assert.equal(_inflightActive(), 0);
    assert.ok(t - t0 > 0, "sanity: the fake clock actually advanced");
  });
});

describe("gate saturation + deadline: no-request-made with zero new fetches", () => {
  test("acquire timeout returns the existing budget text; holders still succeed", async () => {
    fresh();
    let t = 60_000_000;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const holderDeps = {
      fetchImpl: async () => {
        calls++;
        await gate;
        return okJson({ expert: "coder" });
      },
      token: "tok-test",
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      rng: () => 0,
    };
    // Occupy all 4 slots with blocked fetches (distinct keys: no coalescing).
    const holders = [0, 1, 2, 3].map((i) => decide(`gate-holder-${i}`, undefined, holderDeps));
    while (calls < 4) await new Promise<void>((r) => setTimeout(r, 5));
    assert.equal(_inflightActive(), 4, "all gate slots must be held");
    // Victim with a 50ms budget: acquire spins (10ms slices) to expiry.
    const victimDeps = {
      fetchImpl: async () => {
        calls++;
        return okJson({ expert: "coder" });
      },
      token: "tok-test",
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      rng: () => 0,
      deadline: t + 50,
    };
    const r = await decide("gate-timeout-victim", undefined, victimDeps);
    assert.equal(r, NO_REQUEST_MADE);
    assert.equal(calls, 4, "a timed-out acquire must make zero new fetches");
    release();
    const hs = await Promise.all(holders);
    for (const h of hs) assert.ok(!h.startsWith(FALLBACK_PREFIX), `holders must succeed: ${h.slice(0, 80)}`);
    assert.equal(_inflightActive(), 0);
  });

  test("inherited past deadline falls back with zero fetches (unit)", async () => {
    fresh();
    let t = 61_000_000;
    let calls = 0;
    const deps = {
      fetchImpl: async () => {
        calls++;
        return okJson({ expert: "coder" });
      },
      token: "tok-test",
      now: () => t,
      sleep: async (_ms: number) => {},
      rng: () => 0,
      deadline: t,
    };
    const r = await decide("past-deadline-state", undefined, deps);
    assert.equal(r, NO_REQUEST_MADE);
    assert.equal(calls, 0);
  });

  test("tighter inherited deadline shortens the retry loop and keeps the observed error", async () => {
    fresh();
    let t = 62_000_000;
    let calls = 0;
    const deps = {
      fetchImpl: async () => {
        calls++;
        t += 6000; // first attempt burns past the inherited deadline
        return statusResp(503);
      },
      token: "tok-test",
      now: () => t,
      sleep: async (_ms: number) => {},
      rng: () => 0,
      deadline: t + 5000,
    };
    const r = await decide("tight-deadline-state", undefined, deps);
    assert.equal(calls, 1, "inherited deadline must stop the loop after one attempt");
    assert.ok(r.startsWith(FALLBACK_PREFIX));
    assert.ok(r.includes("503"), `deadline break must keep the observed status: ${r.slice(0, 80)}`);
  });
});

describe("per-tool-call request cap (12): retry storms degrade per-entry", () => {
  test("batch(8) over a 503 storm: exactly 12 fetches, cap text on late entries", async () => {
    fresh();
    const t = 63_000_000;
    let calls = 0;
    const deps = {
      fetchImpl: async () => {
        calls++;
        return statusResp(503);
      },
      token: "tok-test",
      now: () => t,
      sleep: async (_ms: number) => {},
      rng: () => 0,
    };
    const text = await decideBatch(
      Array.from({ length: 8 }, (_, i) => ({ state: `storm-task-${i}` })),
      deps,
    );
    assert.ok(!text.startsWith(FALLBACK_PREFIX), "batch-level shape is fine: partial success, not wholesale fallback");
    const p = JSON.parse(text) as { results: string[]; summary: Record<string, number> };
    assert.deepEqual(p.summary, { total: 8, ok: 0, fallback: 8, cached: 0 });
    assert.equal(calls, MAX_REQUESTS_PER_CALL, `storm must stop at the cap (got ${calls})`);
    let sawCap = 0;
    let saw503 = 0;
    for (const r of p.results) {
      assert.ok(r.startsWith(FALLBACK_PREFIX));
      if (r.includes("request cap exceeded")) {
        sawCap++;
        assert.ok(r.includes("12"), `cap text names the cap: ${r.slice(0, 100)}`);
      }
      if (r.includes("503")) saw503++;
    }
    assert.ok(sawCap >= 1, "late entries must carry the cap text");
    assert.ok(saw503 >= 1, "early entries must keep their observed 503 detail");
    assert.equal(_inflightActive(), 0);
  });
});

describe("F4 gate underflow counter: extra releases are counted, never silent", () => {
  test("release past 0 clamps but increments underflows; clear resets", async () => {
    fresh();
    assert.deepEqual(_gateStats(), { active: 0, queued: 0, underflows: 0 });
    releaseInflight();
    assert.equal(_inflightActive(), 0, "clamp preserved: active never goes negative");
    assert.equal(_gateStats().underflows, 1, "unbalanced release must be counted, not silent");
    releaseInflight();
    assert.equal(_gateStats().underflows, 2);
    // Balanced traffic leaves the counter alone.
    const now = () => 0;
    const sleep = async (_ms: number) => {};
    await withEnv({ JEV_MAX_INFLIGHT: "1" }, async () => {
      assert.equal(await acquireInflight(1000, now, sleep), true);
      releaseInflight();
      assert.equal(_gateStats().underflows, 2, "paired acquire/release must not count as underflow");
      assert.equal(_inflightActive(), 0);
    });
    fresh();
    assert.deepEqual(_gateStats(), { active: 0, queued: 0, underflows: 0 }, "clear resets the counter");
  });
});

describe("F5+F3 budget bounds: hanging bearer + frozen-clock gate (offline — injected seams only)", () => {
  test("F5: hanging opted-in readToken times out to the budget-exhausted text with zero fetches", async () => {
    fresh();
    await withEnv({ JEV_BEARER: "1", JEV_MAX_INFLIGHT: undefined }, async () => {
      let t = 70_000_000;
      let calls = 0;
      const deps = {
        fetchImpl: async () => {
          calls++;
          return okJson({ expert: "coder" });
        },
        // Hanging resolver: never settles, so the bearer wait must be cut by
        // the remaining budget (deadline t+50, sleep advances the fake clock).
        readToken: async (): Promise<string> => {
          await new Promise<void>(() => {});
          return "never";
        },
        now: () => t,
        sleep: async (ms: number) => {
          t += ms;
        },
        rng: () => 0,
        deadline: t + 50,
      };
      const wall0 = Date.now();
      const r = await decide("f5-bearer-hang-state", undefined, deps);
      assert.equal(r, NO_REQUEST_MADE, `hanging bearer must yield the budget text: ${r.slice(0, 80)}`);
      assert.equal(calls, 0, "a bearer timeout must make zero fetches");
      assert.ok(Date.now() - wall0 < 5000, "hanging bearer must not hang past the budget");
      assert.equal(_inflightActive(), 0);
    });
    fresh();
  });

  test("F3: frozen clock + saturated gate terminates (bounded polls, FIFO preserved)", async () => {
    fresh();
    await withEnv({ JEV_MAX_INFLIGHT: "1" }, async () => {
      const frozenNow = () => 0;
      const nopSleep = async (_ms: number) => {};
      // Occupy the single slot.
      assert.equal(await acquireInflight(1000, frozenNow, nopSleep), true);
      assert.equal(_inflightActive(), 1);
      // Saturated + frozen: remaining never drops, slot never frees. Must
      // still return false quickly via the bounded poll cap (same false the
      // deadline path returns, so decide keeps the no-request-made text).
      const wall0 = Date.now();
      const r = await acquireInflight(1000, frozenNow, nopSleep);
      assert.equal(r, false);
      assert.ok(Date.now() - wall0 < 5000, "frozen-clock saturated acquire must terminate");
      // FIFO preserved: the timed-out ticket was removed, so after release a
      // fresh waiter can still acquire.
      releaseInflight();
      assert.equal(_inflightActive(), 0);
      assert.equal(await acquireInflight(1000, frozenNow, nopSleep), true);
      releaseInflight();
      assert.equal(_inflightActive(), 0);
    });
    fresh();
  });
});
