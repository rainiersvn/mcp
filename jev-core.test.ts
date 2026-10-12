// jev-core regression harness — Node builtin test runner, no new deps.
//
// HOW TO RUN (from this directory; requires Node >= 22 for direct .ts runs,
// verified on the Node that ships with this repo — check with `node --version`):
//     node --test jev-core.test.ts
//
// WHAT IT COVERS (no test hits the network — only local failure paths and
// pure functions imported directly from jev-core.ts):
//   - validateQuestions shape rules (array/empty/choice/score/noul)
//   - serializeState rendering, 8000-char cap, BigInt/circular safety
//   - M3 (todo): a large context value must not silently drop sibling keys
//   - the `fallback:true | ` contract on every offline failure path
//   - log(): stderr-only JSON lines, JEV_LOG gating, secret redaction
//   - discoverPayload() top-level KEY names (callers depend on them)
//   - server: feeding the line `null` replies -32600 and the process lives on
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  MAX_STATE_CHARS,
  TRUNCATION_MARKER,
  assessRisk,
  decide,
  decideWithContext,
  defaultQuestions,
  discoverPayload,
  log,
  riskQuestions,
  routeExpert,
  serializeState,
  validateQuestions,
} from "./jev-core.ts";

const FALLBACK_PREFIX = "fallback:true | ";

describe("validateQuestions", () => {
  test("rejects the array shape (the known HTTP 422 shape)", () => {
    const problem = validateQuestions([{ expert: null, needs_review: null }]);
    assert.equal(typeof problem, "string");
    assert.match(problem as string, /plain object|array/i);
  });

  test("rejects an empty object", () => {
    const problem = validateQuestions({});
    assert.equal(typeof problem, "string");
    assert.match(problem as string, /at least one/i);
  });

  test("rejects choice-with-array-criteria", () => {
    const problem = validateQuestions({
      expert: { type: "choice", instructions: "pick one", criteria: ["a", "b"] },
    });
    assert.equal(typeof problem, "string");
    assert.match(problem as string, /choice.*object map|object map.*choice/i);
  });

  test("rejects score-with-object-criteria", () => {
    const problem = validateQuestions({
      needs_review: { type: "score", instructions: "how much?", criteria: { low: "x" } },
    });
    assert.equal(typeof problem, "string");
    assert.match(problem as string, /score.*array/i);
  });

  test("rejects entries with a bad type or missing instructions", () => {
    assert.equal(typeof validateQuestions({ q: { type: "bogus", instructions: "i" } }), "string");
    assert.equal(
      typeof validateQuestions({ q: { type: "choice", instructions: "   ", criteria: { a: "b" } } }),
      "string",
    );
    assert.equal(typeof validateQuestions({ q: "nope" }), "string");
    assert.equal(typeof validateQuestions(null), "string");
  });

  test("accepts the shipped default shapes and bare noul", () => {
    assert.equal(validateQuestions(defaultQuestions()), null);
    assert.equal(validateQuestions(riskQuestions()), null);
    assert.equal(
      validateQuestions({ anything: { type: "noul", instructions: "free-form" } }),
      null,
    );
    assert.equal(
      validateQuestions({
        expert: { type: "choice", instructions: "pick", criteria: { a: "A", b: "B" } },
        needs_review: { type: "score", instructions: "rate", criteria: ["lo", "hi"] },
      }),
      null,
    );
  });
});

describe("serializeState", () => {
  test("plain string passes through unchanged (backwards compat)", () => {
    assert.equal(serializeState("hello"), "hello");
    assert.equal(serializeState("hi", undefined), "hi");
    assert.equal(serializeState("hi", null), "hi");
    assert.equal(serializeState(undefined, undefined), "");
  });

  test("renders context as Context: plus '- key: value' lines", () => {
    const out = serializeState("Refactor auth", { summary: "Touch 12 files" });
    assert.equal(out, "Refactor auth\nContext:\n- summary: Touch 12 files");
    const bare = serializeState(undefined, { summary: "x" });
    assert.equal(bare, "Context:\n- summary: x");
  });

  test("non-string context values are JSON-stringified", () => {
    const out = serializeState("", {
      count: 42,
      flag: true,
      tags: ["a", "b"],
      nested: { x: 1 },
      nothing: null,
    });
    assert.ok(out.includes("- count: 42"), out);
    assert.ok(out.includes("- flag: true"), out);
    assert.ok(out.includes('- tags: ["a","b"]'), out);
    assert.ok(out.includes('- nested: {"x":1}'), out);
    assert.ok(out.includes("- nothing: null"), out);
  });

  test("caps the FINAL string at 8000 chars plus the truncation marker", () => {
    const out = serializeState("a".repeat(9000));
    assert.equal(out.length, MAX_STATE_CHARS + TRUNCATION_MARKER.length);
    assert.ok(out.endsWith(TRUNCATION_MARKER));
    const ctx = serializeState("base", { big: "z".repeat(9000) });
    assert.ok(ctx.endsWith(TRUNCATION_MARKER));
    assert.ok(serializeState("short").length < MAX_STATE_CHARS);
  });

  // M3 (KNOWN-FAIL, fixed in a later iteration): whole-string truncation
  // slices at 8000 chars, so one huge context value silently amputates every
  // sibling key rendered after it. The wanted behaviour is per-value
  // truncation that preserves sibling keys; until then this stays todo.
  test("M3: a large context value does NOT silently drop sibling keys", { todo: true }, () => {
    const out = serializeState("", { big: "x".repeat(7900), small: "keep-me" });
    assert.ok(out.includes("keep-me"), "sibling key 'small' was dropped by truncation");
    assert.ok(out.includes("big:"), "key 'big' itself must survive, truncated");
  });

  test("does not throw on BigInt / circular values", () => {
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    assert.doesNotThrow(() => serializeState("base", { n: 12n }));
    assert.doesNotThrow(() => serializeState("base", { o: circ }));
    assert.doesNotThrow(() => serializeState("base", { f: () => 1, s: Symbol("x") }));
    const out = serializeState("base", { n: 12n, o: circ });
    assert.ok(out.includes("- n: 12"), out);
    assert.ok(out.includes("- o: "), out);
  });
});

