import { assessRisk, decideBatch, decideWithContext, discoverPayload, log, routeExpert, selfcheck, usableContextEntries } from "./jev-core.ts"

type RpcMsg = { jsonrpc: "2.0"; id?: number | string | null; method?: string; params?: any }

// Process-level backstops: an async throw must NEVER become an unhandled
// rejection that kills the stdio server (Node >= 15 exits on those). Log the
// crash to stderr and still emit a valid JSON-RPC error so the client sees a
// response instead of a dead pipe.
process.on("unhandledRejection", (reason) => {
  try {
    log("handle.crash", {
      where: "unhandledRejection",
      error: reason instanceof Error ? reason.message : String(reason).slice(0, 200),
    })
  } catch {
    // never throw from a backstop
  }
  try {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "unhandled rejection" },
      }) + "\n",
    )
  } catch {
    // stdout gone — nothing more we can do
  }
})

process.on("uncaughtException", (err) => {
  try {
    log("handle.crash", {
      where: "uncaughtException",
      error: err instanceof Error ? err.message : String(err).slice(0, 200),
    })
  } catch {
    // never throw from a backstop
  }
  try {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "uncaught exception" },
      }) + "\n",
    )
  } catch {
    // stdout gone — nothing more we can do
  }
})

// An EPIPE on client disconnect currently throws on an unhandled stream event
// and takes the server down with it. Swallow it (log + carry on) instead.
process.stdout.on("error", (err) => {
  try {
    log("handle.crash", {
      where: "stdout",
      error: err instanceof Error ? err.message : String(err).slice(0, 200),
    })
  } catch {
    // never throw from a backstop
  }
  // EPIPE means the reader went away; anything else is unexpected but must
  // still not kill the server via an unhandled 'error' event.
})

function reply(id: number | string | null, result: unknown) {
  try {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n")
  } catch (e) {
    try {
      log("handle.crash", {
        where: "reply",
        error: e instanceof Error ? e.message : String(e).slice(0, 200),
      })
    } catch {
      // never throw from a backstop
    }
  }
}

function fail(id: number | string | null, code: number, message: string) {
  try {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n")
  } catch (e) {
    try {
      log("handle.crash", {
        where: "fail",
        error: e instanceof Error ? e.message : String(e).slice(0, 200),
      })
    } catch {
      // never throw from a backstop
    }
  }
}

const STATE_PROP = {
  type: "string",
  description: "State.",
  minLength: 1,
} as const
const CONTEXT_PROP = {
  type: "object",
  description: "Context.",
} as const
const QUESTIONS_PROP = {
  type: "object",
  description: "Questions.",
} as const
const VARIANTS_PROP = {
  type: "array",
  description: "Variants.",
  minItems: 1,
  maxItems: 5,
  items: { type: "string", minLength: 1 },
} as const

const GOTCHA_422 = `questions is an object map, never an array (array->422).`
// Accuracy note: known-tool failures (argument-validation AND upstream /
// execution failures) always come back as a *result* whose content[0].text
// starts "fallback:true | " with isError:true. Only these four codes are real
// JSON-RPC errors with no text: bad envelope -32600, unparsable line -32700,
// unknown method -32601, unknown tool -32602.
const FALLBACK = `Failures: fallback:true, isError:true.`

// All six tools are read-only, idempotent, non-destructive. Only discover is
// closed-world (static discoverPayload); the other five fetch
// https://opencode.ai/zen/v1/systemone (selfcheck live-probes by default).
// Spec defaults are readOnly=false/idempotent=false/openWorld=true/
// destructive=true, so all four hints must be sent (nothing omittable).
// Descriptions stay terse on purpose: tools/list bytes are budgeted (<=3650)
// and the full contract (entry shape, code-mode, 422) lives in discover.
const RO_OPEN = { readOnlyHint: true, idempotentHint: true, openWorldHint: true, destructiveHint: false } as const
const RO_CLOSED = { readOnlyHint: true, idempotentHint: true, openWorldHint: false, destructiveHint: false } as const

