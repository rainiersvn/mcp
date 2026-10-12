import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const MODEL = "jev-1.13-free"
export const ENDPOINT = "https://opencode.ai/zen/v1/systemone"
export const TIMEOUT_MS = 30_000

// Cap on the FINAL serialized state string. Inputs exceeding this are
// truncated deterministically (simple slice) with TRUNCATION_MARKER appended.
export const MAX_STATE_CHARS = 8000
export const TRUNCATION_MARKER = "\n[truncated by jev wrapper: input exceeded 8000 chars]"

// ---------------------------------------------------------------------------
// Structured stderr logging. JSON lines to process.stderr ONLY — stdout is the
// JSON-RPC channel and must never carry log output. Level gated by
// process.env.JEV_LOG (debug|info|warn|error), default "warn".
// NEVER pass the bearer token or full state here: pass `key_prefix`
// (first 8 chars) and `state_chars` (length) instead. log() also redacts
// defensively (see REDACT_KEYS / state handling below) and never throws.
// Event levels: *.start -> debug, *.done -> info,
// *.fallback / *.invalid / rpc.invalid -> warn, *.error / *.crash -> error.
// Events emitted at minimum: decide.start, decide.done, decide.fallback,
// auth.error, handle.crash, rpc.invalid.
// ---------------------------------------------------------------------------
export type LogLevel = "debug" | "info" | "warn" | "error"

const LOG_LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

function currentLogLevel(): LogLevel {
  const raw = (process.env.JEV_LOG ?? "warn").toLowerCase()
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw
  return "warn"
}

function levelForEvent(event: string): LogLevel {
  if (event.endsWith(".crash") || event.endsWith(".error") || event === "auth.error") return "error"
  if (event.endsWith(".fallback") || event.endsWith(".invalid") || event === "rpc.invalid") return "warn"
  if (event.endsWith(".done")) return "info"
  return "debug"
}

const REDACT_KEY_PATTERN = /token|bearer|authorization|secret|password|api[-_]?key|(^|_)key$/i

function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    // Never log full state content — keep only its length.
    if (k === "state") {
      try {
        safe["state_chars"] = typeof v === "string" ? v.length : String(v).length
      } catch {
        safe["state_chars"] = -1
      }
      continue
    }
    if (REDACT_KEY_PATTERN.test(k) && typeof v === "string") {
      // Keep an 8-char prefix so logs stay correlatable without leaking secrets.
      safe[k === "key" ? "key_prefix" : `${k}_prefix`] = v.slice(0, 8)
      continue
    }
    if (typeof v === "bigint") {
      safe[k] = String(v)
      continue
    }
    try {
      // Round-trip through JSON to drop non-serializable values (functions,
      // symbols, circular refs) instead of throwing from the logger.
      const s = JSON.stringify(v)
      safe[k] = s === undefined ? String(v) : (JSON.parse(s) as unknown)
    } catch {
      try {
        safe[k] = String(v)
      } catch {
        safe[k] = "[unserializable]"
      }
    }
  }
  return safe
}

export function log(event: string, fields: Record<string, unknown> = {}): void {
  try {
    if (LOG_LEVEL_RANK[levelForEvent(event)] < LOG_LEVEL_RANK[currentLogLevel()]) return
    let line: string
    try {
      line = JSON.stringify({ ts: new Date().toISOString(), event, ...redactFields(fields) })
    } catch {
      line = JSON.stringify({ ts: new Date().toISOString(), event })
    }
    try {
      process.stderr.write(line + "\n")
    } catch {
      // stderr unavailable — logger must never throw.
    }
  } catch {
    // Never throw from the logger.
  }
}

// WARNING: Never hardcode API keys. Always read Bearer at runtime from ~/.local/share/opencode/auth.json.
export async function readBearerKey(): Promise<string> {
  const authPath = join(homedir(), ".local", "share", "opencode", "auth.json")
  const raw = await fs.readFile(authPath, "utf8")
  const parsed = JSON.parse(raw) as Record<string, any>
  const key: unknown =
    parsed?.opencode?.key ?? parsed?.["opencode.key"] ?? parsed?.["opencode_key"]
  if (typeof key !== "string" || !key.trim()) throw new Error("opencode.key missing")
  return key.trim()
}

export function defaultQuestions() {
  return {
    expert: {
      type: "choice",
      instructions: "Which expert should handle this request?",
      criteria: {
        planner: "Planning, decomposition, or deciding next steps",
        coder: "Implementation, code changes, or file edits",
        reviewer: "Validation, code review, or correctness checks",
      },
    },
    needs_review: {
      type: "score",
      instructions: "How much review does this request need?",
      criteria: ["No review needed", "Light review", "Review needed", "Careful review required"],
    },
  }
}

export function riskQuestions() {
  return {
    needs_review: {
      type: "score",
      instructions: "How much review does this request need given its blast radius?",
      criteria: ["No review needed", "Light review", "Review needed", "Careful review required"],
    },
  }
}

