// jev destructive-hint tests — Node builtin test runner, no new deps.
//
// WHAT IT COVERS (offline — pure functions imported from jev-core.ts):
//   - the DESTRUCTIVE_PATTERNS catalogue: every family individually
//     (rm-recursive-force, wildcard x3, sql x3, vcs x3, disk x3,
//      extension-delete, filename-delete, extension-cleanup-dir,
//      path-segment-cleanup, prose-recursion, credential-operations)
//   - REGRESSION guards for the two confirmed live misses:
//     "Delete every *.tmp file in the workspace" and "remove *.log"
//   - REGRESSION guards for the extension-style live misses (tmp-clearing
//     phrasings with no literal `*`: "Remove the .tmp artifacts ...",
//     "delete .tmp files", "wipe the .log files", "remove all .bak files",
//     "delete the .cache directory")
//   - false-positive guards (benign phrasing that must stay silent)
//   - case-insensitivity + mid-sentence imperatives
//   - destructiveHint(state) stays a backward-compatible boolean OR
//
// HOW TO RUN (from this directory):
//     node --test jev-destructive.test.ts
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { DESTRUCTIVE_PATTERNS, destructiveHint } from "./jev-core.ts";

function patternFor(name: string): RegExp {
  const found = DESTRUCTIVE_PATTERNS.find((p) => p.name === name);
  assert.ok(found, `pattern family "${name}" must be exported`);
  assert.ok(found.pattern instanceof RegExp, `${name}: pattern must be a RegExp`);
  assert.equal(typeof found.why, "string", `${name}: why must document the family`);
  return found.pattern;
}

function assertFires(name: string, states: string[]): void {
  const re = patternFor(name);
  for (const s of states) {
    re.lastIndex = 0;
    assert.equal(re.test(s), true, `[${name}] must fire on ${JSON.stringify(s)}`);
  }
}

function assertSilent(name: string, states: string[]): void {
  const re = patternFor(name);
  for (const s of states) {
    re.lastIndex = 0;
    assert.equal(re.test(s), false, `[${name}] must stay silent on ${JSON.stringify(s)}`);
  }
}