// Exported for inspection/debugging (the size test measures the live
// tools/list bytes over stdio instead of importing this module, so the
// server's stdin listener never attaches to the test process).
export const TOOLS = [
  {
    name: "decide",
    title: "Decide",
    description: `Decision: questions map + state/context. ${GOTCHA_422} ${FALLBACK}`,
    annotations: RO_OPEN,
    inputSchema: {
      type: "object",
      properties: { state: STATE_PROP, context: CONTEXT_PROP, questions: QUESTIONS_PROP, variants: VARIANTS_PROP },
      anyOf: [{ required: ["state"] }, { required: ["context"] }],
      additionalProperties: false,
    },
  },
  {
    name: "route_expert",
    title: "Route expert",
    description: `Which expert (@planner/@coder/@reviewer) + review need. Need state/context. ${FALLBACK}`,
    annotations: RO_OPEN,
    inputSchema: {
      type: "object",
      properties: { state: STATE_PROP, context: CONTEXT_PROP, variants: VARIANTS_PROP },
      anyOf: [{ required: ["state"] }, { required: ["context"] }],
      additionalProperties: false,
    },
  },
  {
    name: "assess_risk",
    title: "Assess risk",
    description: `Blast-radius/review score. Need state/context. ${FALLBACK}`,
    annotations: RO_OPEN,
    inputSchema: {
      type: "object",
      properties: { state: STATE_PROP, context: CONTEXT_PROP, variants: VARIANTS_PROP },
      anyOf: [{ required: ["state"] }, { required: ["context"] }],
      additionalProperties: false,
    },
  },
  {
    name: "discover",
    title: "Discover",
    description: `Call first if unsure. Types, fields, 422 warning, context rules, examples.`,
    annotations: RO_CLOSED,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "selfcheck",
    title: "Selfcheck",
    description: `Selfcheck: operator diagnosis (reachability, auth, budget, cache, catalogue). JEV_SELFCHECK_LIVE=0 skips probe (offline).`,
    annotations: RO_OPEN,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "batch",
    title: "Batch",
    description: `Batch: several judgements about one task in one round trip under different framings. Pool of 4, max 8; bad entries fail solo. ${FALLBACK}`,
    annotations: RO_OPEN,
    inputSchema: {
      type: "object",
      properties: {
        requests: {
          type: "array",
          description: "Entries, max 8.",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            properties: { state: STATE_PROP, context: CONTEXT_PROP, questions: QUESTIONS_PROP, variants: VARIANTS_PROP },
            anyOf: [{ required: ["state"] }, { required: ["context"] }],
            additionalProperties: false,
          },
        },
      },
      required: ["requests"],
      additionalProperties: false,
    },
  },
]

function needState(args: any): string | null {
  // Hand-rolled runtime validation stays even though the inputSchemas above
  // now carry anyOf/required: schema is advisory and not every client
  // enforces it. Same for validateQuestions + usableContextEntries downstream.
  const a = (args ?? {}) as Record<string, unknown>
  // (L2) Type check FIRST: {"state":123} must report "state must be a
  // string", not the absence message below.
  if (a.state !== undefined && typeof a.state !== "string") return "state must be a string"
  const hasState = typeof a.state === "string" && a.state.trim().length > 0
  // (M6) Usability rule shared with serializeState via usableContextEntries:
  // {} and {"":"x"} have no usable keys, so they do NOT count as context.
  const hasContext = usableContextEntries(a.context).length > 0
  if (!hasState && !hasContext) {
    return "at least one of state (non-blank string) or context (object with at least one usable key) is required"
  }
  return null
}

// Table-driven dispatch for the three state/context decision tools. They
// share one contract (needState validation, then a text result via okText),
// so one table row each — no per-tool switch branches to drift. discover /
// selfcheck / batch keep their own shapes and stay explicit below.
type DecisionHandler = (args: {
  state?: unknown
  context?: unknown
  questions?: unknown
  variants?: unknown
}) => Promise<string>

const DECISION_HANDLERS: Record<string, DecisionHandler> = {
  decide: (args) => decideWithContext(args.state, args.context, args.questions, undefined, args.variants),
  route_expert: (args) => routeExpert(args.state, args.context, undefined, args.variants),
  assess_risk: (args) => assessRisk(args.state, args.context, undefined, args.variants),
}

