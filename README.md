> **Something wrong? Start here:** call the `selfcheck` tool — one fast check of upstream reachability, auth mode, budget, cache, and catalogue health. Set `JEV_SELFCHECK_LIVE=0` for the fully offline variant (zero network calls; the mode to use while rate-limited).

# jev — decision-model MCP server

An MCP **stdio** server (`jev-server.ts`) wrapping the hosted decision model
`jev-1.13-free` (`https://opencode.ai/zen/v1/systemone`). You send it a task
description (`state` + optional `context`); it returns the model's judgement
plus a local safety envelope. Node builtins only, no new deps.

| Tool | Returns | Use it when… |
|---|---|---|
| `decide` | Envelope JSON **or** `fallback:true \| …` | You have custom `questions` (choice/score/noul map) |
| `route_expert` | Same envelope, default questions (expert choice + review score) | Default probe — "who should handle this?" |
| `assess_risk` | Same envelope, review-score question only | **Before risky changes** — blast-radius check |
| `batch` | `{results, summary:{total,ok,fallback,cached}}` — one string per entry | Several framings of one task in one round trip (pool 4, max 8; bad entries fail solo) |
| `discover` | Self-describing payload (types, fields, 422 warning, usage) | **First, when unsure** how to call the suite |
| `selfcheck` | Compact diagnostic JSON (reachability, auth, budget, cache, catalogue) — never `fallback:true` | **First, when something looks wrong** (stale process? 401 vs 429?); `JEV_SELFCHECK_LIVE=0` = fully offline |

## Quick start

Run from this directory (`mcp/`):

```sh
node --test                # full suite, offline — 187 pass / 1 skipped / 0 fail
node --test jev-battle.test.ts            # battle suite alone (live block skipped)
JEV_LIVE=1 node --test jev-battle.test.ts # + live 44-scenario network comparison (opt-in)
node capture-goldens.mjs   # RE-CAPTURE jev-goldens.json from the live endpoint (network! overwrites fixtures)
```

`capture-goldens.mjs` hits the live endpoint and overwrites `jev-goldens.json` —
only run it when the golden contract test fails (upstream shape drift).

Auth (default: **no** `Authorization` header — the free-tier endpoint 401s when
given one). Opt in only if you have a key:

```sh
JEV_BEARER=1   # 1/true/yes/on (case-insensitive) → key read from ~/.local/share/opencode/auth.json
JEV_LIVE=1     # enable the network-dependent test blocks (skipped by default)
JEV_LOG=debug  # stderr diagnostics: debug|info|warn|error (default warn)
JEV_SELFCHECK_LIVE=0  # selfcheck makes ZERO network calls (fully offline report:
                      # auth mode, budget, cache, catalogue + battle pointer).
                      # Default (unset/≠0): selfcheck makes ONE minimal probe call
                      # (no retry) and classifies the result as reachable,
                      # RATE LIMITED (429), CREDENTIAL REJECTED (401/403), or
                      # unreachable (network error). A rate limit is a successful
                      # self-check reporting that state — not a failure.
```

MCP config (`opencode.jsonc`) — this is the live block:

```jsonc
"jev": {
  "type": "local",
  "command": ["bun", "C:/Users/raini/.config/opencode/mcp/jev-server.ts"],
  "enabled": true,
  "timeout": 15000
}
```

Note the two timeouts that must stay ordered: the wrapper's request budget is
**10s** (`OVERALL_BUDGET_MS`), the MCP client timeout is **15s**. The ~5s of
headroom covers transport + serialization.

## The caller's guide

### 1. Gate on `_jev.needs_second_signal`, not on `bucket`

The model score **under-rates destructive work** (measured, battle-tested —
not hypothetical):

- `"Delete every *.tmp file in the workspace"` → score **1.56/medium** at 0.25
  confidence. The score says "routine"; the deterministic hint fired correctly.