describe("destructiveHint catalogue (each family individually)", () => {
  test("all nineteen families are exported with a name, why, and RegExp", () => {
    // NOTE (extension-style change): was thirteen families; the four appended
    // entries below are the DELIBERATE catalogue extension for extension-style
    // and named deletion targets (no literal `*`). The original thirteen keep
    // their names, order, and behaviour — see git history.
    // NOTE (battle-test change): was seventeen families; the two appended
    // entries (prose-recursion, credential-operations) close the two live
    // misses from the 20-scenario battle test (recall 8/10 -> target 10/10,
    // precision held at 100%). The original seventeen keep their names,
    // order, and behaviour.
    assert.deepEqual(
      DESTRUCTIVE_PATTERNS.map((p) => p.name),
      [
        "rm-recursive-force",
        "wildcard-delete-quantified",
        "wildcard-delete-glob",
        "rm-star",
        "sql-drop",
        "sql-truncate",
        "sql-delete-from",
        "vcs-force-push",
        "vcs-git-push-force",
        "vcs-reset-hard",
        "disk-mkfs",
        "disk-dd",
        "disk-format",
        "extension-delete",
        "filename-delete",
        "extension-cleanup-dir",
        "path-segment-cleanup",
        "prose-recursion",
        "credential-operations",
      ],
    );
  });

  test("rm-recursive-force: combined and split flags, any order/spacing", () => {
    assertFires("rm-recursive-force", [
      "rm -rf /",
      "RM -RF /",
      "rm -fr /tmp",
      "rm -r -f dir",
      "rm -f -r dir",
      "rm  -rf  /tmp",
      "sudo rm -rf /",
      "rm --recursive --force .",
      "please rm -rf /tmp/cache",
      "run rm -rf / on the build directory",
    ]);
    // Lone -r is recursive but not force: documented under-match.
    // "harm" must not read as the rm command.
    assertSilent("rm-recursive-force", ["rm -r old-cache", "rm file.txt", "harm -rf x"]);
  });

  test("wildcard-delete-quantified: verb + bulk quantifier + bare star, any order", () => {
    assertFires("wildcard-delete-quantified", [
      "delete everything *",
      "delete all *.tmp",
      "Delete every *.tmp file in the workspace",
      "wipe all *",
      "nuke everything *",
      "DELETE ALL *",
    ]);
    assertSilent("wildcard-delete-quantified", [
      "the file was removed yesterday",
      "remove the unused import",
    ]);
  });

  test("wildcard-delete-glob: verb + file-ish glob, any order", () => {
    assertFires("wildcard-delete-glob", [
      "remove *.log",
      "Delete every *.tmp file in the workspace",
      "please delete *.tmp files",
      "wipe **/* now",
      "purge *.cache files",
      "unlink *.pid",
    ]);
    assertSilent("wildcard-delete-glob", [
      "the file was removed yesterday",
      "remove the unused import",
      "refactor the auth module",
    ]);
  });

  test("rm-star: rm is never prose, so rm + any star fires", () => {
    assertFires("rm-star", ["rm *", "rm *.log"]);
    assertSilent("rm-star", ["confirm the firmware update", "perform nightly cleanup"]);
  });

  test("sql-drop: adjacent canonical drop table|database", () => {
    assertFires("sql-drop", ["drop table users", "Drop Table Users", "DROP DATABASE prod"]);
    // Hyphenated / single-word lookalikes stay silent.
    assertSilent("sql-drop", ["drop-down menu", "add a dropdown"]);
  });

  test("sql-truncate: bare word only", () => {
    assertFires("sql-truncate", ["truncate logs", "truncate the audit log", "TRUNCATE TABLE audit"]);
    assertSilent("sql-truncate", ["truncated response"]);
  });

  test("sql-delete-from: adjacent delete from", () => {
    assertFires("sql-delete-from", ["delete from users", "DELETE FROM logs"]);
    // Gapped prose stays silent (the score, not the hint, owns it).
    assertSilent("sql-delete-from", ["delete the file from the repo"]);
  });

  test("vcs: force-push, git push --force/-f, reset --hard", () => {
    assertFires("vcs-force-push", ["git force-push origin main"]);
    assertFires("vcs-git-push-force", [
      "git push --force origin main",
      "git push origin main --force",
      "git push -f origin",
    ]);
    assertFires("vcs-reset-hard", ["git reset --hard HEAD", "reset --hard"]);
    assertSilent("vcs-git-push-force", ["git push origin main"]);
    // Bare `reset` (e.g. passwords) never fires.
    assertSilent("vcs-reset-hard", ["reset the password"]);
  });

  test("disk: mkfs, dd of=/dev/, format with device target", () => {
    assertFires("disk-mkfs", ["mkfs.ext4 /dev/sda1", "run mkfs on the disk"]);
    assertFires("disk-dd", ["dd if=/dev/zero of=/dev/sda", "dd if=firmware.bin of=/dev/sdb"]);
    assertFires("disk-format", [
      "format C:",
      "format /dev/sda1",
      "format the disk",
      "Please format D: /q",
      "format the hard drive",
    ]);
    // "formatting" has no word boundary; currency has no device target.
    assertSilent("disk-format", ["formatting the report", "I will format the currency"]);
  });
});

describe("destructiveHint wrapper (backward-compatible boolean OR)", () => {
  test("REGRESSION: the two confirmed live misses now fire", () => {
    assert.equal(destructiveHint("Delete every *.tmp file in the workspace"), true);
    assert.equal(destructiveHint("remove *.log"), true);
  });

  test("false-positive guards stay silent", () => {
    for (const s of [
      "formatting the report",
      "truncated response",
      "drop-down menu",
      "add a dropdown",
      "I will format the currency",
      "the file was removed yesterday",
      // Judgement call, documented in jev-core.ts: a single scoped target
      // with no wildcard/flag/device is a routine code edit, not a shape.
      "remove the unused import",
      "refactor the auth module",
      "clear the screen",
      "clean up the build",
    ]) {
      assert.equal(destructiveHint(s), false, `${JSON.stringify(s)} must stay silent`);
    }
  });

  test("case-insensitive, any spacing, mid-sentence imperatives", () => {
    for (const s of [
      "RM -RF /",
      "Drop Table Users",
      "Please DELETE EVERY *.tmp File",
      "before lunch, format C: and reboot",
    ]) {
      assert.equal(destructiveHint(s), true, `${JSON.stringify(s)} must fire`);
    }
  });

  test("stays a boolean hint (never an escalation, never throws)", () => {
    assert.equal(destructiveHint("hello world"), false);
    assert.equal(destructiveHint("rm -rf /"), true);
    assert.equal(typeof destructiveHint("anything"), "boolean");
  });
});