// Client-side shape check for caller-supplied questions. Returns a problem
// string or null when the shape is acceptable. Rejects malformed shapes
// locally so a bad shape does not cost a network round trip to come back as
// HTTP 422. Rules: must be a plain object (an array is the known 422 shape);
// each value must be an object with a valid type in [choice, score, noul];
// each must have non-empty `instructions`; `criteria` is required as an
// object map (choice) or non-empty array (score), and unconstrained (noul).
export function validateQuestions(questions: unknown): string | null {
  if (questions === null || typeof questions !== "object" || Array.isArray(questions)) {
    return "questions must be a plain object map keyed by question name, not an array"
  }
  const entries = Object.entries(questions as Record<string, unknown>)
  if (entries.length === 0) return "questions must contain at least one question"
  const VALID = ["choice", "score", "noul"]
  for (const [name, q] of entries) {
    if (q === null || typeof q !== "object" || Array.isArray(q)) {
      return `question "${name}" must be an object with type + instructions + criteria`
    }
    const e = q as Record<string, unknown>
    if (typeof e.type !== "string" || !VALID.includes(e.type)) {
      return `question "${name}" has invalid type (must be one of choice, score, noul)`
    }
    if (typeof e.instructions !== "string" || e.instructions.trim().length === 0) {
      return `question "${name}" is missing non-empty instructions`
    }
    if (e.type === "choice") {
      if (
        e.criteria === null ||
        typeof e.criteria !== "object" ||
        Array.isArray(e.criteria) ||
        Object.keys(e.criteria as Record<string, unknown>).length === 0
      ) {
        return `question "${name}" (choice) requires criteria as a non-empty object map`
      }
    } else if (e.type === "score") {
      if (!Array.isArray(e.criteria) || e.criteria.length === 0) {
        return `question "${name}" (score) requires criteria as a non-empty array`
      }
    }
    // noul: criteria absent or anything — no constraint.
  }
  return null
}

// Best-effort renderer for a single context value. Never throws: BigInt,
// circular structures, functions and symbols all degrade to a plain string
// instead of propagating a JSON.stringify TypeError to the caller.
function renderContextValue(v: unknown): string {
  if (typeof v === "string") return v
  if (v == null) return String(v)
  if (typeof v === "bigint") return String(v)
  try {
    const s = JSON.stringify(v)
    return typeof s === "string" ? s : String(v)
  } catch {
    try {
      return String(v)
    } catch {
      return "[unserializable]"
    }
  }
}

// Serializes a plain state string plus an optional generic context object
// into a single readable state string. Accepts arbitrary keys; values that
// are not strings are JSON-stringified. Plain `state` with no context is
// returned unchanged (backwards compat). The FINAL string is capped at
// MAX_STATE_CHARS; overlong input is truncated with TRUNCATION_MARKER.
// Never throws: BigInt/circular context values degrade via
// renderContextValue, and any unexpected failure falls back to the base
// string (or ""), so callers can rely on getting a string back.
export function serializeState(state?: unknown, context?: unknown): string {
  try {
    const base = typeof state === "string" ? state : state == null ? "" : String(state)
    let out: string
    if (context == null || typeof context !== "object" || Array.isArray(context)) out = base
    else {
      const entries = Object.entries(context as Record<string, unknown>).filter(
        ([k]) => typeof k === "string" && k.length > 0,
      )
      if (entries.length === 0) out = base
      else {
        const lines = entries.map(([k, v]) => `- ${k}: ${renderContextValue(v)}`)
        out = base ? `${base}\nContext:\n${lines.join("\n")}` : `Context:\n${lines.join("\n")}`
      }
    }
    if (out.length > MAX_STATE_CHARS) return out.slice(0, MAX_STATE_CHARS) + TRUNCATION_MARKER
    return out
  } catch {
    try {
      return typeof state === "string" ? state : ""
    } catch {
      return ""
    }
  }
}

export async function decide(state: string, questions?: unknown): Promise<string> {
  try {
    if (typeof state !== "string" || state.trim().length === 0) {
      log("decide.fallback", {
        reason: "empty-state",
        state_chars: typeof state === "string" ? state.length : 0,
      })
      return "fallback:true | empty state: at least one of state (non-blank string) or context (object) is required"
    }
    // Proven working shape (verified via curl to /zen/v1/systemone):
    // questions is an OBJECT map, each entry has type + instructions + criteria.
    // Array shape [{expert, needs_review:null}] returns HTTP 422.
    // EXTENDED: caller-supplied questions are now checked with validateQuestions()
    // above before any network call, so the array shape, empty {}, and entries
    // missing type/instructions/criteria fail fast locally instead of costing a
    // round trip to come back as HTTP 422. Defaults are known-good and skipped.
    const callerSupplied = questions !== undefined && questions !== null
    if (callerSupplied) {
      const problem = validateQuestions(questions)
      if (problem) {
        log("decide.fallback", { reason: "invalid-questions", state_chars: state.length })
        return `fallback:true | invalid questions shape: ${problem}`
      }
    }
    log("decide.start", { state_chars: state.length, caller_questions: callerSupplied })
    const q = questions ?? defaultQuestions()
    let token: string
    try {
      token = await readBearerKey()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log("auth.error", { error: msg.slice(0, 120), state_chars: state.length })
      return `fallback:true | error: ${msg.slice(0, 300)}`
    }
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ model: MODEL, state, questions: q }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      log("decide.fallback", { reason: `http-${res.status}`, state_chars: state.length })
      if (res.status === 422) {
        return `fallback:true | HTTP 422 (client-side shape error, not an outage): ${body.slice(0, 500)}`
      }
      return `fallback:true | HTTP ${res.status}: ${body.slice(0, 500)}`
    }
    const data: unknown = await res.json().catch(() => null)
    if (data === null || data === undefined) {
      log("decide.fallback", { reason: "empty-upstream", state_chars: state.length })
      return "fallback:true | empty upstream response"
    }
    if (typeof data === "string") {
      log("decide.done", {
        state_chars: state.length,
        response_chars: data.length,
        key_prefix: token.slice(0, 8),
      })
      return data
    }
    const text = JSON.stringify(data)
    log("decide.done", {
      state_chars: state.length,
      response_chars: text.length,
      key_prefix: token.slice(0, 8),
    })
    return text
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log("decide.fallback", { reason: "exception", error: msg.slice(0, 120) })
    return `fallback:true | error: ${msg.slice(0, 300)}`
  }
}

