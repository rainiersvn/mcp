// jev TTL-by-type regression: only pure-choice requests get the 6h TTL;
// any request containing a score OR noul question refreshes at 60s.
// Offline only (injected fetch/time), Node builtin runner, no new deps.
// Run: node --test jev-cache-ttl.test.ts
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  CHOICE_TTL_MS,
  SCORE_TTL_MS,
  _clearBearerCache,
  _clearJevCache,
  cacheKeyFor,
  decide,
  defaultQuestions,
  discoverPayload,
  riskQuestions,
  wantsFresh,
  wantsScore,
} from "./jev-core.ts";

const FALLBACK_PREFIX = "fallback:true | ";

describe("TTL is decided by question type (pure-choice alone gets 6h)", () => {
  let t: number;
  const now = () => t;
  const instantSleep = async (_ms: number) => {};
  const zeroRng = () => 0;
  const okJson = (v: unknown) =>
    new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  const choiceOnly = () => ({
    expert: { type: "choice", instructions: "pick", criteria: { a: "A", b: "B" } },
  });
  const noulOnly = () => ({
    verdict: { type: "noul", instructions: "any safety concern with this task?" },
  });
  const mixedChoiceNoul = () => ({
    expert: { type: "choice", instructions: "pick", criteria: { a: "A", b: "B" } },
    verdict: { type: "noul", instructions: "any safety concern with this task?" },
  });
  const freshDeps = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, token = "tok-test") => ({
    fetchImpl,
    token,
    now,
    sleep: instantSleep,
    rng: zeroRng,
  });

  test("wantsFresh: score/noul/mixed need fresh; pure choice does not", () => {
    assert.ok(wantsFresh(defaultQuestions()), "default (choice+score) needs fresh");
    assert.ok(wantsFresh(riskQuestions()), "risk (score) needs fresh");
    assert.ok(wantsFresh(noulOnly()), "noul-only needs fresh");
    assert.ok(wantsFresh(mixedChoiceNoul()), "choice+noul (no score) needs fresh");
    assert.ok(!wantsFresh(choiceOnly()), "pure choice must NOT need fresh");
    assert.ok(!wantsFresh(null) && !wantsFresh([]) && !wantsFresh({}), "garbage shapes are not fresh");
    // wantsScore stays as the compatible export with its old meaning.
    assert.ok(wantsScore(defaultQuestions()));
    assert.ok(!wantsScore(noulOnly()), "wantsScore is score-only by definition");
    assert.ok(!wantsScore(choiceOnly()));
    assert.equal(CHOICE_TTL_MS, 6 * 60 * 60 * 1000);
    assert.equal(SCORE_TTL_MS, 60_000);
  });

  test("noul-only past 60s REFETCHES (no 6h caching of safety verdicts)", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 10_000_000;
    let calls = 0;
    const deps = freshDeps(async () => {
      calls++;
      return okJson({ answers: { verdict: { type: "noul", noul: 0.05 } } });
    });
    const r1 = await decide("noul-ttl-state", noulOnly(), deps);
    assert.equal(calls, 1);
    assert.equal((JSON.parse(r1) as any)._jev.cached, "none");
    t += 61_000; // past the 60s TTL, far inside the 6h choice TTL
    const r2 = await decide("noul-ttl-state", noulOnly(), deps);
    assert.equal(calls, 2, "stale noul must refetch, never serve the 6h cache");
    assert.equal((JSON.parse(r2) as any)._jev.cached, "none");
    assert.ok(!r2.startsWith(FALLBACK_PREFIX));
  });

  test("mixed choice+noul (no score) past 60s REFETCHES", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 20_000_000;
    let calls = 0;
    const deps = freshDeps(async () => {
      calls++;
      return okJson({ answers: { verdict: { type: "noul", noul: 0.05 } } });
    });
    await decide("mixed-ttl-state", mixedChoiceNoul(), deps);
    assert.equal(calls, 1);
    t += 61_000;
    const r2 = await decide("mixed-ttl-state", mixedChoiceNoul(), deps);
    assert.equal(calls, 2, "choice+noul without score must still use the 60s TTL");
    assert.equal((JSON.parse(r2) as any)._jev.cached, "none");
  });

  test("REGRESSION GUARD: pure choice still served from the 6h cache", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 30_000_000;
    let calls = 0;
    const deps = freshDeps(async () => {
      calls++;
      return okJson({ expert: "planner" });
    });
    await decide("pure-choice-ttl-state", choiceOnly(), deps);
    assert.equal(calls, 1);
    t += 61_000; // past 60s but inside 6h
    const r2 = await decide("pure-choice-ttl-state", choiceOnly(), deps);
    assert.equal(calls, 1, "pure-choice inside 6h must not refetch");
    assert.equal((JSON.parse(r2) as any)._jev.cached, "choice");
    t += 60 * 60 * 1000; // ~1h later, still inside 6h
    const r3 = await decide("pure-choice-ttl-state", choiceOnly(), deps);
    assert.equal(calls, 1, "pure-choice an hour later must still hit the cache");
    assert.equal((JSON.parse(r3) as any)._jev.cached, "choice");
  });

  test("score request still uses the 60s TTL", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 40_000_000;
    let calls = 0;
    const deps = freshDeps(async () => {
      calls++;
      return okJson({ expert: "coder", needs_review: { score: 1.4 } });
    });
    await decide("score-ttl-state", undefined, deps);
    assert.equal(calls, 1);
    t += 61_000;
    const r2 = await decide("score-ttl-state", undefined, deps);
    assert.equal(calls, 2, "stale score must refetch");
    assert.equal((JSON.parse(r2) as any)._jev.cached, "none");
  });

  test("same state + different questions => different keys, no cross-contamination", () => {
    _clearJevCache();
    _clearBearerCache();
    const kChoice = cacheKeyFor("shared-state", choiceOnly());
    const kNoul = cacheKeyFor("shared-state", noulOnly());
    const kMixed = cacheKeyFor("shared-state", mixedChoiceNoul());
    const kDefault = cacheKeyFor("shared-state", defaultQuestions());
    assert.notEqual(kChoice, kNoul);
    assert.notEqual(kChoice, kMixed);
    assert.notEqual(kNoul, kMixed);
    assert.notEqual(kChoice, kDefault);
    assert.notEqual(kNoul, kDefault);
  });

  test("same state + different questions => separate fetches over decide", async () => {
    _clearJevCache();
    _clearBearerCache();
    t = 50_000_000;
    let calls = 0;
    const deps = freshDeps(async () => {
      calls++;
      return okJson({ expert: "coder" });
    });
    await decide("shared-state", choiceOnly(), deps);
    assert.equal(calls, 1);
    // Same state but a noul question set must NOT hit the choice entry.
    await decide("shared-state", noulOnly(), deps);
    assert.equal(calls, 2, "different question sets over the same state must not collide");
  });

  test("discover documents the pure-choice-only long TTL within budget", () => {
    const payload = discoverPayload() as Record<string, unknown>;
    const semantics = payload.score_semantics as Record<string, unknown>;
    const text = String(semantics.expert_choice);
    assert.ok(/choice[^.]*6h/i.test(text), `must state the long TTL is choice-only: ${text}`);
    assert.ok(/60s/.test(text), `must state the score/noul 60s TTL: ${text}`);
    assert.ok(/noul/i.test(text), `must name noul: ${text}`);
    assert.ok(JSON.stringify(payload).length <= 1400, "discover budget holds");
  });
});
