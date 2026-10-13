// jev multi-variant consensus tests — Node builtin test runner, no new deps.
//
// Covers the `variants` request field in jev-core.ts: the SAME questions asked
// against EACH caller-supplied phrasing, aggregated to a median consensus with
// per-variant detail preserved and bucket disagreement wired into
// needs_second_signal. All offline: the network is replaced by the injected
// `fetch` seam (deps.fetchImpl), which maps the request `state` back to a
// canned score so medians/spreads/buckets are exactly assertable.
// Run: node --test jev-consensus.test.ts
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  VARIANTS_MAX,
  _clearBearerCache,
  _clearJevCache,
  assessRisk,
  computeNeedsSecondSignal,
  decide,
  decideBatch,
  decideWithContext,
  medianScore,
  riskQuestions,
  validateVariants,
} from "./jev-core.ts";

const FALLBACK_PREFIX = "fallback:true | ";
const T_NOW = 70_000_000;

const okJson = (v: unknown) =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

// Score fixture: every answer is confident (0.9) so low_confidence never fires
// and only the disagreement arm / median bucket can trip the flag.
function scoreBody(score: number) {
  return {
    model: "jev-1.13-free",
    answers: { needs_review: { type: "score", score, confidence: 0.9, probabilities: { "1": 1 } } },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

// fetchImpl keyed on the request state: each variant string maps to its score.
// Unmapped states score 1.0 (medium). States here are benign prose so the
// deterministic destructive hint never fires.
function scoreDeps(scoreByState: Record<string, number>) {
  let calls = 0;
  const deps = {
    fetchImpl: async (_url: string, init?: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init?.body)) as { state: string };
      return okJson(scoreBody(scoreByState[body.state] ?? 1.0));
    },
    token: "tok-test",
    now: () => T_NOW,
    sleep: async (_ms: number) => {},
    rng: () => 0,
  };
  return { deps, calls: () => calls };
}

function fresh() {
  _clearJevCache();
  _clearBearerCache();
}

describe("validateVariants shape rules (no network)", () => {
  test("accepts 1..5 non-blank strings", () => {
    assert.equal(VARIANTS_MAX, 5);
    assert.equal(validateVariants(["a"]), null);
    assert.equal(validateVariants(["a", "b", "c", "d", "e"]), null);
  });

  test("rejects empty array, non-array, over-cap, non-string and blank entries", () => {
    assert.equal(typeof validateVariants([]), "string");
    for (const bad of ["nope", 42, null, undefined, {}, { state: "x" }]) {
      assert.equal(typeof validateVariants(bad as any), "string", JSON.stringify(bad));
    }
    assert.equal(typeof validateVariants(["a", "b", "c", "d", "e", "f"]), "string");
    assert.equal(typeof validateVariants(["ok", 42]), "string");
    assert.equal(typeof validateVariants(["ok", null]), "string");
    assert.equal(typeof validateVariants(["ok", "   "]), "string");
    assert.equal(typeof validateVariants([""]), "string");
  });
});

describe("medianScore helper pins (odd / even / empty / no-mutation)", () => {
  test("odd count takes the middle of the sorted values", () => {
    assert.equal(medianScore([3, 1, 2]), 2);
    assert.equal(medianScore([2.01, 1.31, 1.53, 0.85, 2.47]), 1.53);
  });

  test("EVEN-COUNT RULE: mean of the two middle values", () => {
    // Pinned by design (see medianScore comment): the standard statistical
    // median, biasing neither low (under-stating risk) nor high.
    assert.equal(medianScore([4, 1, 3, 2]), 2.5);
    assert.equal(medianScore([1.5, 0.5]), 1.0);
    assert.equal(medianScore([2.1, 2.0]), 2.05);
  });

  test("empty input yields undefined (never an invented zero)", () => {
    assert.equal(medianScore([]), undefined);
  });

  test("input order is never mutated", () => {
    const input = [3, 1, 2];
    medianScore(input);
    assert.deepEqual(input, [3, 1, 2]);
  });
});

