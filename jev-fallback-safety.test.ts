// jev fallback-safety harness — covers the safety-fix batch (offline only).
//
// WHAT: fallback `destructive_hint:true` suffix (runWithContext funnel),
// serializeState shrink floor, `decide.gate.done` audit logs, tightened
// extractScore, bearer-wait vestige removal, and the deterministic truncation
// property sweep (state lengths 0..9000 x key counts 1..300).
//
// Offline only (injected fetch + fake clock + captured stderr); no test hits
// the network. Conventions mirror jev-core.test.ts: unique state per case,
// token seam (no filesystem/auth touch), injected now/sleep/rng.
//
//     node --test jev-fallback-safety.test.ts
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_VALUE_TRUNCATION_MARKER,
  MAX_CONTEXT_VALUE_CHARS,
  MAX_STATE_CHARS,
  TRUNCATION_MARKER,
  _clearBearerCache,
  _clearJevCache,
  decide,
  decideWithContext,
  destructiveHint,
  extractScore,
  serializeState,
} from "./jev-core.ts";

const FALLBACK_PREFIX = "fallback:true | ";
const HINT_SUFFIX = " | destructive_hint:true";
const INVALID_QUESTIONS_PREFIX =
  "fallback:true | invalid questions shape: questions must be a plain object map keyed by question name, not an array";

describe("fallback destructive_hint suffix (runWithContext single funnel, offline)", () => {
  let t: number;
  const now = () => t;
  const zeroRng = () => 0;
  const noSleep = async (_ms: number) => {};
  const badQuestions = { fetchImpl: async () => assert.fail("no fetch on shape error") } as never;

  test("destructive state + local fallback gains exactly one suffix", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 60_000_000;
    const r = await decideWithContext(
      "safety-suffix-state rm -rf /tmp/cache",
      undefined,
      [],
      { fetchImpl: badQuestions.fetchImpl, token: "tok-test", now, sleep: noSleep, rng: zeroRng },
    );
    assert.equal(r, `${INVALID_QUESTIONS_PREFIX}${HINT_SUFFIX}`);
    assert.equal(r.split("destructive_hint:true").length - 1, 1, "suffix must appear exactly once");
  });

  test("benign state + same fallback stays byte-identical (no suffix)", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 60_000_001;
    const r = await decideWithContext(
      "safety-suffix-benign-state refactor the auth module",
      undefined,
      [],
      { fetchImpl: badQuestions.fetchImpl, token: "tok-test", now, sleep: noSleep, rng: zeroRng },
    );
    assert.equal(r, INVALID_QUESTIONS_PREFIX);
    assert.ok(!r.includes("destructive_hint"), "benign fallback must not mention the hint");
  });

  test("context-carried destructive shape suffixes the fallback too", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 60_000_002;
    const r = await decideWithContext(undefined, { script: "rm -rf /tmp/cache" }, [], {
      fetchImpl: badQuestions.fetchImpl,
      token: "tok-test",
      now,
      sleep: noSleep,
      rng: zeroRng,
    });
    assert.equal(r, `${INVALID_QUESTIONS_PREFIX}${HINT_SUFFIX}`);
  });

  test("invalid-variants path with destructive base gains the suffix", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 60_000_003;
    const r = await decideWithContext(
      "safety-suffix-variants-state DROP TABLE users",
      undefined,
      undefined,
      { token: "tok-test", now, sleep: noSleep, rng: zeroRng },
      [],
    );
    assert.ok(r.startsWith(FALLBACK_PREFIX));
    assert.ok(r.endsWith(HINT_SUFFIX), r.slice(-80));
  });

  test("upstream-error fallback through the funnel gains the suffix (401, destructive)", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 60_000_004;
    const r = await decideWithContext("safety-suffix-401-state rm -rf /tmp/x", undefined, undefined, {
      fetchImpl: async () => new Response("nope", { status: 401 }),
      token: "tok-test",
      now,
      sleep: noSleep,
      rng: zeroRng,
    });
    assert.equal(r, `fallback:true | HTTP 401: nope${HINT_SUFFIX}`);
  });

  test("upstream-error fallback stays byte-identical when benign (401)", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 60_000_005;
    const r = await decideWithContext("safety-suffix-401-benign-state refactor auth", undefined, undefined, {
      fetchImpl: async () => new Response("nope", { status: 401 }),
      token: "tok-test",
      now,
      sleep: noSleep,
      rng: zeroRng,
    });
    assert.equal(r, "fallback:true | HTTP 401: nope");
  });

  test("success path untouched: envelope keeps _jev.destructive_hint, no suffix text", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 60_000_006;
    const r = await decideWithContext("safety-suffix-ok-state rm -rf /tmp/x", undefined, undefined, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ expert: "coder" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      token: "tok-test",
      now,
      sleep: noSleep,
      rng: zeroRng,
    });
    assert.ok(!r.startsWith(FALLBACK_PREFIX));
    assert.ok(!r.includes(HINT_SUFFIX), "success envelope must not carry the fallback suffix text");
    assert.equal((JSON.parse(r) as any)._jev.destructive_hint, true);
  });
});