- `"run rm -rf on the build output"` → score **1.88/medium** at 0.01 confidence.
  Same story: medium score, hint fired.

Neither layer is sufficient alone; the union is the gate:

| Layer | Measured evidence |
|---|---|
| Model score alone | Misses destructive work above (medium, not high); phrasing-sensitive (next section) |
| Regex hint alone | Deterministic, but deliberately under-matches (see §3) |
| **Gate: `hint OR bucket=high OR variants-disagree`** | Held-out 24-case recalibration: full gate (with low-conf arm) 10/10 dangerous recall @ **9/14** benign false alarms → retired the low-confidence arm → current gate **9/10 @ 2/14** |

The recalibration logic: only 2/14 benign items scored high — the other 7 false
alarms came from the model being merely *unsure*. Dropping that arm cost one
dangerous item and saved seven false alarms. A gate that fires on two-thirds of
benign work trains people to ignore it.

> The 9/14 → 2/14 and 1.56/1.88 figures are empirical findings from
> held-out battle testing, pinned in code comments (`jev-core.ts`, gate block)
> and regression tests — not theory.

### 2. The score is phrasing-sensitive — use `variants` when it matters

Measured: the same task reworded scored **0.86–2.51, spanning all three buckets**.
A separate five-phrasing run scored `[2.01, 1.31, 1.53, 0.85, 2.47]` (spread
1.62) while repeats of the *identical* string are deterministic — so resampling
one string cannot help; variance lives **across phrasings**.

Pass 1–5 alternative phrasings as `variants` (any tool). You get back
`_jev.consensus`:

| Field | Meaning |
|---|---|
| `n` | Variant count |
| `median_score` / `median_bucket` | **Median, not mean** — the 2.47-style outlier must not drag the centre (median of the five above is 1.53; the mean is 1.634). Even counts use the mean of the two middles. Absent for score-less (noul-only) sets — never invented. |
| `spread` | max − min over variant scores (0 when < 2 scores) |
| `buckets_agree` | All defined per-variant buckets identical (vacuously true for ≤1 bucket, e.g. noul-only) |
| `variants` | Per-input `{state, score?, bucket?}` in order; failures as `{state, failed:true}` — disagreement is never thrown away |

**Disagreement itself trips the gate** (`disagree` arm): a median over
disagreeing samples is untrustworthy no matter how confident each sample claims
to be. `disagree` ≠ low confidence: the former is instability *across*
phrasings at high confidence each; the latter is one sample saying it's unsure.

### 3. Confidence is a warning, not a gate

