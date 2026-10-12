// jev live-golden contract tests — Node builtin test runner, no new deps.
//
// WHY THIS FILE EXISTS: the `bucket` feature once broke in production while
// all 59 synthetic-fixture tests stayed green, because every fixture was
// hand-written and the real upstream payload nests its score at
// `answers.needs_review.score`. Only real endpoint traffic caught it. These
// tests ground the suite in REAL captured responses, so upstream shape drift
// FAILS TESTS instead of silently shipping.
//
// CAPTURE INFO: captured 2026-10-12 against jev-1.13-free; re-run
// `node capture-goldens.mjs` to re-capture when the contract test fails.
// That script hits the LIVE network endpoint and overwrites jev-goldens.json.
// These tests NEVER hit the network: they feed the captured bodies in through
// the injected `fetch` seam (deps.fetchImpl).
//
// HOW TO RUN (from this directory):
//     node --test                          # runs BOTH test files (this + jev-core.test.ts), offline
//     node --test jev-goldens.test.ts      # this file alone, offline
//     node capture-goldens.mjs             # RE-CAPTURE from live (network!) when the contract test fails
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ADVISORY_TEXT,
  LOW_CONFIDENCE_THRESHOLD,
  _clearBearerCache,
  _clearJevCache,
  decide,
  defaultQuestions,
  extractAnswers,
  extractScore,
  isLowConfidence,
  riskQuestions,
} from "./jev-core.ts";

interface GoldenCase {
  status: number;
  state: string;
  body: any;
}

const GOLDENS = JSON.parse(
  readFileSync(new URL("./jev-goldens.json", import.meta.url), "utf8"),
) as Record<string, GoldenCase>;

// The exact questions each golden was captured with (see capture-goldens.mjs).
// decide() validates questions before any fetch, so these must be valid shapes.
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

const T_NOW = 50_000_000;

// Feeds one captured body through the REAL decide() pipeline (no network).
async function runGolden(name: string): Promise<{ golden: GoldenCase; parsed: any }> {
  _clearJevCache();
  _clearBearerCache();
  const golden = GOLDENS[name];
  assert.ok(golden, `golden case "${name}" missing from jev-goldens.json`);
  const bodyText = JSON.stringify(golden.body);
  const text = await decide(golden.state, QUESTIONS[name], {
    fetchImpl: async () =>
      new Response(bodyText, { status: 200, headers: { "content-type": "application/json" } }),
    token: "tok-test",
    now: () => T_NOW,
    sleep: async (_ms: number) => {},
    rng: () => 0,
  });
  assert.ok(
    !text.startsWith("fallback:true"),
    `${name}: pipeline fell back instead of handling the real shape: ${text.slice(0, 120)}`,
  );
  return { golden, parsed: JSON.parse(text) as any };
}

describe("golden fixtures: real captured shapes through the pipeline (no network)", () => {
  test("route_expert_simple: expert coder, score 2.56, bucket high", async () => {
    const { parsed } = await runGolden("route_expert_simple");
    assert.equal(parsed.answers.expert.choice, "coder");
    assert.equal(extractScore(parsed), 2.56, "nested answers.needs_review.score must be found");
    assert.equal(parsed.bucket, "high");
  });

  test("assess_risk_only: score 2.99 -> bucket high", async () => {
    const { parsed } = await runGolden("assess_risk_only");
    assert.equal(extractScore(parsed), 2.99);
    assert.equal(parsed.bucket, "high");
  });

  test("choice_only: expert coder, NO score -> bucket must be ABSENT", async () => {
    const { parsed } = await runGolden("choice_only");
    assert.equal(parsed.answers.expert.choice, "coder");
    assert.equal(extractScore(parsed), undefined, "a choice-only payload has no score to extract");
    assert.equal(
      "bucket" in parsed,
      false,
      `bucket must be absent (not null, not "") when there is no score; got ${JSON.stringify(parsed.bucket)}`,
    );
  });

  test("noul_type: {type:noul, noul:0.05} must not crash, invent a bucket, or read noul as a score", async () => {
    const { parsed } = await runGolden("noul_type");
    assert.equal(parsed.answers.verdict.type, "noul");
    assert.equal(parsed.answers.verdict.noul, 0.05);
    assert.ok(!("score" in parsed.answers.verdict), "noul answer must carry no score field");
    assert.ok(!("choice" in parsed.answers.verdict), "noul answer must carry no choice field");
    assert.equal(extractScore(parsed), undefined, "noul:0.05 must NOT be mistaken for a score");
    assert.equal("bucket" in parsed, false, "no score means no bucket — never invent one");
    assert.ok(parsed._jev, "noul payloads still get a valid envelope");
  });

  test("destructive_state: rm -rf state sets _jev.destructive_hint", async () => {
    const { golden, parsed } = await runGolden("destructive_state");
    assert.ok(golden.state.includes("rm -rf"), "golden precondition: the captured state is destructive");
    assert.equal(parsed._jev.destructive_hint, true);
  });

  test("ALL goldens: envelope always carries _jev{format,cached,attempts,latency_ms,advisory}", async () => {
    for (const name of Object.keys(GOLDENS)) {
      const { parsed } = await runGolden(name);
      assert.equal(typeof parsed._jev, "object", `${name}: missing _jev envelope`);
      assert.equal(parsed._jev.format, 1, `${name}: _jev.format`);
      assert.ok("cached" in parsed._jev, `${name}: _jev.cached`);
      assert.ok("attempts" in parsed._jev, `${name}: _jev.attempts`);
      assert.equal(typeof parsed._jev.latency_ms, "number", `${name}: _jev.latency_ms`);
      assert.equal(parsed._jev.advisory, ADVISORY_TEXT, `${name}: advisory text on EVERY response`);
    }
  });

  test("ALL goldens: upstream keys survive at root (model, answers, usage)", async () => {
    for (const name of Object.keys(GOLDENS)) {
      const { golden, parsed } = await runGolden(name);
      assert.equal(parsed.model, golden.body.model, `${name}: model`);
      assert.deepEqual(parsed.answers, golden.body.answers, `${name}: answers`);
      assert.deepEqual(parsed.usage, golden.body.usage, `${name}: usage`);
    }
  });
});

