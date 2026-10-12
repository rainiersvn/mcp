// jev batch tool tests — Node builtin test runner, no new deps.
//
// Covers decideBatch() in jev-core.ts (bounded-concurrency multi-question
// routing) plus the `batch` MCP tool wiring in jev-server.ts. All offline:
// the network is replaced by the injected `fetch` seam (deps.fetchImpl),
// except the live tools/list + validation-failure probes which spawn the
// server but never send a valid batch (no upstream traffic).
// Run: node --test jev-batch.test.ts
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  BATCH_DEFAULT_CONCURRENCY,
  BATCH_MAX_SIZE,
  _clearBearerCache,
  _clearJevCache,
  decideBatch,
  defaultQuestions,
  discoverPayload,
  riskQuestions,
} from "./jev-core.ts";

const FALLBACK_PREFIX = "fallback:true | ";

const okJson = (v: unknown) =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

// Echo fetch: answers carry the request state back, so order preservation and
// per-entry independence are directly observable in the results.
function echoDeps(extra: Record<string, unknown> = {}) {
  let calls = 0;
  const deps = {
    fetchImpl: async (_url: string, init?: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init?.body)) as { state: string };
      return okJson({ echoed: body.state });
    },
    token: "tok-test",
    now: () => 90_000_000,
    sleep: async (_ms: number) => {},
    rng: () => 0,
    ...extra,
  };
  return { deps, calls: () => calls };
}

function parseBatch(text: string): { results: string[]; summary: Record<string, number> } {
  assert.ok(!text.startsWith(FALLBACK_PREFIX), `batch must not fall back wholesale: ${text.slice(0, 120)}`);
  const p = JSON.parse(text) as { results: string[]; summary: Record<string, number> };
  assert.ok(Array.isArray(p.results), "results must be an array");
  assert.equal(typeof p.summary, "object", "summary must be an object");
  return p;
}

describe("decideBatch validation (no fetch calls)", () => {
  test("empty array -> clean validation error", async () => {
    _clearJevCache();
    _clearBearerCache();
    const { deps, calls } = echoDeps();
    const text = await decideBatch([], deps);
    assert.ok(text.startsWith(FALLBACK_PREFIX), text.slice(0, 80));
    assert.match(text, /non-empty/i);
    assert.equal(calls(), 0, "validation failure must not hit the network");
  });

  test("non-array -> clean validation error", async () => {
    _clearJevCache();
    _clearBearerCache();
    for (const bad of [undefined, null, "hello", 42, { state: "x" }]) {
      const { deps, calls } = echoDeps();
      const text = await decideBatch(bad, deps);
      assert.ok(text.startsWith(FALLBACK_PREFIX), `${JSON.stringify(bad)}: ${text.slice(0, 80)}`);
      assert.equal(calls(), 0, "validation failure must not hit the network");
    }
  });

  test("above cap -> clean validation error naming the cap", async () => {
    _clearJevCache();
    _clearBearerCache();
    assert.equal(BATCH_MAX_SIZE, 8);
    const { deps, calls } = echoDeps();
    const reqs = Array.from({ length: BATCH_MAX_SIZE + 1 }, (_, i) => ({ state: `over-cap-${i}` }));
    const text = await decideBatch(reqs, deps);
    assert.ok(text.startsWith(FALLBACK_PREFIX), text.slice(0, 120));
    assert.match(text, /8/, "error must name the cap");
    assert.equal(calls(), 0, "over-cap batch must not hit the network");
  });
});