describe("fallback:true contract (offline failure paths only — no network)", () => {
  test("every decide() failure path starts with `fallback:true | `", async () => {
    const cases: Array<[string, Promise<string>]> = [
      ["empty state", decide("")],
      ["blank state", decide("   ")],
      ["array questions", decide("hello", [])],
      ["empty questions", decide("hello", {})],
      ["bad question type", decide("hello", { q: { type: "bogus", instructions: "i" } })],
      ["missing context entirely", decideWithContext(undefined, undefined)],
      ["blank state + null context", decideWithContext("  ", null)],
    ];
    for (const [name, p] of cases) {
      const text = await p;
      assert.equal(typeof text, "string", name);
      assert.ok(text.startsWith(FALLBACK_PREFIX), `${name}: ${JSON.stringify(text.slice(0, 60))}`);
    }
  });

  test("convenience wrappers never throw and keep the contract offline", async () => {
    const texts = await Promise.all([
      routeExpert(undefined, undefined),
      assessRisk(undefined, undefined),
      routeExpert("", null),
      assessRisk("   ", null),
    ]);
    for (const text of texts) {
      assert.equal(typeof text, "string");
      assert.ok(text.startsWith(FALLBACK_PREFIX), JSON.stringify(text.slice(0, 60)));
    }
  });
});

describe("log() structured stderr logging", () => {
  function captureStreams() {
    const origErr = process.stderr.write;
    const origOut = process.stdout.write;
    const errChunks: string[] = [];
    const outChunks: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test-only stream interception
    (process.stderr as any).write = (chunk: unknown) => {
      errChunks.push(String(chunk));
      return true;
    };
    // biome-ignore lint/suspicious/noExplicitAny: test-only stream interception
    (process.stdout as any).write = (chunk: unknown) => {
      outChunks.push(String(chunk));
      return true;
    };
    return {
      errChunks,
      outChunks,
      restore() {
        process.stderr.write = origErr;
        process.stdout.write = origOut;
      },
    };
  }

  test("writes JSON lines to stderr ONLY and redacts token + full state", () => {
    const prev = process.env.JEV_LOG;
    process.env.JEV_LOG = "debug";
    const cap = captureStreams();
    try {
      log("decide.done", {
        key_prefix: "abcd1234",
        token: "supersecret-token-xyz",
        state: "FULL SECRET STATE BODY", // 22 chars: must be replaced by state_chars
      });
      assert.equal(cap.outChunks.length, 0, "stdout is the JSON-RPC channel — never log there");
      assert.ok(cap.errChunks.length >= 1);
      const last = JSON.parse(cap.errChunks[cap.errChunks.length - 1]) as Record<string, unknown>;
      assert.equal(last["event"], "decide.done");
      const blob = JSON.stringify(last);
      assert.ok(!blob.includes("supersecret"), "bearer token must never appear in logs");
      assert.ok(!blob.includes("FULL SECRET STATE BODY"), "full state must never appear in logs");
      assert.equal(last["key_prefix"], "abcd1234");
      assert.equal(last["state_chars"], "FULL SECRET STATE BODY".length);
    } finally {
      cap.restore();
      if (prev === undefined) delete process.env.JEV_LOG;
      else process.env.JEV_LOG = prev;
    }
  });

  test("JEV_LOG gates levels, default is warn", () => {
    const prev = process.env.JEV_LOG;
    const cap = captureStreams();
    try {
      process.env.JEV_LOG = "error";
      log("decide.start", { state_chars: 1 }); // debug -> suppressed
      log("decide.done", { state_chars: 1 }); // info -> suppressed
      log("decide.fallback", { reason: "x" }); // warn -> suppressed at error
      log("rpc.invalid", { reason: "x" }); // warn -> suppressed at error
      assert.equal(cap.errChunks.length, 0);
      log("auth.error", { error: "x" }); // error -> emitted
      log("handle.crash", { where: "t" }); // error -> emitted
      assert.equal(cap.errChunks.length, 2);

      cap.errChunks.length = 0;
      delete process.env.JEV_LOG; // default warn
      log("decide.start", { state_chars: 1 }); // debug -> suppressed
      log("decide.done", { state_chars: 1 }); // info -> suppressed
      assert.equal(cap.errChunks.length, 0);
      log("decide.fallback", { reason: "x" }); // warn -> emitted
      log("rpc.invalid", { reason: "x" }); // warn -> emitted
      log("auth.error", { error: "x" }); // error -> emitted
      assert.equal(cap.errChunks.length, 3);
    } finally {
      cap.restore();
      if (prev === undefined) delete process.env.JEV_LOG;
      else process.env.JEV_LOG = prev;
    }
  });

  test("never throws on hostile fields", () => {
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    const prev = process.env.JEV_LOG;
    process.env.JEV_LOG = "debug";
    const cap = captureStreams();
    try {
      assert.doesNotThrow(() => log("decide.done", { big: 12n, o: circ }));
      assert.doesNotThrow(() => log("handle.crash", {}));
      assert.doesNotThrow(() => log("rpc.invalid"));
    } finally {
      cap.restore();
      if (prev === undefined) delete process.env.JEV_LOG;
      else process.env.JEV_LOG = prev;
    }
  });
});

