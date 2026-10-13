// jev selfcheck harness — operator diagnosis, fully offline.
// Covers: offline (zero network calls), online 200 (reachable), online 429
// (RATE LIMITED, still ok:true), online 401 (CREDENTIAL, distinct wording),
// network throw (unreachable, distinct again), no fallback prefix anywhere,
// malformed/absent config never crashing, and the tools/list entry (tight
// description + no-arg schema). The live upstream is NOT touched: every
// online path uses an injected fetch.
// Conventions mirror jev-core.test.ts (node builtin runner, no new deps).
//
//     node --test jev-selfcheck.test.ts
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CACHE_CAP,
  CHOICE_TTL_MS,
  DESTRUCTIVE_PATTERNS,
  FIRST_ATTEMPT_TIMEOUT_MS,
  MAX_ATTEMPTS,
  OVERALL_BUDGET_MS,
  SCORE_TTL_MS,
  selfcheck,
} from "./jev-core.ts";

const FALLBACK_PREFIX = "fallback:true | ";

const okJson = (v: unknown) =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const statusResp = (status: number, body: string, headers?: Record<string, string>) =>
  new Response(body, { status, headers });

// Env hygiene: tests flip JEV_SELFCHECK_LIVE / JEV_BEARER, always restored.
function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

describe("selfcheck offline (JEV_SELFCHECK_LIVE=0 / live:false)", () => {
  test("makes ZERO network calls, returns all static/config facts, never throws", async () => {
    let calls = 0;
    const text = await selfcheck({
      live: false,
      fetchImpl: async () => {
        calls++;
        return okJson({ never: "used" });
      },
    });
    assert.equal(calls, 0, "offline variant must not touch the network");
    assert.ok(!text.startsWith(FALLBACK_PREFIX), "diagnostic, not a decision: no fallback prefix");
    const p = JSON.parse(text) as Record<string, unknown>;
    assert.equal(p.ok, true);
    assert.ok(String(p.upstream).includes("offline"), `upstream says offline: ${p.upstream}`);
    assert.ok(String(p.mode).includes("0 calls"));
    assert.ok(typeof p.auth_mode === "string" && String(p.auth_mode).length > 0);
    assert.equal(p.budget_ms, OVERALL_BUDGET_MS);
    assert.equal(p.first_attempt_ms, FIRST_ATTEMPT_TIMEOUT_MS);
    assert.equal(p.max_attempts, MAX_ATTEMPTS);
    assert.equal(p.client_timeout_ms, 15_000);
    assert.ok((p.budget_headroom_ms as number) > 0, "budget stays under the 15s client timeout");
    assert.equal(typeof p.cache_entries, "number");
    assert.equal(p.choice_ttl_ms, CHOICE_TTL_MS);
    assert.equal(p.score_ttl_ms, SCORE_TTL_MS);
    assert.equal(p.cache_cap, CACHE_CAP);
    assert.equal(p.destructive_families, DESTRUCTIVE_PATTERNS.length);
    assert.ok(String(p.catalogue).startsWith("ok"), `catalogue health: ${p.catalogue}`);
    assert.ok(typeof p.model === "string" && typeof p.version === "string");
  });

  test("env JEV_SELFCHECK_LIVE=0 alone forces offline even with default deps", async () => {
    await withEnv({ JEV_SELFCHECK_LIVE: "0" }, async () => {
      let calls = 0;
      const text = await selfcheck({
        fetchImpl: async () => {
          calls++;
          throw new Error("must never be called");
        },
      });
      assert.equal(calls, 0);
      const p = JSON.parse(text) as Record<string, unknown>;
      assert.equal(p.ok, true);
      assert.ok(String(p.upstream).includes("offline"));
    });
  });
});