describe("decideBatch envelopes (echo fetch)", () => {
  test("batch of 1 -> one envelope + summary", async () => {
    _clearJevCache();
    _clearBearerCache();
    const { deps } = echoDeps();
    const { results, summary } = parseBatch(await decideBatch([{ state: "solo task" }], deps));
    assert.equal(results.length, 1);
    assert.equal((JSON.parse(results[0]) as any).echoed, "solo task");
    assert.deepEqual(summary, { total: 1, ok: 1, fallback: 0, cached: 0 });
  });

  test("batch of 3 -> correct per-request envelopes in order", async () => {
    _clearJevCache();
    _clearBearerCache();
    const { deps } = echoDeps();
    const reqs = [
      { state: "first task" },
      { state: "second task", context: { files: ["a.ts"] } },
      { state: "third task", questions: riskQuestions() },
    ];
    const { results, summary } = parseBatch(await decideBatch(reqs, deps));
    assert.equal(results.length, 3);
    assert.equal((JSON.parse(results[0]) as any).echoed, "first task");
    assert.ok((JSON.parse(results[1]) as any).echoed.includes("a.ts"), "context must reach the pipeline");
    assert.equal((JSON.parse(results[2]) as any).echoed, "third task");
    for (const r of results) {
      const p = JSON.parse(r) as any;
      assert.equal(p._jev.format, 1, "every result carries the standard envelope");
    }
    assert.deepEqual(summary, { total: 3, ok: 3, fallback: 0, cached: 0 });
  });

  test("batch of 8 (cap) -> all envelopes", async () => {
    _clearJevCache();
    _clearBearerCache();
    const { deps, calls } = echoDeps();
    const reqs = Array.from({ length: 8 }, (_, i) => ({ state: `cap-task-${i}` }));
    const { results, summary } = parseBatch(await decideBatch(reqs, deps));
    assert.equal(results.length, 8);
    for (let i = 0; i < 8; i++) {
      assert.equal((JSON.parse(results[i]) as any).echoed, `cap-task-${i}`, `results[${i}] answers requests[${i}]`);
    }
    assert.deepEqual(summary, { total: 8, ok: 8, fallback: 0, cached: 0 });
    assert.equal(calls(), 8, "8 distinct states need 8 fetches");
  });

  test("mixed batch: valid entries survive, bad ones marked, batch does not throw", async () => {
    _clearJevCache();
    _clearBearerCache();
    const { deps } = echoDeps();
    const reqs = [
      { state: "good task" },
      { state: "   " }, // blank state -> per-entry fallback
      { state: "bad questions task", questions: [] }, // array shape -> per-entry fallback
      "not-an-object", // non-object entry -> per-entry fallback
      { context: { files: ["b.ts"] } }, // context-only entry is valid
    ];
    const { results, summary } = parseBatch(await decideBatch(reqs, deps));
    assert.equal(results.length, 5);
    assert.equal((JSON.parse(results[0]) as any).echoed, "good task");
    for (const i of [1, 2, 3]) {
      assert.ok(results[i].startsWith(FALLBACK_PREFIX), `results[${i}] must be marked: ${results[i].slice(0, 80)}`);
    }
    assert.ok((JSON.parse(results[4]) as any).echoed.includes("b.ts"), "context-only entry is valid");
    assert.deepEqual(summary, { total: 5, ok: 2, fallback: 3, cached: 0 });
  });

  test("same state under different questions -> independent fetches, no cross-contamination", async () => {
    _clearJevCache();
    _clearBearerCache();
    const { deps, calls } = echoDeps();
    const { results } = parseBatch(
      await decideBatch(
        [
          { state: "shared task", questions: defaultQuestions() },
          { state: "shared task", questions: riskQuestions() },
        ],
        deps,
      ),
    );
    assert.equal(results.length, 2);
    assert.equal(calls(), 2, "different question sets over the same state must not share a cache key");
    for (const r of results) assert.ok(!r.startsWith(FALLBACK_PREFIX));
  });
});

describe("decideBatch concurrency (instrumented fetch)", () => {
  async function runWithCounter(n: number, concurrency?: number) {
    _clearJevCache();
    _clearBearerCache();
    let active = 0;
    let maxActive = 0;
    const deps = {
      fetchImpl: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((r) => setTimeout(r, 30));
        active--;
        return okJson({ expert: "coder" });
      },
      token: "tok-test",
      now: () => 91_000_000,
      sleep: async (_ms: number) => {},
      rng: () => 0,
      ...(concurrency === undefined ? {} : { concurrency }),
    };
    const reqs = Array.from({ length: n }, (_, i) => ({ state: `conc-task-${i}` }));
    const { summary } = parseBatch(await decideBatch(reqs, deps));
    return { maxActive, summary };
  }

  test("default pool never exceeds the cap at any instant", async () => {
    assert.equal(BATCH_DEFAULT_CONCURRENCY, 4);
    const { maxActive, summary } = await runWithCounter(8);
    assert.ok(maxActive <= BATCH_DEFAULT_CONCURRENCY, `pool exceeded: ${maxActive} in flight`);
    assert.ok(maxActive > 1, `requests must overlap (pool of 1 would be serial): max was ${maxActive}`);
    assert.deepEqual(summary, { total: 8, ok: 8, fallback: 0, cached: 0 });
  });

  test("deps.concurrency overrides the pool (2)", async () => {
    const { maxActive, summary } = await runWithCounter(8, 2);
    assert.ok(maxActive <= 2, `pool of 2 exceeded: ${maxActive} in flight`);
    assert.deepEqual(summary, { total: 8, ok: 8, fallback: 0, cached: 0 });
  });

  test("garbage concurrency falls back to the default pool", async () => {
    for (const bad of [0, -3, NaN, 1.5]) {
      const { maxActive, summary } = await runWithCounter(4, bad);
      assert.ok(maxActive <= BATCH_DEFAULT_CONCURRENCY, `concurrency=${bad}: ${maxActive} in flight`);
      assert.equal(summary.ok, 4, `concurrency=${bad} must still complete`);
    }
  });
});

describe("decideBatch cache (second identical batch served from cache)", () => {
  test("repeat batch makes zero new fetches and reports cached", async () => {
    _clearJevCache();
    _clearBearerCache();
    const { deps, calls } = echoDeps();
    const reqs = [{ state: "cache task A" }, { state: "cache task B", context: { k: "v" } }];
    const first = parseBatch(await decideBatch(reqs, deps));
    assert.equal(calls(), 2);
    assert.deepEqual(first.summary, { total: 2, ok: 2, fallback: 0, cached: 0 });
    const second = parseBatch(await decideBatch(reqs, deps));
    assert.equal(calls(), 2, "second identical batch must not hit the network");
    assert.deepEqual(second.summary, { total: 2, ok: 2, fallback: 0, cached: 2 });
    assert.equal((JSON.parse(second.results[0]) as any)._jev.cached, "full");
  });
});