describe("discoverPayload key contract", () => {
  test("top-level KEY names are unchanged (callers depend on them)", () => {
    const payload = discoverPayload() as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), [
      "code_mode_note",
      "context_note",
      "endpoint",
      "entry_shape",
      "examples",
      "model",
      "question_types",
      "recommended_usage",
      "score_semantics",
      "timeout_ms",
      "untrusted_input_note",
      "warning_422",
    ]);
  });
});

describe("server crash regression (spawns jev-server.ts, no network)", () => {
  test("feeding the line `null` replies -32600 and the process stays alive", async () => {
    const serverPath = fileURLToPath(new URL("./jev-server.ts", import.meta.url));
    const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
    const pending: Array<{ pred: (o: unknown) => boolean; resolve: (o: any) => void }> = [];
    const seen: unknown[] = [];
    let stdoutBuf = "";
    let settled = false;

    const onData = (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let obj: unknown;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        seen.push(obj);
        for (let i = pending.length - 1; i >= 0; i--) {
          if (pending[i].pred(obj)) {
            const [hit] = pending.splice(i, 1);
            hit.resolve(obj);
          }
        }
      }
    };
    child.stdout.on("data", onData);
    // Drain stderr (module-type warning + log lines) so the pipe never blocks.
    child.stderr.on("data", () => {});

    // Only replies that arrive AFTER the wait starts count: earlier replies
    // stay in `seen` and must not satisfy a later wait (otherwise every
    // -32600 wait would instantly match the stale `null` reply).
    const waitFor = (pred: (o: unknown) => boolean, ms: number): Promise<any> => {
      const startIdx = seen.length;
      for (let i = startIdx; i < seen.length; i++) if (pred(seen[i])) return Promise.resolve(seen[i]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = pending.findIndex((p) => p.resolve === resolve);
          if (idx >= 0) pending.splice(idx, 1);
          reject(new Error("timed out waiting for server reply"));
        }, ms);
        pending.push({
          pred,
          resolve: (o: unknown) => {
            clearTimeout(timer);
            resolve(o);
          },
        });
      });
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // already gone
      }
    };

    try {
      // THE regression: JSON.parse("null") succeeds yielding null; the old
      // `msg.id` deref threw, escaping as an unhandled rejection and killing
      // the process (exit 1). Now it must answer -32600 and survive.
      child.stdin.write("null\n");
      const nullReply = (await waitFor(
        (o) => typeof o === "object" && o !== null && (o as any).error?.code === -32600,
        15000,
      )) as any;
      assert.equal(nullReply.id, null);
      assert.equal(child.exitCode, null, "server died on `null` input");

      // Guards next to it: arrays and bare strings are valid JSON too.
      child.stdin.write("[1,2]\n");
      await waitFor((o) => typeof o === "object" && o !== null && (o as any).error?.code === -32600, 15000);
      child.stdin.write('"just a string"\n');
      await waitFor((o) => typeof o === "object" && o !== null && (o as any).error?.code === -32600, 15000);

      // Notifications (no id) get silence, not even an error.
      const before = seen.length;
      child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(seen.length, before, "notification drew a reply — must stay silent");

      // Proof of life: a normal request still works afterwards.
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
      const ping = (await waitFor(
        (o) => typeof o === "object" && o !== null && (o as any).id === 1,
        15000,
      )) as any;
      assert.deepEqual(ping.result, {});
      assert.equal(child.exitCode, null, "server died mid-session");
    } finally {
      finish();
      await new Promise((r) => child.on("close", r));
    }
  });
});
