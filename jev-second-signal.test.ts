// jev needs_second_signal tests — Node builtin test runner, no new deps.
//
// Covers _jev.needs_second_signal in jev-core.ts: the single boolean callers
// gate on, consolidating hint + low confidence + high bucket. All offline:
// the network is replaced by the injected `fetch` seam (deps.fetchImpl),
// except where captured golden bodies from jev-goldens.json are fed through
// the REAL decide() pipeline (same technique as jev-goldens.test.ts).
// Run: node --test jev-second-signal.test.ts
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ADVISORY_TEXT,
  LOW_CONFIDENCE_THRESHOLD,
  _clearBearerCache,
  _clearJevCache,
  computeNeedsSecondSignal,
  decide,
  defaultQuestions,
  discoverPayload,
  isLowConfidence,
  riskQuestions,
} from "./jev-core.ts";

const GOLDENS = JSON.parse(
  readFileSync(new URL("./jev-goldens.json", import.meta.url), "utf8"),
) as Record<string, { status: number; state: string; body: any }>;

const QUESTIONS: Record<string, unknown> = {
  route_expert_simple: defaultQuestions(),
  assess_risk_only: riskQuestions(),
  choice_only: {
    expert: {
      type: "choice",
      instructions: "Which expert should handle this request?",
      criteria: { planner: "Planning", coder: "Implementation", reviewer: "Validation" },
    },
  },
  noul_type: {
    verdict: { type: "noul", instructions: "Any safety concern with this task?" },
  },
  destructive_state: riskQuestions(),
};

const T_NOW = 60_000_000;
const okJson = (v: unknown) =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

async function runGolden(name: string): Promise<any> {
  _clearJevCache();
  _clearBearerCache();
  const golden = GOLDENS[name];
  assert.ok(golden, `golden case "${name}" missing from jev-goldens.json`);
  const text = await decide(golden.state, QUESTIONS[name], {
    fetchImpl: async () => okJson(golden.body),
    token: "tok-test",
    now: () => T_NOW,
    sleep: async (_ms: number) => {},
    rng: () => 0,
  });
  assert.ok(!text.startsWith("fallback:true"), `${name} fell back: ${text.slice(0, 120)}`);
  return JSON.parse(text) as any;
}

async function runSynthetic(state: string, body: unknown, questions?: unknown): Promise<any> {
  _clearJevCache();
  _clearBearerCache();
  const text = await decide(state, questions ?? riskQuestions(), {
    fetchImpl: async () => okJson(body),
    token: "tok-test",
    now: () => T_NOW,
    sleep: async (_ms: number) => {},
    rng: () => 0,
  });
  assert.ok(!text.startsWith("fallback:true"), `synthetic must not fall back: ${text.slice(0, 120)}`);
  return JSON.parse(text) as any;
}

describe("computeNeedsSecondSignal truth table (pure function)", () => {
  test("hint-only true; low-confidence-only true; high-bucket-only true; all-false false", () => {
    assert.equal(computeNeedsSecondSignal({ hint: true, lowConfidence: false, bucket: "low" }), true);
    assert.equal(computeNeedsSecondSignal({ hint: false, lowConfidence: true, bucket: "low" }), true);
    assert.equal(computeNeedsSecondSignal({ hint: false, lowConfidence: false, bucket: "high" }), true);
    assert.equal(computeNeedsSecondSignal({ hint: false, lowConfidence: false, bucket: "low" }), false);
  });

  test("any combination with at least one signal is true (full 8-row table)", () => {
    const rows: Array<[{ hint: boolean; lowConfidence: boolean; bucket: string }, boolean]> = [
      [{ hint: false, lowConfidence: false, bucket: "low" }, false],
      [{ hint: false, lowConfidence: false, bucket: "medium" }, false],
      [{ hint: false, lowConfidence: false, bucket: "high" }, true],
      [{ hint: false, lowConfidence: true, bucket: "low" }, true],
      [{ hint: false, lowConfidence: true, bucket: "medium" }, true],
      [{ hint: false, lowConfidence: true, bucket: "high" }, true],
      [{ hint: true, lowConfidence: false, bucket: "low" }, true],
      [{ hint: true, lowConfidence: true, bucket: "high" }, true],
    ];
    for (const [input, want] of rows) {
      assert.equal(computeNeedsSecondSignal(input), want, JSON.stringify(input));
    }
    // Medium bucket alone is NOT a signal; missing/undefined inputs never throw.
    assert.equal(computeNeedsSecondSignal({ hint: false, lowConfidence: false, bucket: "medium" }), false);
    assert.equal(computeNeedsSecondSignal({ hint: false, lowConfidence: false, bucket: undefined }), false);
    assert.equal(computeNeedsSecondSignal({} as any), false);
  });

  test("strict equality: truthy non-true / non-high values do not trip it", () => {
    assert.equal(computeNeedsSecondSignal({ hint: 1 as any, lowConfidence: false, bucket: "low" }), false);
    assert.equal(computeNeedsSecondSignal({ hint: false, lowConfidence: 1 as any, bucket: "low" }), false);
    assert.equal(computeNeedsSecondSignal({ hint: false, lowConfidence: false, bucket: "HIGH" }), false);
    assert.equal(typeof computeNeedsSecondSignal({ hint: true, lowConfidence: false, bucket: "low" }), "boolean");
  });
});