describe("extension-style deletion targets (no literal `*`)", () => {
  test("extension-delete: strong verb + standalone dot-extension, no quantifier needed", () => {
    assertFires("extension-delete", [
      "Remove the .tmp artifacts left over from the previous run.",
      "delete .tmp files",
      "wipe the .log files",
      "remove all .bak files",
      "delete the .cache directory",
      "purge *.tmp",
      "DELETE .TMP FILES",
      "the .tmp files to delete",
      "rm -r .tmp",
    ]);
    assertSilent("extension-delete", [
      // Weak clean/clear verbs need the corroborated family below.
      "clean up .DS_Store",
      "clear the screen",
      "clean up the build",
      // No destructive verb at all.
      "bump the version to 2.5.1",
      "update the config in ./.config/opencode",
      "read the file src/index.ts",
      "rename foo.ts to bar.ts",
      "v1.2.3 is deprecated",
      // Strong verb but no dot-extension.
      "remove the unused import",
      "the file was removed yesterday",
      // Domains keep the leading boundary: letter-before-dot is not standalone.
      "remove example.com from the allowlist",
    ]);
  });

  test("filename-delete: strong verb + attached known-artifact filename only", () => {
    assertFires("filename-delete", [
      "delete foo.tmp",
      "remove the cache.log before retrying",
      "wipe data.bak",
      "purge old.orig",
    ]);
    assertSilent("filename-delete", [
      // Domains and source files are not artifact types.
      "remove example.com from the allowlist",
      "read the file src/index.ts",
      "rename foo.ts to bar.ts",
      "remove src/index.ts",
      // No destructive verb.
      "bump the version to 2.5.1",
      "v1.2.3 is deprecated",
    ]);
  });

  test("extension-cleanup-dir: weak clean/clear needs directory, quantifier, or slash", () => {
    assertFires("extension-cleanup-dir", [
      "clean the .cache directory",
      "clear all .tmp files",
      "clean up every .log file",
      "clean build/.cache",
    ]);
    assertSilent("extension-cleanup-dir", [
      // JUDGEMENT CALL, documented in jev-core.ts: wiping one stray .DS_Store
      // is routine desktop hygiene, not a destructive shape. A hint firing on
      // every .DS_Store mention trains callers to ignore it — worse than the
      // miss, which the caller can still reason about. Strong verbs on the
      // same target ("delete the .DS_Store file") still fire via
      // extension-delete.
      "clean up .DS_Store",
      "clear the screen",
      "clean up the build",
      "perform nightly cleanup",
    ]);
  });

  test("path-segment-cleanup: verb + slash-path with deletion signal", () => {
    assertFires("path-segment-cleanup", [
      "remove ./tmp",
      "clean build/.cache",
      "clear dist/.cache",
      "clean up the build/.cache directory",
    ]);
    assertSilent("path-segment-cleanup", [
      // Verb is not destructive/cleanup — the path alone never fires.
      "update the config in ./.config/opencode",
      "read the file src/index.ts",
      // No slash-path at all.
      "clean up the build",
      "clear the screen",
      "delete .tmp files",
    ]);
  });

  test("REGRESSION: tmp-clearing phrasings without `*` now fire (6 of 7)", () => {
    // Baseline was 2 of 7; "purge *.tmp" already fired via the glob family.
    // Five of the six silent ones describe genuinely destructive intent and
    // now fire; "clean up .DS_Store" stays silent by the judgement call above.
    assert.equal(destructiveHint("Remove the .tmp artifacts left over from the previous run."), true);
    assert.equal(destructiveHint("delete .tmp files"), true);
    assert.equal(destructiveHint("wipe the .log files"), true);
    assert.equal(destructiveHint("remove all .bak files"), true);
    assert.equal(destructiveHint("delete the .cache directory"), true);
    assert.equal(destructiveHint("purge *.tmp"), true);
    assert.equal(destructiveHint("clean up .DS_Store"), false);
  });

  test("required benign list stays silent (false-positive discipline)", () => {
    for (const s of [
      "bump the version to 2.5.1",
      "update the config in ./.config/opencode",
      "read the file src/index.ts",
      "the drop-down menu",
      "formatting the report",
      "rename foo.ts to bar.ts",
      "add a trailing newline",
      "v1.2.3 is deprecated",
      // Neighbouring guards: single scoped targets without wildcard/flag/
      // device/extension stay routine edits, not shapes.
      "remove the unused import",
      "remove src/index.ts",
      "remove example.com from the allowlist",
      "rm -r old-cache",
    ]) {
      assert.equal(destructiveHint(s), false, `${JSON.stringify(s)} must stay silent`);
    }
  });

  test("every pattern is /i without /g and .test() is stateless across repeats", () => {
    for (const { name, pattern } of DESTRUCTIVE_PATTERNS) {
      assert.equal(pattern.ignoreCase, true, `[${name}] must be case-insensitive (/i)`);
      assert.equal(pattern.global, false, `[${name}] must NOT be /g (lastIndex state corrupts .test())`);
      assert.equal(pattern.sticky, false, `[${name}] must NOT be /y`);
    }
    // Interleaved repeat calls on a matching and a non-matching string must
    // be stable — guards the /g lastIndex footgun at the wrapper level too.
    const hit = "Remove the .tmp artifacts left over from the previous run.";
    const miss = "bump the version to 2.5.1";
    for (let i = 0; i < 5; i++) {
      assert.equal(destructiveHint(hit), true, `repeat ${i}: hit must stay true`);
      assert.equal(destructiveHint(miss), false, `repeat ${i}: miss must stay false`);
      assert.equal(destructiveHint(hit), true, `repeat ${i}: hit must stay true (2nd)`);
    }
    for (const { name, pattern } of DESTRUCTIVE_PATTERNS) {
      const h = pattern.test(hit);
      pattern.lastIndex = 0;
      const h2 = pattern.test(hit);
      assert.equal(h, h2, `[${name}] must give stable results across consecutive .test() calls`);
    }
  });
});