describe("discover documents batch", () => {
  test("batch_note names batch, pool cap, and size cap", () => {
    const payload = discoverPayload() as Record<string, unknown>;
    assert.ok("batch_note" in payload, "discover must document batch");
    const text = String(payload.batch_note);
    assert.match(text, /batch/i);
    assert.match(text, /pool\s*4|pool4/i, `must state the concurrency cap: ${text}`);
    assert.match(text, /max\s*8|max8/i, `must state the size cap: ${text}`);
  });

  test("batch key is purely additive; discover stays within budget", () => {
    const payload = discoverPayload() as Record<string, unknown>;
    for (const k of [
      "model",
      "endpoint",
      "timeout_ms",
      "question_types",
      "entry_shape",
      "warning_422",
      "context_note",
      "auth_mode",
      "untrusted_input_note",
      "score_semantics",
      "answers_note",
      "confidence_note",
      "recommended_usage",
      "response_envelope",
      "code_mode_note",
      "examples",
    ]) {
      assert.ok(k in payload, `existing key ${k} must survive`);
    }
    assert.ok(JSON.stringify(payload).length <= 1400, "discover budget holds");
  });
});

describe("server: batch tool wiring (spawned, offline)", () => {
  const serverPath = fileURLToPath(new URL("./jev-server.ts", import.meta.url));

  async function withServer<T>(fn: (call: (id: number, args: unknown) => Promise<any>, tools: any[]) => Promise<T>): Promise<T> {
    const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
    const seen: unknown[] = [];
    let stdoutBuf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          seen.push(JSON.parse(line));
        } catch {
          // ignore non-JSON stdout
        }
      }
    });
    child.stderr.on("data", () => {});
    const waitId = async (id: number): Promise<any> => {
      const startIdx = seen.length;
      const deadline = Date.now() + 15000;
      for (;;) {
        for (let i = startIdx; i < seen.length; i++) {
          const o = seen[i] as any;
          if (typeof o === "object" && o !== null && o.id === id) return o;
        }
        if (Date.now() > deadline) throw new Error(`timed out waiting for reply id ${id}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    const list = async (): Promise<any[]> => {
      const startIdx = seen.length;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 900, method: "tools/list" })}\n`);
      const deadline = Date.now() + 15000;
      for (;;) {
        for (let i = startIdx; i < seen.length; i++) {
          const o = seen[i] as any;
          if (typeof o === "object" && o !== null && o.id === 900) return o.result.tools;
        }
        if (Date.now() > deadline) throw new Error("timed out waiting for tools/list");
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    const call = async (id: number, args: unknown): Promise<any> => {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "batch", arguments: args } })}\n`,
      );
      return waitId(id);
    };
    try {
      return await fn(call, await list());
    } finally {
      try {
        child.kill();
      } catch {
        // already gone
      }
      await new Promise((r) => child.on("close", r));
    }
  }

  test("tools/list exposes batch with a tight description and a guarded schema", async () => {
    await withServer(async (_call, tools) => {
      const batch = tools.find((t: any) => t.name === "batch");
      assert.ok(batch, "tools/list must include batch");
      assert.ok(batch.description.length <= 200, `batch description is ${batch.description.length} chars (target <= 200)`);
      const firstSentence = batch.description.split(".")[0];
      assert.match(firstSentence, /batch/i, "first sentence must name batch");
      assert.ok(!/generic routing decision/i.test(firstSentence), "first sentence must differ from decide");
      const schema = batch.inputSchema;
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.required, ["requests"]);
      assert.equal(schema.properties.requests.maxItems, 8);
      assert.equal(schema.properties.requests.minItems, 1);
      assert.deepEqual(schema.properties.requests.items.anyOf, [{ required: ["state"] }, { required: ["context"] }]);
      assert.equal(schema.properties.requests.items.additionalProperties, false);
    });
  });

  test("batch validation failures keep the fallback contract without network", async () => {
    await withServer(async (call) => {
      for (const [id, args, needle] of [
        [31, {}, "requests"],
        [32, { requests: [] }, "non-empty"],
        [33, { requests: "nope" }, "non-empty"],
        [34, { requests: Array.from({ length: 9 }, (_, i) => ({ state: `s${i}` })) }, "max 8"],
      ] as Array<[number, unknown, string]>) {
        const reply = await call(id, args);
        assert.ok(!("error" in reply), `must be a result, not a JSON-RPC error: ${JSON.stringify(reply)}`);
        assert.equal(reply.result?.isError, true);
        const text = reply.result?.content?.[0]?.text as string;
        assert.ok(text.startsWith(FALLBACK_PREFIX), JSON.stringify(text.slice(0, 80)));
        assert.ok(text.includes(needle), JSON.stringify(text.slice(0, 160)));
      }
    });
  });
});