describe("_jev.answers + low_confidence (per-answer confidence, probabilities, noul)", () => {
  test("route_expert_simple: choice + score surfaced, low_confidence false (0.56 >= 0.5)", async () => {
    const { parsed } = await runGolden("route_expert_simple");
    assert.equal(parsed._jev.answers.expert.type, "choice");
    assert.equal(parsed._jev.answers.expert.choice, "coder");
    assert.equal(parsed._jev.answers.expert.confidence, 1);
    assert.deepEqual(parsed._jev.answers.expert.probabilities, { planner: 0, coder: 1, reviewer: 0 });
    assert.equal(parsed._jev.answers.needs_review.type, "score");
    assert.equal(parsed._jev.answers.needs_review.score, 2.56);
    assert.equal(parsed._jev.answers.needs_review.confidence, 0.56);
    assert.deepEqual(parsed._jev.answers.needs_review.probabilities, { "0": 0, "1": 0.03, "2": 0.38, "3": 0.59 });
    assert.equal(parsed._jev.answers.needs_review.bucket, "high");
    assert.equal(parsed._jev.low_confidence, false);
  });

  test("assess_risk_only: confidence 1 -> low_confidence false", async () => {
    const { parsed } = await runGolden("assess_risk_only");
    assert.equal(parsed._jev.answers.needs_review.score, 2.99);
    assert.equal(parsed._jev.answers.needs_review.confidence, 1);
    assert.equal(parsed._jev.answers.needs_review.bucket, "high");
    assert.equal(parsed._jev.low_confidence, false);
  });

  test("choice_only: choice extracted; needs_review ABSENT from _jev.answers (no invented score)", async () => {
    const { parsed } = await runGolden("choice_only");
    assert.equal(parsed._jev.answers.expert.choice, "coder");
    assert.equal(parsed._jev.answers.expert.confidence, 1);
    assert.ok(!("needs_review" in parsed._jev.answers), "choice-only payload must not invent a needs_review summary");
    assert.equal(parsed._jev.low_confidence, false);
  });

  test("noul_type: verdict carries noul 0.05 + bucket, no score/choice invented, no root bucket", async () => {
    const { parsed } = await runGolden("noul_type");
    assert.equal(parsed._jev.answers.verdict.type, "noul");
    assert.equal(parsed._jev.answers.verdict.noul, 0.05);
    assert.equal(parsed._jev.answers.verdict.bucket, "low", "noul floats bucket exactly like scores");
    assert.ok(!("score" in parsed._jev.answers.verdict), "must not invent a score");
    assert.ok(!("choice" in parsed._jev.answers.verdict), "must not invent a choice");
    assert.equal("bucket" in parsed, false, "root bucket stays absent when there is no score");
    assert.equal(parsed._jev.low_confidence, false, "noul carries no confidence, so nothing is low");
  });

  test("destructive_state: hint true AND score summary present (regression guard)", async () => {
    const { parsed } = await runGolden("destructive_state");
    assert.equal(parsed._jev.destructive_hint, true);
    assert.equal(parsed._jev.answers.needs_review.score, 2.97);
    assert.equal(parsed._jev.low_confidence, false);
  });

  test("synthetic: confidence 0.1 -> low_confidence true; exactly 0.5 pins the boundary (false)", async () => {
    assert.equal(LOW_CONFIDENCE_THRESHOLD, 0.5);
    const run = async (conf: number) => {
      _clearJevCache();
      _clearBearerCache();
      const body = JSON.stringify({
        model: "jev-1.13-free",
        answers: { needs_review: { type: "score", score: 2.0, confidence: conf, probabilities: { "2": 1 } } },
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      const text = await decide("synthetic confidence state", riskQuestions(), {
        fetchImpl: async () =>
          new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
        token: "tok-test",
        now: () => T_NOW,
        sleep: async (_ms: number) => {},
        rng: () => 0,
      });
      assert.ok(!text.startsWith("fallback:true"), `synthetic conf=${conf} must not fall back`);
      return JSON.parse(text) as any;
    };
    const low = await run(0.1);
    assert.equal(low._jev.answers.needs_review.confidence, 0.1);
    assert.equal(low._jev.low_confidence, true);
    const edge = await run(0.5);
    assert.equal(edge._jev.low_confidence, false, "confidence exactly at the threshold is NOT low (strict <)");
  });

  test("missing/malformed upstream degrades gracefully (never crashes, never invents)", async () => {
    // Pure-function level: null / {} / wrong shapes -> empty map, not low.
    assert.deepEqual(extractAnswers(null), {});
    assert.deepEqual(extractAnswers({}), {});
    assert.deepEqual(extractAnswers({ answers: null }), {});
    assert.deepEqual(extractAnswers({ answers: [] }), {});
    assert.deepEqual(extractAnswers({ answers: { q: null } }), { q: { type: "unknown" } });
    assert.deepEqual(extractAnswers({ answers: { q: { nonsense: 1 } } }), { q: { type: "unknown" } });
    assert.equal(isLowConfidence({}), false);
    assert.equal(isLowConfidence(null), false);
    // Pipeline level: an answers entry missing its type still envelopes.
    _clearJevCache();
    _clearBearerCache();
    const body = JSON.stringify({ model: "jev-1.13-free", answers: { weird: { confidence: 0.1 } }, usage: {} });
    const text = await decide("malformed answers state", defaultQuestions(), {
      fetchImpl: async () =>
        new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      token: "tok-test",
      now: () => T_NOW,
      sleep: async (_ms: number) => {},
      rng: () => 0,
    });
    assert.ok(!text.startsWith("fallback:true"), "malformed answers must envelope, not fall back");
    const parsed = JSON.parse(text) as any;
    assert.deepEqual(parsed._jev.answers.weird, { type: "unknown" });
    assert.equal(parsed._jev.low_confidence, false, "typeless entry carries no confidence to judge");
  });
});

describe("upstream shape contract (fails loudly when the endpoint moves)", () => {
  // WHEN THIS TEST FAILS, the upstream contract moved: re-capture with
  // `node capture-goldens.mjs`, then re-check extractScore() and the envelope
  // builder in jev-core.ts against the fresh capture before updating goldens.
  test("every answers.<name> honours the type invariants our code depends on", () => {
    assert.ok(Object.keys(GOLDENS).length >= 5, "expected at least the five captured cases");
    for (const [caseName, g] of Object.entries(GOLDENS)) {
      const answers = (g as GoldenCase).body?.answers;
      assert.ok(
        answers && typeof answers === "object" && !Array.isArray(answers),
        `${caseName}: body.answers must be an object map`,
      );
      for (const [qName, a] of Object.entries(answers as Record<string, any>)) {
        const where = `${caseName}.answers.${qName}`;
        assert.equal(typeof a?.type, "string", `${where}: every answer object has a type`);
        if (a.type === "choice") {
          assert.ok("choice" in a, `${where}: choice answers carry a choice field`);
          assert.ok(
            a.probabilities && typeof a.probabilities === "object",
            `${where}: choice answers carry probabilities`,
          );
        } else if (a.type === "score") {
          assert.equal(typeof a.score, "number", `${where}: score answers carry a numeric score`);
          assert.ok(a.legend && typeof a.legend === "object", `${where}: score answers carry a legend`);
          assert.ok(
            a.probabilities && typeof a.probabilities === "object",
            `${where}: score answers carry probabilities`,
          );
        } else if (a.type === "noul") {
          assert.equal(typeof a.noul, "number", `${where}: noul answers carry a numeric noul`);
          assert.ok(
            !("score" in a) && !("choice" in a),
            `${where}: noul answers carry NO score/choice fields`,
          );
        } else {
          assert.fail(`${where}: unknown answer type "${a.type}" — upstream added a type; teach the pipeline`);
        }
      }
    }
  });
});