describe("no variants => byte-identical envelope to today", () => {
  test("explicit undefined variants matches the historical call exactly", async () => {
    fresh();
    const { deps } = scoreDeps({});
    const r1 = await decide("byte-identical state", undefined, deps);
    assert.ok(!r1.startsWith(FALLBACK_PREFIX));
    fresh();
    const r2 = await decide("byte-identical state", undefined, deps, undefined);
    assert.equal(r2, r1, "variants===undefined must take the exact historical path");
    const p = JSON.parse(r2) as any;
    assert.ok(!("consensus" in p._jev), "single-state envelopes carry no consensus key");
  });

  test("decideWithContext without variants is unchanged (no consensus key)", async () => {
    fresh();
    const { deps } = scoreDeps({});
    const text = await decideWithContext("ctx-identical state", { files: ["a.ts"] }, riskQuestions(), deps);
    assert.ok(!text.startsWith(FALLBACK_PREFIX));
    assert.ok(!("consensus" in (JSON.parse(text) as any)._jev));
  });
});

describe("consensus over five variants with one outlier", () => {
  // The measured live shape: [2.01, 1.31, 1.53, 0.85, 2.47]. The median
  // (1.53) resists the 2.47 outlier; the mean (1.634) does not.
  const SCORES = { "c-var-1": 2.01, "c-var-2": 1.31, "c-var-3": 1.53, "c-var-4": 0.85, "c-var-5": 2.47 };
  const VARIANTS = Object.keys(SCORES);

  test("median is the middle value, NOT skewed by the outlier", async () => {
    fresh();
    const { deps, calls } = scoreDeps(SCORES);
    const text = await decide("consensus base task", riskQuestions(), deps, VARIANTS);
    assert.ok(!text.startsWith(FALLBACK_PREFIX), text.slice(0, 120));
    const p = JSON.parse(text) as any;
    assert.equal(calls(), 5, "five variants need five independent decisions");
    assert.equal(p._jev.consensus.n, 5);
    assert.equal(p._jev.consensus.median_score, 1.53);
    assert.equal(p._jev.consensus.median_bucket, "medium");
    assert.ok(Math.abs(p._jev.consensus.spread - 1.62) < 1e-9, `spread ${p._jev.consensus.spread}`);
    assert.equal(p._jev.consensus.buckets_agree, false);
    // Root bucket semantics intact: the median's bucket, same thresholds.
    assert.equal(p.bucket, "medium");
    assert.equal(p._jev.consensus.variants.length, 5);
    const got = p._jev.consensus.variants.map((v: any) => v.score).sort((a: number, b: number) => a - b);
    assert.deepEqual(got, [0.85, 1.31, 1.53, 2.01, 2.47]);
  });

  test("disagreement trips needs_second_signal even though the median is medium", async () => {
    fresh();
    const { deps } = scoreDeps(SCORES);
    const p = JSON.parse(await decide("consensus base task", riskQuestions(), deps, VARIANTS)) as any;
    assert.equal(p._jev.consensus.buckets_agree, false);
    assert.equal(p._jev.low_confidence, false, "fixtures are confident: only disagreement trips the flag");
    assert.equal(p._jev.destructive_hint, false);
    assert.equal(p._jev.needs_second_signal, true);
  });
});

describe("even-count consensus uses the mean of the two middles", () => {
  test("four variants [3,1,4,2] => median 2.5 (high)", async () => {
    fresh();
    const { deps } = scoreDeps({ "e-1": 3.0, "e-2": 1.0, "e-3": 4.0, "e-4": 2.0 });
    const p = JSON.parse(
      await decide("even consensus task", riskQuestions(), deps, ["e-1", "e-2", "e-3", "e-4"]),
    ) as any;
    assert.equal(p._jev.consensus.n, 4);
    assert.equal(p._jev.consensus.median_score, 2.5);
    assert.equal(p._jev.consensus.median_bucket, "high");
    assert.equal(p.bucket, "high");
    assert.equal(p._jev.consensus.spread, 3.0);
  });

  test("two variants straddling the low boundary [0.5,1.5] => median 1.0 (low)", async () => {
    fresh();
    const { deps } = scoreDeps({ "s-1": 0.5, "s-2": 1.5 });
    const p = JSON.parse(await decide("straddle task", riskQuestions(), deps, ["s-1", "s-2"])) as any;
    assert.equal(p._jev.consensus.median_score, 1.0);
    assert.equal(p._jev.consensus.median_bucket, "low", "bucketFor(1) is low — boundary intact");
    assert.equal(p.bucket, "low");
  });
});