describe("extractScore tight match (exact score or snake_case *_score only)", () => {
  test("pins the tightened contract", () => {
    assert.equal(extractScore({ score: 1 }), 1);
    assert.equal(extractScore({ final_score: 2 }), 2);
    assert.equal(extractScore({ A_SCORE: 10 }), 10);
    assert.equal(extractScore({ SCore: 9 }), 9);
    assert.equal(extractScore({ needs_review: { score: 1.7 } }), 1.7);
    assert.equal(extractScore({ a: { score: 6 } }), 6);
    assert.equal(extractScore({ a: { final_score: 7 } }), 7);
    assert.equal(extractScore({ scores: 3 }), undefined);
    assert.equal(extractScore({ scoreValue: 5 }), undefined);
    assert.equal(extractScore({ myScore: 4 }), undefined);
    assert.equal(extractScore({ rescore: 5 }), undefined);
    assert.equal(extractScore({ a: { scores: 8 } }), undefined);
    assert.equal(extractScore({ confidence: 0.9 }), undefined);
    assert.equal(extractScore({ noul: 0.05 }), undefined);
    assert.equal(extractScore({ usage: { input_tokens: 1, output_tokens: 2 } }), undefined);
    assert.equal(extractScore(42), 42);
    assert.equal(extractScore("x"), undefined);
  });
});