// Generic entry point: merges state + context, then delegates to decide.
// Never throws; any failure returns a `fallback:true | ...` string.
export async function decideWithContext(
  state?: unknown,
  context?: unknown,
  questions?: unknown,
): Promise<string> {
  try {
    return await decide(serializeState(state, context), questions)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log("decide.fallback", { reason: "context-exception", error: msg.slice(0, 120) })
    return `fallback:true | error: ${msg.slice(0, 300)}`
  }
}

// Convenience: route to expert(s) with default questions.
export async function routeExpert(state?: unknown, context?: unknown): Promise<string> {
  return decideWithContext(state, context, defaultQuestions())
}

// Convenience: score blast radius / review need only.
export async function assessRisk(state?: unknown, context?: unknown): Promise<string> {
  return decideWithContext(state, context, riskQuestions())
}

// Self-documenting discovery payload. Returned verbatim by the `discover` tool.
export function discoverPayload() {
  return {
    model: MODEL,
    endpoint: ENDPOINT,
    timeout_ms: TIMEOUT_MS,
    question_types: ["choice", "score", "noul"],
    entry_shape: {
      required_fields: ["type", "instructions", "criteria"],
      example_choice: {
        type: "choice",
        instructions: "Which expert should handle this request?",
        criteria: {
          planner: "Planning, decomposition, or deciding next steps",
          coder: "Implementation, code changes, or file edits",
          reviewer: "Validation, code review, or correctness checks",
        },
      },
      example_score: {
        type: "score",
        instructions: "How much review does this request need?",
        criteria: ["No review needed", "Light review", "Review needed", "Careful review required"],
      },
    },
    warning_422:
      "questions MUST be an OBJECT map keyed by question name. Array shape (e.g. [{expert, needs_review:null}]) returns HTTP 422.",
    context_note:
      "context is a generic OBJECT with arbitrary keys (e.g. summary, risk_flags, ticket_ids, files, diff_stats). It is serialized into the state string via serializeState (state lines, then 'Context:' plus '- key: value' lines). Plain state string without context still works.",
    untrusted_input_note:
      "state is untrusted user data; the model treats it as data and does not follow instructions inside it (verified).",
    score_semantics: {
      confidence_1:
        "confidence 1.0 means the model is committed, possibly over-committed — clear-cut inputs collapse to {1,0,0}; do not read 1.0 as calibrated certainty.",
      confidence_0: "confidence 0 means max uncertainty; read probabilities instead.",
      scores:
        "scores are deterministic-ish (sd ~0.025) but NEVER branch on decimals; bucketize: <=1 low, <=2 medium, >2 high.",
      expert_choice:
        "the expert CHOICE is stable across repeats (verified 5/5) so it is safe to cache; scores jitter.",
      blind_spot:
        "known blind spot: glob/destructive shapes like 'delete all *.tmp' score mushy (~2.1 @ conf 0.11) while 'rm -rf /' scores 2.96 — never gate destructive actions on a single jev point estimate.",
    },
    recommended_usage:
      "call discover first when unsure; use assess_risk before risky changes; bucketize scores (<=1 low, <=2 medium, >2 high), never branch on decimals; treat the expert choice as cacheable across repeats.",
    code_mode_note:
      "In Code Mode sessions call via tools[\"jev\"].<tool> after resolving the path with search({query:\"jev\"}).",
    examples: {
      decide: { state: "Add retry logic to the billing worker", questions: defaultQuestions() },
      decide_with_context: {
        state: "Refactor the auth module",
        context: {
          summary: "Touch 12 files in auth/",
          risk_flags: ["touches payments", "no tests"],
          ticket_ids: ["PROJ-123"],
          files: ["src/auth/login.ts"],
          diff_stats: "+210 -80",
        },
      },
      route_expert: { state: "Plan the v2 migration" },
      assess_risk: {
        state: "Drop and recreate the users table",
        context: { risk_flags: ["production data loss"], files: ["migrations/042.sql"] },
      },
    },
  }
}