async function handle(raw: unknown) {
  // Backstop correlation when the crash happens before we learn the id.
  let fallbackId: number | string | null = null
  let isNotification = false
  try {
    // (B1) Guard BEFORE any deref: JSON.parse("null") succeeds yielding null,
    // and arrays / strings / numbers are valid JSON too. None of them has an
    // `.id` — the old `msg.id` deref here threw, escaping as an unhandled
    // rejection and killing the process. Reject with -32600 instead.
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      try {
        log("rpc.invalid", { reason: "non-object-message" })
      } catch {
        // never throw from logging
      }
      return fail(null, -32600, "invalid request: message must be an object")
    }
    const msg = raw as RpcMsg
    // Non-string (or missing) jsonrpc is a protocol violation, not a method
    // problem: -32600. Notifications (no id) get silence, not even an error.
    if (typeof msg.jsonrpc !== "string" || msg.jsonrpc !== "2.0") {
      try {
        log("rpc.invalid", {
          reason: "bad-jsonrpc",
          method: typeof msg.method === "string" ? msg.method : undefined,
        })
      } catch {
        // never throw from logging
      }
      if (msg.id === undefined) return
      fallbackId = (msg.id ?? null) as number | string | null
      return fail(fallbackId, -32600, 'invalid request: jsonrpc must be "2.0"')
    }
    // (B2) id is read INSIDE the try, after the shape guard above.
    const id = (msg.id ?? null) as number | string | null
    fallbackId = id
    // Notifications carry no id: execute (or ignore) but never reply — a
    // response with id null to a notification confuses clients.
    isNotification = msg.id === undefined
    const done = (fn: () => void) => {
      if (!isNotification) fn()
    }
    const ok = (result: unknown) => done(() => reply(id, result))
    const err = (code: number, message: string) => done(() => fail(id, code, message))
    // (M1) ONE contract: every known-tool failure carries a `fallback:true |`
    // text body. Validation failures get isError:true here; execution results
    // get isError:true whenever their text carries the fallback prefix.
    const FALLBACK_PREFIX = "fallback:true | "
    const okText = (text: string) =>
      ok({
        content: [{ type: "text", text }],
        ...(text.startsWith(FALLBACK_PREFIX) ? { isError: true } : {}),
      })
    const validationFail = (message: string) =>
      ok({ content: [{ type: "text", text: `${FALLBACK_PREFIX}${message}` }], isError: true })
    switch (msg.method) {
      case "initialize":
        return ok({
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "jev", version: "2.0.0" },
        })
      case "notifications/initialized":
        return
      case "tools/list":
        return ok({ tools: TOOLS })
      case "tools/call": {
        const name = msg.params?.name
        const args = msg.params?.arguments ?? {}
        const decisionHandler = typeof name === "string" ? DECISION_HANDLERS[name] : undefined
        if (decisionHandler) {
          const errMsg = needState(args)
          if (errMsg) return validationFail(errMsg)
          const text = await decisionHandler(args)
          return okText(text)
        }
        switch (name) {
          case "discover":
            return ok({
              content: [{ type: "text", text: JSON.stringify(discoverPayload()) }],
            })
          case "selfcheck":
            // Diagnostic, not a decision: raw report text, never the
            // `fallback:true | ` contract (a rate-limited upstream is a
            // successful self-check reporting that state, not a failure).
            return ok({
              content: [{ type: "text", text: await selfcheck() }],
            })
          case "batch": {
            // decideBatch never throws and never fails the batch on a bad
            // entry: batch-level shape errors AND per-entry failures both come
            // back inside the fallback:true / JSON contract via okText.
            const text = await decideBatch(args.requests)
            return okText(text)
          }
          default:
            return err(-32602, `unknown tool: ${name}`)
        }
      }
      case "ping":
        return ok({})
      default:
        if (typeof msg.method !== "string") {
          try {
            log("rpc.invalid", { reason: "missing-method" })
          } catch {
            // never throw from logging
          }
          return err(-32600, "invalid request: method must be a string")
        }
        return err(-32601, `unknown method: ${msg.method}`)
    }
  } catch (e) {
    try {
      log("handle.crash", {
        where: "handle",
        error: e instanceof Error ? e.message : String(e).slice(0, 200),
      })
    } catch {
      // never throw from a backstop
    }
    try {
      if (!isNotification) fail(fallbackId, -32603, e instanceof Error ? e.message : String(e))
    } catch {
      // reply path must never throw
    }
  }
}

// Bound the stdin line buffer: without a cap a client that never sends "\n"
// grows `buf` forever. On overflow emit -32700 (parse error) and reset.
const MAX_BUF_CHARS = 1_048_576 // 1 MiB
let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buf += chunk
  let i: number
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (e) {
      try {
        log("rpc.invalid", { reason: "parse-error" })
      } catch {
        // never throw from logging
      }
      fail(null, -32700, e instanceof Error ? e.message : String(e))
      continue
    }
    // (B4) handle() is async: attach .catch() so a rejection never goes
    // unhandled (Node >= 15 turns those into fatal uncaught exceptions).
    // (M5) A notification (no id) must stay silent even here: check the id
    // before emitting the backstop reply.
    void handle(parsed).catch((e) => {
      try {
        log("handle.crash", {
          where: "handle-rejection",
          error: e instanceof Error ? e.message : String(e).slice(0, 200),
        })
      } catch {
        // never throw from a backstop
      }
      try {
        const isNotification =
          parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as RpcMsg).id === undefined
        if (isNotification) return
        fail(null, -32603, e instanceof Error ? e.message : String(e))
      } catch {
        // reply path must never throw
      }
    })
  }
  if (buf.length > MAX_BUF_CHARS) {
    try {
      log("rpc.invalid", { reason: "stdin-overflow", buf_chars: buf.length })
    } catch {
      // never throw from logging
    }
    buf = ""
    try {
      fail(null, -32700, "stdin buffer overflow: line exceeded 1 MiB, buffer reset")
    } catch {
      // reply path must never throw
    }
  }
})