describe("all-agree variants stay quiet", () => {
  test("buckets_agree true; disagreement arm does NOT trip the flag", async () => {
    fresh();
    const { deps } = scoreDeps({ "a-1": 1.4, "a-2": 1.5, "a-3": 1.6 });
    const p = JSON.parse(await decide("agreeable task", riskQuestions(), deps, ["a-1", "a-2", "a-3"])) as any;
    assert.equal(p._jev.consensus.n, 3);
    assert.equal(p._jev.consensus.median_score, 1.5);
    assert.equal(p._jev.consensus.median_bucket, "medium");
    assert.equal(p._jev.consensus.buckets_agree, true);
    assert.equal(p._jev.needs_second_signal, false);
    assert.equal(p.bucket, "medium");
  });
});

describe("disagreement with a LOW median still trips the flag", () => {
  test("median low but one high sample => buckets_agree false + flag true", async () => {
    fresh();
    const { deps } = scoreDeps({ "d-1": 0.5, "d-2": 0.6, "d-3": 2.5 });
    const p = JSON.parse(await decide("low-median disagree task", riskQuestions(), deps, ["d-1", "d-2", "d-3"])) as any;
    assert.equal(p._jev.consensus.median_score, 0.6);
    assert.equal(p._jev.consensus.median_bucket, "low");
    assert.equal(p.bucket, "low", "root still reports the median bucket honestly");
    assert.equal(p._jev.consensus.buckets_agree, false);
    assert.equal(p._jev.needs_second_signal, true);
  });
});

describe("single-variant consensus (n=1)", () => {
  test("one variant => median is its score, spread 0, agree true", async () => {
    fresh();
    const { deps } = scoreDeps({ "solo-v": 1.75 });
    const p = JSON.parse(await decide("solo base task", riskQuestions(), deps, ["solo-v"])) as any;
    assert.equal(p._jev.consensus.n, 1);
    assert.equal(p._jev.consensus.median_score, 1.75);
    assert.equal(p._jev.consensus.spread, 0);
    assert.equal(p._jev.consensus.buckets_agree, true);
  });
});

describe("variant validation fails clean with no network call", () => {
  test("empty / non-array / over-cap / non-string / blank => fallback:true, zero fetches", async () => {
    const bad: unknown[] = [
      [],
      "nope",
      42,
      null,
      {},
      ["v1", "v2", "v3", "v4", "v5", "v6"],
      ["good variant", 42],
      ["good variant", null],
      ["good variant", "   "],
      [""],
    ];
    for (const variants of bad) {
      fresh();
      const { deps, calls } = scoreDeps({});
      const text = await decide("valid base task", riskQuestions(), deps, variants);
      assert.ok(text.startsWith(FALLBACK_PREFIX), `${JSON.stringify(variants)}: ${text.slice(0, 80)}`);
      assert.ok(text.includes("variants"), `${JSON.stringify(variants)}: ${text.slice(0, 120)}`);
      assert.equal(calls(), 0, "validation failure must not hit the network");
    }
  });

  test("deps-carried variants alias validates the same way", async () => {
    fresh();
    const { deps, calls } = scoreDeps({});
    const text = await decide("valid base task", riskQuestions(), { ...deps, variants: [] });
    assert.ok(text.startsWith(FALLBACK_PREFIX));
    assert.equal(calls(), 0);
  });

  test("assessRisk + decideWithContext pass variants through (incl. validation)", async () => {
    fresh();
    const scored = scoreDeps({ "w-1": 0.4, "w-2": 0.5 });
    const p = JSON.parse(await assessRisk("wrapper base task", undefined, scored.deps, ["w-1", "w-2"])) as any;
    assert.equal(p._jev.consensus.n, 2);
    assert.equal(p._jev.consensus.median_score, 0.45);
    fresh();
    const bad = await assessRisk("wrapper base task", undefined, scored.deps, []);
    assert.ok((bad as string).startsWith(FALLBACK_PREFIX));
    fresh();
    const ctx = await decideWithContext("ctx base task", { k: "v" }, riskQuestions(), scored.deps, ["w-1"]);
    assert.ok(!(ctx as string).startsWith(FALLBACK_PREFIX));
    assert.equal((JSON.parse(ctx) as any)._jev.consensus.n, 1);
  });

  test("batch entries carry variants per-entry; a bad one fails solo", async () => {
    fresh();
    const { deps, calls } = scoreDeps({ "b1a": 1.2, "b1b": 1.8 });
    const out = JSON.parse(
      await decideBatch(
        [
          { state: "batch base one", variants: ["b1a", "b1b"] },
          { state: "batch base two", variants: [] },
        ],
        deps,
      ),
    ) as { results: string[]; summary: Record<string, number> };
    assert.equal(out.results.length, 2);
    assert.equal((JSON.parse(out.results[0]) as any)._jev.consensus.n, 2);
    assert.ok(out.results[1].startsWith(FALLBACK_PREFIX), "bad variants fail per-entry only");
    assert.deepEqual(out.summary, { total: 2, ok: 1, fallback: 1, cached: 0 });
    assert.equal(calls(), 2, "only the valid entry's two variants hit the network");
  });
});