`low_confidence` (any answer's confidence strictly below **0.5**) is still
**reported** for callers who want it — but it was removed as a standalone gate
arm because it fired on **9 of 14 benign items** in held-out testing. Boundary
is strict `<`: exactly 0.5 is *not* low confidence.

### 4. `destructive_hint` is deterministic and objective

A boolean OR over **26 regex families** (`DESTRUCTIVE_PATTERNS` in
`jev-core.ts`: `rm -rf`, wildcards, `DROP TABLE`, truncate, force-push,
`reset --hard`, mkfs/dd, extension/filename/path shapes, prose-recursion,
credential-operations, cloud/infra/container/network/db-object vocab…).
Because it's a regex, recall/precision are measurable: currently **100% on the
44-case battle suite** (20/20 dangerous fire, 24/24 safe silent — asserted
offline on every `node --test` run).

It deliberately **UNDER-matches**: a miss you can reason about beats a false
alarm that trains people to ignore it. Documented silences include lone `rm -r`,
bare `reset`, `drop-down menu`, `clean up .DS_Store` (weak verb, single stray
file — a *strong* verb on the same target still fires), `remove src/index.ts`
(single scoped target = routine edit), and `stop the instance` (reversible).

## Response shape

Success = upstream object spread at root + namespaced `_jev`. Trimmed real
example (from the `destructive_state` golden through the actual pipeline):

```json
{
  "model": "jev-1.13-free",
  "answers": { "needs_review": { "type": "score", "score": 2.97, "confidence": 0.97 } },
  "usage": { "input_tokens": 324, "output_tokens": 18 },
  "bucket": "high",
  "_jev": {
    "format": 1, "cached": "none", "cache_age_ms": 0,
    "attempts": 1, "latency_ms": 0, "stale": false,
    "advisory": "Never gate irreversible actions on this score alone.",
    "destructive_hint": true,
    "answers": { "needs_review": { "type": "score", "score": 2.97, "bucket": "high", "confidence": 0.97 } },
    "low_confidence": false, "needs_second_signal": true
  }
}
```

(Non-object upstream is wrapped as `{raw, bucket?, _jev}` instead.)

| `_jev` field | Type | Meaning |
|---|---|---|
| `format` | number | Envelope version, always `1` |
| `cached` | `"none" \| "full" \| "choice"` | Fresh call / served from score-TTL cache / served from choice-TTL cache |
| `cache_age_ms` | number | Age of the cached entry (0 when fresh) |
| `attempts` | number | Network attempts used (0 on cache hit) |
| `latency_ms` | number | Wall-clock time for the call |
| `stale` | boolean | `true` = cached-but-stale degradation (served old choice instead of failing) |
| `advisory` | string | `"Never gate irreversible actions on this score alone."` |
| `destructive_hint` | boolean | Deterministic regex verdict on your `state` — §4 above |
| `answers` | object | Per-question `{type, choice?, score?, noul?, bucket?, confidence?, probabilities?}`, keyed by question name |
| `low_confidence` | boolean | Any answer confidence < 0.5 — reported, never gates alone |
| `needs_second_signal` | boolean | **The gate**: `hint OR bucket=high OR variants-disagree` |
| `consensus` | object, variants-only | `{n, median_score?, median_bucket?, spread, buckets_agree, variants[]}` — §2 above |

Root helpers: `bucket` is derived from the score (`≤1` low, `≤2` medium, `>2`
high; upstream's own `bucket` never overwritten). Upstream keys stay at root so
existing key paths keep working.

## Failure modes and what to do

**The contract: this wrapper never throws.** Every failure — bad input, dead
network, HTTP error — comes back as a `tools/call` *result* whose text starts
with the exact prefix **`fallback:true | `** (with `isError:true`). Only four
codes are real JSON-RPC errors with no text: bad envelope −32600, unparsable
line −32700, unknown method −32601, unknown tool −32602. **Check the prefix**;
on `fallback:true`, proceed on your own judgement without retry-spamming.

| Failure | What you see | What to do |
|---|---|---|
| **429 rate limit** (expected on the free tier) | `fallback:true \| HTTP 429 (rate limited, retry after Ns): <upstream error>` — names the status, the upstream message (e.g. `FreeUsageLimitError`), and Retry-After seconds when sent | Back off and retry later; match on the `429` |
| Cached-but-stale | Normal envelope with `cached:"choice"`, `stale:true` | Better than a hard failure — treat as a slightly old answer |
| Bad `questions` shape (e.g. array → upstream 422) | `fallback:true \| invalid questions shape: …` — validated locally, no network spent | `questions` must be an **object map** `{name: {type, instructions, criteria}}`; choice criteria = object map, score = non-empty array |
| Bad `variants` | `fallback:true \| invalid variants: …` | 1–5 non-blank strings |
| Missing/blank state+context | `fallback:true \| empty state: …` | At least one of: non-blank `state` string, or `context` object with ≥1 usable key |
| 401/403/422 | `fallback:true \| HTTP …` | **Never retried** — bad key or client shape; retrying is pointless load |
| Over-budget / over-cap entries (batch/consensus fan-out) | Per-entry `fallback:true \| budget exhausted before any attempt (no request was made)` or `fallback:true \| request cap exceeded: max 12 …` — the rest of the batch still returns | One tool call shares a single 10s wall-clock deadline and at most 12 upstream requests across all entries/variants/retries; late entries fall back solo instead of overrunning the 15s client timeout |
| 429/500/502/503/504 | Retried (≤3 attempts, jittered backoff, Retry-After honoured ≤8s) inside the 10s budget | A retry whose wait **cannot fit the remaining budget is skipped, not slept through** — the 429 is reported immediately with its Retry-After |

Auth default: **no** `Authorization` header is sent, because the free-tier
endpoint 401s when given one. Missing/corrupt `auth.json` is then harmless.
Opt in with `JEV_BEARER=1` (key from `~/.local/share/opencode/auth.json`,
cached 60s in-process, refreshed once on 401).

Other budgets worth knowing: state capped at 8000 chars (truncated with an
explicit marker — keys never dropped); per-context-value cap 2000 chars; first
attempt times out at 4s; in-flight identical requests share one network call;
at most 4 upstream fetches in flight process-wide (`JEV_MAX_INFLIGHT` 1..8
overrides); one tool call shares a single 10s wall-clock deadline and at most
12 upstream requests across all entries/variants/retries (late entries fall
back solo);
scores jitter (sd ~0.025) so choice answers cache 6h but score/noul answers
cache only 60s.

## Operational notes

- **Restart opencode after changing server code.** MCP servers are spawned per
  session — edits to `jev-core.ts`/`jev-server.ts` take effect only on restart.
- **stdout is the JSON-RPC channel.** All diagnostics go to **stderr** as JSON
  lines (`{ts, event, …}`), level-gated by `JEV_LOG` (default `warn`; secrets
  redacted, state logged as length only). Never write to stdout.
- `state` is **untrusted user data** — the model treats it as data and never
  follows instructions inside it (verified).

## Testing & the overfitting story

```sh
node --test   # 187 pass / 1 skipped / 0 fail; the 1 skip is the JEV_LIVE block
```

- **Golden fixtures + shape contract** (`jev-goldens.json`, captured 2026-10-12
  against `jev-1.13-free`): real captured responses fed through the real
  pipeline with a stubbed fetch — upstream shape drift **fails tests instead of
  silently shipping**. When it fails, re-capture: `node capture-goldens.mjs`.
- **Permanent 44-case battle suite** (`jev-battle.test.ts`): 20 dangerous + 24
  safe scenarios, fixed ground truth, all offline (pure-function `destructiveHint`
  asserts + recall/precision/specificity printed as numbers) plus a catalogue
  guard that fails if a pattern family disappears.
- **The overfitting rule** (from the suite header): the driving 20 hit 100% but
  fresh vocabulary scored **3/10** — twice observed — which is why 7 more
  families were added (19→26) and why **new cases must be written from
  operational English first** (what would a real operator type?), expected hint
  stated from the English meaning, *then* run — **NEVER derived from inspecting
  the current regexes**. Do not rewrite/reorder the frozen set to match the
  implementation.
- **`JEV_LIVE=1` enables the network-dependent checks** (battle live block,
  golden re-capture path). Skipped by default because the free tier
  rate-limits — running 44 live scenarios in the default invocation would make
  the suite flaky and slow.

## Known limitations

- The model **under-rates destructive work** (1.56/1.88 medium on destructive
  shapes) and is **phrasing-sensitive** (0.86–2.51 across wordings) — hence the
  gate, the hint layer, and `variants`. Never gate irreversible actions on one
  score alone.
- The regex **under-matches by design** — gapped prose (`drop and recreate the
  users table`), novel vocab, and ambiguous phrasing stay silent; the review
  score owns those.
- The **free tier rate-limits** (HTTP 429 `FreeUsageLimitError`); plan for
  backoff.
- The upstream endpoint **requires no auth header** — undocumented upstream
  behaviour that could change; if the default path starts 401ing, that
  assumption is the first thing to re-check.