describe("low-confidence boundary pins isLowConfidence semantics", () => {
  test("confidence exactly AT LOW_CONFIDENCE_THRESHOLD is NOT low", () => {
    assert.equal(LOW_CONFIDENCE_THRESHOLD, 0.5);
    assert.equal(isLowConfidence({ q: { type: "score", confidence: 0.5 } }), false);
    assert.equal(isLowConfidence({ q: { type: "score", confidence: 0.4999 } }), true);
    assert.equal(isLowConfidence({ q: { type: "score", confidence: 0.1 } }), true);
    assert.equal(
      computeNeedsSecondSignal({ hint: false, lowConfidence: isLowConfidence({ q: { confidence: 0.5 } }), bucket: "low" }),
      false,
      "boundary confidence must not trip the flag through lowConfidence",
    );
  });

  test("pipeline: synthetic confidence 0.5 -> low_confidence false; 0.1 -> true", async () => {
    const bodyFor = (conf: number) => ({
      model: "jev-1.13-free",
      answers: { needs_review: { type: "score", score: 1.0, confidence: conf, probabilities: { "1": 1 } } },
      usage: {},
    });
    const edge = await runSynthetic("synthetic boundary state", bodyFor(0.5));
    assert.equal(edge._jev.low_confidence, false);
    assert.equal(edge._jev.needs_second_signal, false, "low score + confident + no hint stays quiet");
    const low = await runSynthetic("synthetic boundary state", bodyFor(0.1));
    assert.equal(low._jev.low_confidence, true);
    assert.equal(low._jev.needs_second_signal, true, "low confidence alone trips the flag");
  });
});

describe("goldens through the real pipeline", () => {
  test("destructive_state golden MUST yield needs_second_signal true", async () => {
    const parsed = await runGolden("destructive_state");
    assert.equal(parsed._jev.destructive_hint, true);
    assert.equal(parsed._jev.needs_second_signal, true);
  });

  test("route_expert_simple golden yields needs_second_signal true (score 2.56/high, no hint, confident)", async () => {
    // DERIVED, not guessed: the captured body scores 2.56 -> root bucket high
    // with confidences 1 / 0.56 (both >= 0.5) and state "Add retry logic to
    // the billing worker" carries no destructive shape — so the flag is true
    // via the high-bucket arm alone.
    const parsed = await runGolden("route_expert_simple");
    assert.equal(parsed.bucket, "high");
    assert.equal(parsed._jev.destructive_hint, false);
    assert.equal(parsed._jev.low_confidence, false);
    assert.equal(parsed._jev.needs_second_signal, true);
  });

  test("measured medium-score destructive shape still trips the flag via the hint arm", async () => {
    // The entire point of the feature: "Delete every *.tmp file in the
    // workspace" measured 1.56/medium — the score says routine, the hint says
    // stop. The flag must be true even though the bucket is only medium.
    const parsed = await runSynthetic("Delete every *.tmp file in the workspace", {
      model: "jev-1.13-free",
      answers: { needs_review: { type: "score", score: 1.56, confidence: 0.9, probabilities: { "1": 1 } } },
    });
    assert.equal(parsed.bucket, "medium");
    assert.equal(parsed._jev.destructive_hint, true);
    assert.equal(parsed._jev.low_confidence, false);
    assert.equal(parsed._jev.needs_second_signal, true);
  });
});

describe("benign low-score case stays quiet", () => {
  test('a benign "add a log line" with a low model score does NOT trip the flag', async () => {
    // INTENT: the flag is an attention-director, not a hair-trigger. A routine
    // edit the model rates low with no destructive shape and confident answers
    // must stay quiet — otherwise every call gates and the flag trains callers
    // to ignore it. It trips only when the model itself rates high (or the
    // hint/low-confidence arms fire).
    const parsed = await runSynthetic("add a log line to the auth module", {
      model: "jev-1.13-free",
      answers: { needs_review: { type: "score", score: 0.5, confidence: 0.9, probabilities: { "0": 1 } } },
    });
    assert.equal(parsed.bucket, "low");
    assert.equal(parsed._jev.destructive_hint, false);
    assert.equal(parsed._jev.low_confidence, false);
    assert.equal(parsed._jev.needs_second_signal, false);
  });
});

describe("envelope shape regression guard", () => {
  test("_jev contains needs_second_signal and every previously-present field survives", async () => {
    const parsed = await runSynthetic("shape guard state", {
      model: "jev-1.13-free",
      answers: { needs_review: { type: "score", score: 1.5, confidence: 0.8, probabilities: { "1": 1 } } },
    });
    assert.equal(typeof parsed._jev, "object");
    for (const k of [
      "format",
      "cached",
      "cache_age_ms",
      "attempts",
      "latency_ms",
      "stale",
      "advisory",
      "destructive_hint",
      "answers",
      "low_confidence",
      "needs_second_signal",
    ]) {
      assert.ok(k in parsed._jev, `_jev.${k} must be present`);
    }
    assert.equal(parsed._jev.format, 1);
    assert.equal(parsed._jev.advisory, ADVISORY_TEXT);
    assert.equal(typeof parsed._jev.needs_second_signal, "boolean");
    // Root bucket semantics untouched: score-derived, upstream never overwritten.
    assert.equal(parsed.bucket, "medium");
  });

  test("discover documents needs_second_signal as the gate within budget, keys frozen", () => {
    const payload = discoverPayload() as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), [
      "answers_note",
      "auth_mode",
      "batch_note",
      "code_mode_note",
      "confidence_note",
      "context_note",
      "endpoint",
      "entry_shape",
      "examples",
      "model",
      "question_types",
      "recommended_usage",
      "response_envelope",
      "score_semantics",
      "timeout_ms",
      "untrusted_input_note",
      "warning_422",
    ]);
    assert.ok(
      String(payload.response_envelope).includes("needs_second_signal"),
      "response_envelope must name the flag",
    );
    assert.match(String(payload.recommended_usage), /gate on needs_second_signal/);
    assert.ok(JSON.stringify(payload).length <= 1400, "discover budget holds");
  });
});