describe("selfcheck online with injected fetch (no live network)", () => {
  test("200 => reachable, exactly ONE call (no retry)", async () => {
    let calls = 0;
    const text = await selfcheck({
      live: true,
      token: "tok-test",
      fetchImpl: async () => {
        calls++;
        return okJson({ answers: {} });
      },
    });
    assert.equal(calls, 1, "probe is exactly one call, never retried");
    assert.ok(!text.startsWith(FALLBACK_PREFIX));
    const p = JSON.parse(text) as Record<string, unknown>;
    assert.equal(p.ok, true);
    assert.ok(String(p.upstream).includes("reachable"), `upstream: ${p.upstream}`);
    assert.ok(!String(p.upstream).includes("unreachable"), `reachable must not read as unreachable: ${p.upstream}`);
  });

  test("429 => RATE LIMITED (status, message, retry-after), still ok:true, one call", async () => {
    let calls = 0;
    const text = await selfcheck({
      live: true,
      token: "tok-test",
      fetchImpl: async () => {
        calls++;
        return statusResp(429, "FreeUsageLimitError: free tier limit exceeded", { "retry-after": "8" });
      },
    });
    assert.equal(calls, 1, "rate-limited probe must not retry");
    assert.ok(!text.startsWith(FALLBACK_PREFIX), "a rate limit is a successful self-check, not a failure");
    const p = JSON.parse(text) as Record<string, unknown>;
    assert.equal(p.ok, true, "rate limit reports success-with-a-caveat");
    const u = String(p.upstream);
    assert.ok(u.includes("RATE LIMITED"), `greppable rate-limit marker: ${u}`);
    assert.ok(u.includes("429"), `names the status: ${u}`);
    assert.ok(u.includes("FreeUsageLimitError"), `carries the upstream message: ${u}`);
    assert.ok(u.includes("retry after 8s"), `carries retry-after: ${u}`);
    assert.ok(!u.includes("CREDENTIAL"), "rate-limit wording must not read as a credential problem");
  });

  test("401 => CREDENTIAL problem, clearly distinct from the rate-limit wording", async () => {
    let calls = 0;
    const text = await selfcheck({
      live: true,
      token: "tok-test",
      fetchImpl: async () => {
        calls++;
        return statusResp(401, "Invalid credential");
      },
    });
    assert.equal(calls, 1);
    assert.ok(!text.startsWith(FALLBACK_PREFIX));
    const p = JSON.parse(text) as Record<string, unknown>;
    assert.equal(p.ok, true);
    const u = String(p.upstream);
    assert.ok(u.includes("CREDENTIAL"), `greppable credential marker: ${u}`);
    assert.ok(u.includes("401"), `names the status: ${u}`);
    assert.ok(!u.includes("RATE LIMITED"), "credential wording must not read as a rate limit");
    assert.ok(!u.includes("retry after"), "credential wording carries no retry-after");
  });

  test("thrown network error => unreachable/network, distinct from both above", async () => {
    let calls = 0;
    const text = await selfcheck({
      live: true,
      token: "tok-test",
      fetchImpl: async () => {
        calls++;
        throw new Error("socket hangup xyz");
      },
    });
    assert.equal(calls, 1, "network failure is reported, not retried (probe is one call)");
    assert.ok(!text.startsWith(FALLBACK_PREFIX));
    const p = JSON.parse(text) as Record<string, unknown>;
    assert.equal(p.ok, true, "the check ran fine; it is the upstream that is down");
    const u = String(p.upstream);
    assert.ok(u.includes("unreachable"), `greppable network marker: ${u}`);
    assert.ok(u.includes("network"), `says network: ${u}`);
    assert.ok(!u.includes("RATE LIMITED"), "network wording must not read as a rate limit");
    assert.ok(!u.includes("CREDENTIAL"), "network wording must not read as a credential problem");
  });
});

describe("selfcheck never crashes on malformed/absent config", () => {
  test("JEV_BEARER=1 with no readable key degrades to fields, not a throw", async () => {
    await withEnv({ JEV_BEARER: "1", JEV_SELFCHECK_LIVE: undefined }, async () => {
      const text = await selfcheck({ live: false });
      assert.ok(!text.startsWith(FALLBACK_PREFIX));
      const p = JSON.parse(text) as Record<string, unknown>;
      assert.equal(p.ok, true);
      assert.ok(String(p.auth_mode).includes("bearer"), `opt-in reported: ${p.auth_mode}`);
      assert.equal(typeof p.credential_present, "boolean");
    });
  });

  test("no-arg call with offline env parses and reports ok", async () => {
    await withEnv({ JEV_SELFCHECK_LIVE: "0", JEV_BEARER: undefined }, async () => {
      const text = await selfcheck();
      const p = JSON.parse(text) as Record<string, unknown>;
      assert.equal(p.ok, true);
    });
  });
});

describe("selfcheck tools/list entry (spawned server, no network)", () => {
  test("exposes selfcheck with a tight no-arg schema", async () => {
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
      const sc = tools.find((t: any) => t.name === "selfcheck");
      assert.ok(sc, "tools/list must include selfcheck");
      assert.ok(sc.description.length <= 200, `selfcheck description is ${sc.description.length} chars (target <= 200)`);
      assert.match(sc.description.split(".")[0], /selfcheck/i, "first sentence must name selfcheck");
      assert.deepEqual(sc.inputSchema.properties, {});
      assert.equal(sc.inputSchema.additionalProperties, false);
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