describe("decide.gate.done audit logs (booleans only, offline)", () => {
  function captureErr() {
    const orig = process.stderr.write;
    const chunks: string[] = [];
    (process.stderr as any).write = (chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    };
    return {
      chunks,
      restore() {
        process.stderr.write = orig;
      },
    };
  }

  test("success envelope emits one gate line with boolean fields and no state leak", async () => {
    _clearJevCache();
    _clearBearerCache();
    const prev = process.env.JEV_LOG;
    process.env.JEV_LOG = "debug";
    const cap = captureErr();
    try {
      const t = 61_000_000;
      const state = "gate-audit-benign-state-xyz123";
      const r = await decide(state, undefined, {
        fetchImpl: async () =>
          new Response(JSON.stringify({ expert: "coder" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        token: "tok-test",
        now: () => t,
        sleep: async (_ms: number) => {},
        rng: () => 0,
      });
      assert.ok(!r.startsWith(FALLBACK_PREFIX));
      const gates = cap.chunks
        .map((c) => {
          try {
            return JSON.parse(c) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((p) => p !== null && p.event === "decide.gate.done");
      assert.equal(gates.length, 1, `expected one gate line, saw ${gates.length}`);
      const g = gates[0];
      assert.equal(typeof g.hint, "boolean");
      assert.equal(typeof g.bucket, "boolean");
      assert.equal(typeof g.gate, "boolean");
      assert.equal(g.hint, false);
      assert.equal(g.gate, false);
      assert.ok(!JSON.stringify(g).includes("xyz123"), "gate log must never carry caller state");
    } finally {
      cap.restore();
      if (prev === undefined) delete process.env.JEV_LOG;
      else process.env.JEV_LOG = prev;
    }
  });

  test("destructive high-score envelope logs hint/bucket/gate true (booleans)", async () => {
    _clearJevCache();
    _clearBearerCache();
    const prev = process.env.JEV_LOG;
    process.env.JEV_LOG = "debug";
    const cap = captureErr();
    try {
      const t = 61_000_001;
      const body = JSON.stringify({
        model: "jev-1.13-free",
        answers: { needs_review: { type: "score", score: 2.9, confidence: 1 } },
      });
      const r = await decide("gate-audit-destructive-state rm -rf /tmp/x", undefined, {
        fetchImpl: async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
        token: "tok-test",
        now: () => t,
        sleep: async (_ms: number) => {},
        rng: () => 0,
      });
      assert.ok(!r.startsWith(FALLBACK_PREFIX));
      const gates = cap.chunks
        .map((c) => {
          try {
            return JSON.parse(c) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((p) => p !== null && p.event === "decide.gate.done");
      assert.equal(gates.length, 1);
      assert.deepEqual(
        { hint: gates[0].hint, bucket: gates[0].bucket, gate: gates[0].gate },
        { hint: true, bucket: true, gate: true },
      );
    } finally {
      cap.restore();
      if (prev === undefined) delete process.env.JEV_LOG;
      else process.env.JEV_LOG = prev;
    }
  });

  test("consensus path emits a gate line (median high trips the gate)", async () => {
    _clearJevCache();
    _clearBearerCache();
    const prev = process.env.JEV_LOG;
    process.env.JEV_LOG = "debug";
    const cap = captureErr();
    try {
      const t = 61_000_002;
      const body = JSON.stringify({ score: 2.5 });
      const r = await decide(
        "gate-audit-consensus-base-state",
        undefined,
        {
          fetchImpl: async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
          token: "tok-test",
          now: () => t,
          sleep: async (_ms: number) => {},
          rng: () => 0,
        },
        ["gate consensus variant one", "gate consensus variant two"],
      );
      assert.ok(!r.startsWith(FALLBACK_PREFIX));
      const gates = cap.chunks
        .map((c) => {
          try {
            return JSON.parse(c) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((p) => p !== null && p.event === "decide.gate.done");
      assert.ok(gates.length >= 1, "consensus must emit at least one gate line");
      for (const g of gates) {
        assert.equal(typeof g.hint, "boolean");
        assert.equal(typeof g.bucket, "boolean");
        assert.equal(typeof g.gate, "boolean");
      }
      assert.ok(
        gates.some((g) => g.gate === true),
        "median-high consensus must log gate:true",
      );
    } finally {
      cap.restore();
      if (prev === undefined) delete process.env.JEV_LOG;
      else process.env.JEV_LOG = prev;
    }
  });
});

describe("bearer-wait timeout (vestige-free loop, offline)", () => {
  test("hanging readToken still falls back with zero fetches", async () => {
    _clearJevCache();
    _clearBearerCache();
    const prevBearer = process.env.JEV_BEARER;
    process.env.JEV_BEARER = "1";
    try {
      const t = 62_000_000;
      let calls = 0;
      const r = await decide("vestige-bearer-timeout-state", undefined, {
        fetchImpl: async () => {
          calls++;
          return new Response("{}", { status: 200 });
        },
        readToken: () => new Promise<string>(() => {}),
        now: () => t,
        sleep: async (_ms: number) => {},
        rng: () => 0,
        deadline: t + 50,
      });
      assert.equal(calls, 0, "a timed-out bearer wait must issue zero fetches");
      assert.equal(r, "fallback:true | budget exhausted before any attempt (no request was made)");
    } finally {
      if (prevBearer === undefined) delete process.env.JEV_BEARER;
      else process.env.JEV_BEARER = prevBearer;
    }
  });
});

describe("truncation property sweep (deterministic, no deps)", () => {
  const HEADER_LEN = "Context:\n".length;

  test("lengths 0..9000 x keys 1..300: capped, exact at cap when over, every key survives", () => {
    assert.ok(MAX_CONTEXT_VALUE_CHARS > CONTEXT_VALUE_TRUNCATION_MARKER.length);
    // 10-char values render single-line at 12 chars — far under the per-value
    // cap — so even 300 keys fit the final cap once the state head is cut:
    // the whole cartesian stays in the regime where the code guarantees every
    // key survives, which is exactly what this sweep pins.
    const value = "v".repeat(10);
    const cappedValueLen = Math.min(JSON.stringify(value).length, MAX_CONTEXT_VALUE_CHARS);
    const lineLen = (key: string) => 2 + JSON.stringify(key).length + 2 + cappedValueLen;
    const stateLens = [0, 7, 999, 4000, 7999, 8000, 8001, 9000];
    for (let keys = 1; keys <= 300; keys++) {
      const ctx: Record<string, string> = {};
      let linesLen = 0;
      for (let i = 0; i < keys; i++) {
        const k = `k${i}`;
        ctx[k] = value;
        linesLen += lineLen(k);
      }
      const naiveBody = HEADER_LEN + linesLen + (keys - 1);
      for (const sl of stateLens) {
        const prefixLen = sl > 0 ? sl + 1 : 0;
        const overCap = prefixLen + naiveBody > MAX_STATE_CHARS;
        const out = serializeState("s".repeat(sl), ctx);
        assert.ok(out.length <= MAX_STATE_CHARS, `keys=${keys} len=${sl}: out ${out.length} exceeds cap`);
        if (overCap) {
          assert.equal(out.length, MAX_STATE_CHARS, `keys=${keys} len=${sl}: over-cap output must land exactly on the cap`);
        }
        for (let i = 0; i < keys; i++) {
          assert.ok(out.includes(JSON.stringify(`k${i}`)), `keys=${keys} len=${sl}: key k${i} was dropped`);
        }
      }
    }
  });

  test("large values exercise the longest-first shrink (survival only where keys-alone fit)", () => {
    // 500-char values force the shrink loop whenever the assembly overflows.
    // Keys survive every path EXCEPT the documented pathological hard slice
    // (keys-alone, even at one full marker each, exceed the cap — pigeonhole,
    // no implementation can fit those). That boundary is computed below and
    // asserted conditionally; length invariants hold unconditionally.
    const value = "v".repeat(500);
    const cappedValueLen = Math.min(JSON.stringify(value).length, MAX_CONTEXT_VALUE_CHARS);
    const minimalValueLen = CONTEXT_VALUE_TRUNCATION_MARKER.length;
    const lineLen = (key: string, vLen: number) => 2 + JSON.stringify(key).length + 2 + vLen;
    for (let keys = 1; keys <= 300; keys++) {
      const ctx: Record<string, string> = {};
      let linesLen = 0;
      let minimalLinesLen = 0;
      for (let i = 0; i < keys; i++) {
        const k = `L${i}`;
        ctx[k] = value;
        linesLen += lineLen(k, cappedValueLen);
        minimalLinesLen += lineLen(k, minimalValueLen);
      }
      const naiveBody = HEADER_LEN + linesLen + (keys - 1);
      const minimalBody = HEADER_LEN + minimalLinesLen + (keys - 1);
      for (const sl of [0, 1000, 9000]) {
        const prefixLen = sl > 0 ? sl + 1 : 0;
        const overCap = prefixLen + naiveBody > MAX_STATE_CHARS;
        // Keys survive iff the minimal assembly fits (state head is cut, keys
        // never are); otherwise the last-resort hard slice may cut anything.
        const keysFittable = minimalBody + (sl > 0 ? 1 + TRUNCATION_MARKER.length : 0) <= MAX_STATE_CHARS;
        const out = serializeState("s".repeat(sl), ctx);
        assert.ok(out.length <= MAX_STATE_CHARS, `keys=${keys} len=${sl}: out ${out.length} exceeds cap`);
        if (overCap) {
          assert.equal(out.length, MAX_STATE_CHARS, `keys=${keys} len=${sl}: over-cap must land exactly on the cap`);
        }
        if (keysFittable) {
          for (let i = 0; i < keys; i++) {
            assert.ok(out.includes(JSON.stringify(`L${i}`)), `keys=${keys} len=${sl}: key L${i} was dropped`);
          }
        }
      }
    }
  });

  test("dense state-length sweep 0..9000 (representative key counts)", () => {
    // Short key names so keys-alone always fit (see sweep 1 regime).
    for (const keys of [1, 2, 3, 100, 299, 300]) {
      const ctx: Record<string, string> = {};
      for (let i = 0; i < keys; i++) ctx[`q${i}`] = "w".repeat(10);
      for (let sl = 0; sl <= 9000; sl += 100) {
        const out = serializeState("s".repeat(sl), ctx);
        assert.ok(out.length <= MAX_STATE_CHARS, `keys=${keys} len=${sl}: out ${out.length} exceeds cap`);
        for (let i = 0; i < keys; i++) {
          assert.ok(out.includes(JSON.stringify(`q${i}`)), `keys=${keys} len=${sl}: key q${i} dropped`);
        }
      }
      // Pin the exact-cap landing on one clearly over-cap point per key count.
      const big = serializeState("s".repeat(9000), ctx);
      assert.equal(big.length, MAX_STATE_CHARS, `keys=${keys}: over-cap must land exactly on the cap`);
    }
    assert.ok(destructiveHint("safety sweep sanity: rm -rf /tmp/x"));
  });
});

describe("empty-200 guard ({} falls back, noul-only succeeds, offline)", () => {
  test("200 with a {} body falls back as empty upstream (nothing cached)", async () => {
    _clearJevCache();
    _clearBearerCache();
    const t = 63_000_000;
    let calls = 0;
    const r = await decide("empty-200-guard-state", undefined, {
      fetchImpl: async () => {
        calls++;
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
      token: "tok-test",
      now: () => t,
      sleep: async (_ms: number) => {},
      rng: () => 0,
    });
    assert.equal(calls, 1);
    assert.equal(r, "fallback:true | empty upstream response");
  });

  test("200 with noul-only answers succeeds: extractAnswers is non-empty", async () => {
    _clearJevCache();
    _clearBearerCache();
    const t = 63_000_001;
    const body = JSON.stringify({ answers: { probe: { type: "noul", noul: 0.7 } } });
    const r = await decide("empty-200-noul-legit-state", undefined, {
      fetchImpl: async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      token: "tok-test",
      now: () => t,
      sleep: async (_ms: number) => {},
      rng: () => 0,
    });
    assert.ok(!r.startsWith(FALLBACK_PREFIX), r.slice(0, 120));
    assert.equal((JSON.parse(r) as any)._jev.answers.probe.type, "noul");
  });
});
