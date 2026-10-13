// jev conservative cache-key normalization — OFFLINE proof suite.
// Node builtin test runner, no new deps. No live calls (injected fetch only).
// Run: node --test jev-cache-normalize.test.ts
//
// WHAT IT PROVES (fetch call counts are the assertions):
//   1. Whitespace/case/punctuation variants of one state share ONE fetch.
//   2. States differing by a real token (logs vs logs2, prod vs staging)
//      do NOT collide — distinct keys, distinct fetches, distinct results.
//   3. The state SENT UPSTREAM is byte-identical to the caller's original.
//   4. destructiveHint sees the ORIGINAL text, not the normalized key — via
//      a proximity case where folding the whitespace would FLIP the hint.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  _clearBearerCache,
  _clearJevCache,
  cacheKeyFor,
  decide,
  destructiveHint,
  normalizeStateForKey,
} from "./jev-core.ts";

const FALLBACK_PREFIX = "fallback:true | ";

describe("conservative cache-key normalization (offline — injected fetch/time)", () => {
  let t: number;
  const now = () => t;
  const instantSleep = async (_ms: number) => {};
  const zeroRng = () => 0;
  const okJson = (v: unknown) =>
    new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  const choiceOnly = () => ({
    expert: { type: "choice", instructions: "pick", criteria: { a: "A", b: "B" } },
  });
  const freshDeps = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, token = "tok-test") => ({
    fetchImpl,
    token,
    now,
    sleep: instantSleep,
    rng: zeroRng,
  });

  test("normalizeStateForKey folds ONLY the documented cosmetics", () => {
    // Documented fold: trim + collapse + case-fold + strip edge framing.
    assert.equal(normalizeStateForKey("  Delete   the TMP files  "), "delete the tmp files");
    assert.equal(normalizeStateForKey("DELETE THE TMP FILES"), "delete the tmp files");
    assert.equal(normalizeStateForKey('"delete the tmp files"'), "delete the tmp files");
    assert.equal(normalizeStateForKey("``delete   the TMP files!!``"), "delete the tmp files");
    assert.equal(normalizeStateForKey("delete the tmp files."), "delete the tmp files");
    assert.equal(normalizeStateForKey("(delete the tmp files)"), "delete the tmp files");
    assert.equal(normalizeStateForKey("delete\tlogs\nfrom\tprod"), "delete logs from prod");
    // NOT folded: real tokens survive byte-distinct after normalization.
    assert.notEqual(normalizeStateForKey("delete logs"), normalizeStateForKey("delete logs2"));
    assert.notEqual(normalizeStateForKey("deploy to prod"), normalizeStateForKey("deploy to staging"));
    assert.notEqual(normalizeStateForKey("bump to v1.2"), normalizeStateForKey("bump to v1.3"));
    assert.notEqual(normalizeStateForKey("delete /tmp"), normalizeStateForKey("delete /var"));
    assert.notEqual(normalizeStateForKey("rm -r build"), normalizeStateForKey("rm -rf build"));
    assert.equal(normalizeStateForKey("delete /tmp"), "delete /tmp", "paths/operators are never stripped");
  });

  test("whitespace/case/punctuation variants share ONE fetch", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 100_000_000;
    let calls = 0;
    const deps = freshDeps(async () => {
      calls++;
      return okJson({ expert: "coder" });
    });
    const variants = [
      "Delete the tmp files",
      "  delete   the   tmp   files  ",
      "DELETE THE TMP FILES",
      '"delete the tmp files"',
      "delete the tmp files.",
      "``delete   the TMP files!!``",
    ];
    // All variants must hash together under identical questions.
    const keys = new Set(variants.map((s) => cacheKeyFor(s, choiceOnly())));
    assert.equal(keys.size, 1, `variants must share one key, got ${keys.size}`);
    const first = await decide(variants[0], choiceOnly(), deps);
    assert.equal(calls, 1);
    assert.ok(!first.startsWith(FALLBACK_PREFIX));
    assert.equal((JSON.parse(first) as any)._jev.cached, "none");
    for (const s of variants.slice(1)) {
      const r = await decide(s, choiceOnly(), deps);
      assert.ok(!r.startsWith(FALLBACK_PREFIX), `variant must hit cache: ${JSON.stringify(s)}`);
      assert.equal((JSON.parse(r) as any).expert, "coder", "cached answer served for the variant");
    }
    assert.equal(calls, 1, `all ${variants.length} variants must cost exactly 1 fetch, cost ${calls}`);
  });

  test("real-token differences do NOT collide (distinct keys, fetches, results)", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 110_000_000;
    let calls = 0;
    const seen: string[] = [];
    const deps = freshDeps(async (_url: string, init?: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init?.body)) as { state: string };
      seen.push(body.state);
      // Echo the state back so served results are provably distinct.
      return okJson({ expert: "coder", echo: body.state });
    });
    assert.notEqual(
      cacheKeyFor("delete logs", choiceOnly()),
      cacheKeyFor("delete logs2", choiceOnly()),
      "one trailing digit must change the key",
    );
    assert.notEqual(
      cacheKeyFor("deploy to prod", choiceOnly()),
      cacheKeyFor("deploy to staging", choiceOnly()),
      "prod vs staging must change the key",
    );
    const r1 = await decide("delete logs", choiceOnly(), deps);
    const r2 = await decide("delete logs2", choiceOnly(), deps);
    const r3 = await decide("deploy to prod", choiceOnly(), deps);
    const r4 = await decide("deploy to staging", choiceOnly(), deps);
    assert.equal(calls, 4, `four genuinely different states must cost 4 fetches, cost ${calls}`);
    // The safety guard's contract: no wrong-answer serving — each state gets
    // its OWN upstream echo back, never a neighbour's cached entry.
    assert.equal((JSON.parse(r1) as any).echo, "delete logs");
    assert.equal((JSON.parse(r2) as any).echo, "delete logs2");
    assert.equal((JSON.parse(r3) as any).echo, "deploy to prod");
    assert.equal((JSON.parse(r4) as any).echo, "deploy to staging");
    assert.deepEqual(seen, ["delete logs", "delete logs2", "deploy to prod", "deploy to staging"]);
    // And repeats of each still hit their own cache entry (no cross-talk).
    await decide("delete logs", choiceOnly(), deps);
    await decide("delete logs2", choiceOnly(), deps);
    assert.equal(calls, 4, "repeats must hit per-state cache entries, not refetch");
  });

  test("the state SENT UPSTREAM is byte-identical to the caller's original", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 120_000_000;
    const originals = ['  Delete   ALL *.LOG Files!!  ', '"Deploy   to PROD..."'];
    for (const original of originals) {
      _clearJevCache();
      let sentState: unknown;
      let sentModel: unknown;
      const deps = freshDeps(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sentState = body.state;
        sentModel = body.model;
        return okJson({ expert: "coder" });
      });
      const r = await decide(original, choiceOnly(), deps);
      assert.ok(!r.startsWith(FALLBACK_PREFIX));
      assert.equal(sentState, original, `upstream body must carry the original bytes: ${JSON.stringify(original)}`);
      assert.equal(sentModel, "jev-1.13-free");
    }
  });

  test("destructiveHint sees the ORIGINAL text, not the normalized key", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 130_000_000;
    // Proximity case: verb and extension 70 chars apart. The ORIGINAL is
    // silent (extension-delete spans at most 60 chars); the NORMALIZED fold
    // (single space) would FIRE. A hint computed from the key would flip.
    const gapped = `delete${" ".repeat(70)}.tmp`;
    assert.equal(destructiveHint(gapped), false, "original gapped text must be silent");
    assert.equal(
      destructiveHint(normalizeStateForKey(gapped)),
      true,
      "sanity: the folded text WOULD fire — this is what the hint must NOT see",
    );
    const deps = freshDeps(async () => okJson({ expert: "coder" }));
    const r = await decide(gapped, choiceOnly(), deps);
    assert.ok(!r.startsWith(FALLBACK_PREFIX));
    assert.equal(
      (JSON.parse(r) as any)._jev.destructive_hint,
      false,
      "envelope hint must match destructiveHint(ORIGINAL), not destructiveHint(normalized)",
    );
    // Positive control with odd formatting intact: a genuinely destructive
    // shape still flags through the same path.
    _clearJevCache();
    const loud = '  "DELETE   EVERYTHING *"  ';
    assert.equal(destructiveHint(loud), true, "sanity: loud original must fire");
    const r2 = await decide(loud, choiceOnly(), deps);
    assert.equal((JSON.parse(r2) as any)._jev.destructive_hint, true);
  });
});
