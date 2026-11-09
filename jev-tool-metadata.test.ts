// jev tool metadata tests — Node builtin test runner, no new deps.
//
// Pins the MCP title + annotations added to all six tools in jev-server.ts
// without exceeding the tools/list byte budget (3650, measured live over
// stdio — the server's stdin listener must never attach to the test process,
// so the server is spawned, never imported).
// Run: node --test jev-tool-metadata.test.ts
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { discoverPayload } from "./jev-core.ts";

const EXPECTED_OPEN = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
  destructiveHint: false,
};
const EXPECTED_CLOSED = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
  destructiveHint: false,
};

async function fetchToolsList(): Promise<any[]> {
  const serverPath = fileURLToPath(new URL("./jev-server.ts", import.meta.url));
  const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    return await new Promise<any[]>((resolve, reject) => {
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
  } finally {
    try {
      child.kill();
    } catch {
      // already gone
    }
    await new Promise((r) => child.on("close", r));
  }
}

describe("server: tool titles + annotations (spawned, offline)", () => {
  test("all six tools carry a short title and read-only/idempotent annotations", async () => {
    const tools = await fetchToolsList();
    const byName = Object.fromEntries(tools.map((t: any) => [t.name, t]));
    // Only discover is closed-world (static payload); the other five hit the
    // network (zen endpoint / live selfcheck probe).
    const expectedByName: Record<string, typeof EXPECTED_OPEN> = {
      decide: EXPECTED_OPEN,
      route_expert: EXPECTED_OPEN,
      assess_risk: EXPECTED_OPEN,
      discover: EXPECTED_CLOSED,
      selfcheck: EXPECTED_OPEN,
      batch: EXPECTED_OPEN,
    };
    for (const name of ["decide", "route_expert", "assess_risk", "discover", "selfcheck", "batch"]) {
      const tool = byName[name];
      assert.ok(tool, `tools/list must include ${name}`);
      assert.equal(typeof tool.title, "string", `${name} needs a title`);
      assert.ok(tool.title.length > 0 && tool.title.length <= 20, `${name} title is short display text`);
      assert.deepEqual(tool.annotations, expectedByName[name], `${name} annotations`);
      assert.equal(tool.annotations.readOnlyHint, true, `${name} readOnlyHint`);
      assert.equal(tool.annotations.idempotentHint, true, `${name} idempotentHint`);
      assert.equal(
        tool.annotations.openWorldHint,
        name === "discover" ? false : true,
        `${name} openWorldHint`,
      );
    }
  });

  test("tools/list serialized bytes stay within budget", async () => {
    const tools = await fetchToolsList();
    const len = JSON.stringify({ tools }).length;
    assert.ok(len <= 3650, `tools/list is ${len} chars (budget 3650)`);
  });

  test("descriptions keep the fallback contract and the 422 warning", async () => {
    const tools = await fetchToolsList();
    const byName = Object.fromEntries(tools.map((t: any) => [t.name, t.description]));
    for (const name of ["decide", "route_expert", "assess_risk", "batch"]) {
      assert.ok(byName[name].includes("fallback:true"), `${name} must mention the fallback:true contract`);
    }
    assert.ok(byName.decide.includes("422"), "decide must keep the 422 warning");
    assert.ok(byName.discover.includes("422"), "discover must keep the 422 warning");
  });

  test("discover payload keys unchanged (17)", () => {
    assert.deepEqual(Object.keys(discoverPayload()).sort(), [
      "answers_note",
      "auth_mode",
      "batch_note",
      "code_mode_note",
      "confidence_note",
      "context_note",
      "endpoint",
      "entry_shape",
      "examples",
      "model",
      "question_types",
      "recommended_usage",
      "response_envelope",
      "score_semantics",
      "timeout_ms",
      "untrusted_input_note",
      "warning_422",
    ]);
  });
});
