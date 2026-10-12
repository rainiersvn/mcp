// Capture REAL upstream responses as golden fixtures.
// These become the contract the test suite asserts against, so fixture drift
// (upstream shape changes) fails tests instead of silently shipping.
import { writeFileSync } from "node:fs"

const ENDPOINT = "https://opencode.ai/zen/v1/systemone"
const MODEL = "jev-1.13-free"

const CHOICE = (name, instructions, criteria) => ({ [name]: { type: "choice", instructions, criteria } })
const SCORE = (name, instructions, criteria) => ({ [name]: { type: "score", instructions, criteria } })

const CASES = [
  { name: "route_expert_simple", state: "Add retry logic to the billing worker",
    questions: { ...CHOICE("expert", "Which expert should handle this request?", { planner: "Planning, decomposition, or deciding next steps", coder: "Implementation, code changes, or file edits", reviewer: "Validation, code review, or correctness checks" }),
                 ...SCORE("needs_review", "How much review does this request need?", ["No review needed", "Light review", "Review needed", "Careful review required"]) } },
  { name: "assess_risk_only", state: "Drop and recreate the users table",
    questions: SCORE("needs_review", "How much review does this request need given its blast radius?", ["No review needed", "Light review", "Review needed", "Careful review required"]) },
  { name: "choice_only", state: "Refactor the auth module",
    questions: CHOICE("expert", "Which expert should handle this request?", { planner: "Planning", coder: "Implementation", reviewer: "Validation" }) },
  { name: "noul_type", state: "Summarize this changelog",
    questions: { verdict: { type: "noul", instructions: "Any safety concern with this task?" } } },
  { name: "destructive_state", state: "run rm -rf / on the build directory",
    questions: SCORE("needs_review", "How much review does this request need given its blast radius?", ["No review needed", "Light review", "Review needed", "Careful review required"]) },
]

const out = {}
for (const c of CASES) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, state: c.state, questions: c.questions }),
  })
  const text = await res.text()
  if (!res.ok) { console.error(`FAIL ${c.name}: HTTP ${res.status} ${text.slice(0, 200)}`); continue }
  out[c.name] = { status: res.status, state: c.state, body: JSON.parse(text) }
  console.log(`ok ${c.name} (${text.length}B)`)
}
writeFileSync("jev-goldens.json", JSON.stringify(out, null, 2))
console.log(`\nwrote jev-goldens.json with ${Object.keys(out).length} cases`)