describe("battle-test extension: prose recursion + credential operations", () => {
  test("prose-recursion: destructive verb + recursion cue, either order", () => {
    assertFires("prose-recursion", [
      // Battle miss A9 (regression guard lives at the wrapper level below).
      "remove all the generated files recursively",
      "delete the whole tree",
      "wipe the entire directory tree",
      "purge the nested directories",
      "clear all subdirectories",
      "delete the build output and subdirectories",
      "recursively remove the generated files",
      "REMOVE ALL THE GENERATED FILES RECURSIVELY",
      "unlink the entire tree",
      "wipe the whole directory tree",
    ]);
    assertSilent("prose-recursion", [
      // Recursion as a PROGRAMMING concept, not an operation: no
      // destructive verb present, so the verb requirement keeps these silent
      // (the bare-`recursive` programming-noun guard is belt-and-braces).
      "the recursive function walks the tree",
      "recurse through the directory tree",
      "write a recursive descent parser",
      "recursive fibonacci in the docs",
      // Destructive verb but no recursion cue.
      "remove the unused import",
      "delete the file from the repo",
      "clear the screen",
      "clean up the build",
      "refactor the auth module",
      // Lone -r prose: the flag family owns it, not this one.
      "rm -r old-cache",
    ]);
  });

  test("credential-operations: credential verb + credential noun, bare pair fires", () => {
    assertFires("credential-operations", [
      // Battle miss A10 (regression guard lives at the wrapper level below).
      "Rotate the production API secret in all deployments",
      "revoke the live token",
      "replace the API key",
      "regenerate the database password",
      "invalidate all credentials",
      "expire the session token",
      // Reversed order + noun form: the secret comes first, `rotation` is
      // the canonical nominalization this family admits.
      "the production secret needs rotation",
      "ROTATE THE PRODUCTION SECRET",
      "revoked API keys must be replaced",
    ]);
    assertSilent("credential-operations", [
      // Each lacks one side of the verb+noun pair — the highest
      // false-positive-risk family in the catalogue, so both sides are
      // strict word shapes (see jev-core.ts).
      "rotate the wheel icon",
      "the key to success",
      "replace the placeholder text",
      "tokenize the input string",
      "password manager autofills the field",
      "rotate through the array indices",
      // `reset` is deliberately NOT a credential verb: routine account
      // prose, and admitting it would fire on every password-reset mention.
      "reset the password",
      // Credential noun but no credential verb.
      "read the API key from the vault",
      "remove the unused import",
      "refactor the auth module",
    ]);
  });

  test("REGRESSION: battle misses A9 and A10 now fire", () => {
    assert.equal(destructiveHint("remove all the generated files recursively"), true);
    assert.equal(destructiveHint("Rotate the production API secret in all deployments"), true);
  });

  test("battle benign group (B1-B10) stays silent through the full wrapper", () => {
    for (const s of [
      "Fix a typo in a code comment",
      "Change button padding from 4px to 8px",
      "Rename local variable x to userCount",
      "Bump the package version to 2.5.1",
      "Update the README install instructions",
      "Fix formatting of the quarterly report",
      "Fix the drop-down menu label styling",
      "Update settings in ./.config/opencode.json",
      "Add a unit test for the retry helper",
      "Write a docstring for the public API",
    ]) {
      assert.equal(destructiveHint(s), false, `${JSON.stringify(s)} must stay silent`);
    }
  });
});