describe("noul-only question set with variants (no invented score/bucket)", () => {
  const noulQ = { verdict: { type: "noul", instructions: "Any safety concern with this task?" } };

  test("no crash, no median_score/median_bucket, no root bucket", async () => {
    fresh();
    let calls = 0;
    const deps = {
      fetchImpl: async () => {
        calls++;
        return okJson({ model: "jev-1.13-free", answers: { verdict: { type: "noul", noul: 0.05 } }, usage: {} });
      },
      token: "tok-test",
      now: () => T_NOW,
      sleep: async (_ms: number) => {},
      rng: () => 0,
    };
    const text = await decide("noul base task", noulQ, deps, ["nv-1", "nv-2", "nv-3"]);
    assert.ok(!text.startsWith(FALLBACK_PREFIX), text.slice(0, 120));
    const p = JSON.parse(text) as any;
    assert.equal(calls, 3);
    assert.equal(p._jev.consensus.n, 3);
    assert.ok(!("median_score" in p._jev.consensus), "must not invent a median score");
    assert.ok(!("median_bucket" in p._jev.consensus), "must not invent a median bucket");
    assert.equal("bucket" in p, false, "no score means no root bucket — never invent one");
    assert.equal(p._jev.consensus.spread, 0);
    assert.equal(p._jev.consensus.buckets_agree, true);
    assert.equal(p._jev.consensus.variants.length, 3);
    for (const v of p._jev.consensus.variants) {
      assert.ok(!("score" in v) && !("bucket" in v), "noul detail carries no score/bucket");
    }
    assert.equal(p._jev.needs_second_signal, false);
  });
});

describe("computeNeedsSecondSignal disagreement arm (pure function)", () => {
  test("disagree:true trips the flag alone; absent disagree preserves the table", () => {
    assert.equal(computeNeedsSecondSignal({ hint: false, lowConfidence: false, bucket: "low", disagree: true }), true);
    assert.equal(
      computeNeedsSecondSignal({ hint: false, lowConfidence: false, bucket: "medium", disagree: true }),
      true,
    );
    assert.equal(computeNeedsSecondSignal({ hint: false, lowConfidence: false, bucket: "low" }), false);
    assert.equal(computeNeedsSecondSignal({ hint: false, lowConfidence: false, bucket: "low", disagree: false }), false);
  });
});

describe("server: variants in the MCP inputSchemas (spawned, offline)", () => {
  test("decide/route_expert/assess_risk/batch-items expose variants 1..5", async () => {
    const serverPath = fileURLToPath(new URL("./jev-server.ts", import.meta.url));
    const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      const tools = await new Promise<any[]>((resolve, reject) => {
        let buf = "";
        const timer = setTimeout(() => reject(new Error("timed out waiting for tools/list")), 15000);
        child.stdout.on("data", (chunk: Buffer) => {
          buf += chunk.toString("utf8");
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
              const o = JSON.parse(line) as any;
              if (o?.id === 1 && o.result?.tools) {
                clearTimeout(timer);
                resolve(o.result.tools);
              }
            } catch {
              // ignore non-JSON stdout
            }
          }
        });
        child.stderr.on("data", () => {});
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
      });
      const byName = Object.fromEntries(tools.map((t: any) => [t.name, t.inputSchema]));
      for (const name of ["decide", "route_expert", "assess_risk"]) {
        const v = byName[name].properties.variants;
        assert.ok(v, `${name} must expose variants`);
        assert.equal(v.type, "array");
        assert.equal(v.minItems, 1);
        assert.equal(v.maxItems, 5);
        assert.equal(v.items?.type, "string");
        assert.equal(byName[name].additionalProperties, false, `${name} still forbids extra args`);
      }
      const itemVariants = byName.batch.properties.requests.items.properties.variants;
      assert.ok(itemVariants, "batch entries must expose variants");
      assert.equal(itemVariants.maxItems, 5);
    } finally {
      try {
        child.kill();
      } catch {
        // already gone
      }
      await new Promise((r) => child.on("close", r));
    }
  });
});
