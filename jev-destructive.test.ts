// jev destructive-hint tests — Node builtin test runner, no new deps.
//
// WHAT IT COVERS (offline — pure functions imported from jev-core.ts):
//   - the DESTRUCTIVE_PATTERNS catalogue: every family individually
//     (rm-recursive-force, wildcard x3, sql x3, vcs x3, disk x3,
//      extension-delete, filename-delete, extension-cleanup-dir,
//      path-segment-cleanup, prose-recursion, credential-operations,
//      fs-rmdir, disk-volume-destroy, vcs-branch-delete,
//      cloud-infra-destroy, network-firewall-block,
//      container-orchestration, db-object-drop)
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
  test("all twenty-six families are exported with a name, why, and RegExp", () => {
    // NOTE (extension-style change): was thirteen families; the four appended
    // entries below are the DELIBERATE catalogue extension for extension-style
    // and named deletion targets (no literal `*`). The original thirteen keep
    // their names, order, and behaviour — see git history.
    // NOTE (battle-test change): was seventeen families; the two appended
    // entries (prose-recursion, credential-operations) close the two live
    // misses from the 20-scenario battle test (recall 8/10 -> target 10/10,
    // precision held at 100%). The original seventeen keep their names,
    // order, and behaviour.
    // NOTE (systematic-vocabulary audit): was nineteen families; the seven
    // appended entries (fs-rmdir, disk-volume-destroy, vcs-branch-delete,
    // cloud-infra-destroy, network-firewall-block, container-orchestration,
    // db-object-drop — nineteen + seven = twenty-six) close whole
    // CATEGORIES after the held-out battle test showed recall 10/10 on the
    // driving set but 3/10 on fresh vocabulary. The original nineteen keep
    // their names, order, and behaviour; only this expected list grows.
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
        "fs-rmdir",
        "disk-volume-destroy",
        "vcs-branch-delete",
        "cloud-infra-destroy",
        "network-firewall-block",
        "container-orchestration",
        "db-object-drop",
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

describe("systematic-vocabulary audit: each new category fires and stays silent", () => {
  test("fs-rmdir: rmdir bare fires, rd /s|/q fires; bare del/rd stay silent", () => {
    assertFires("fs-rmdir", [
      "rmdir the node_modules directory and everything below it",
      "rmdir /s the build output directory",
      "RMDIR C:\\OLD_BUILD",
      "rd /s /q dist",
    ]);
    assertSilent("fs-rmdir", [
      "deliver the release notes",
      "read the docs",
      "remove the unused import",
    ]);
  });

  test("disk-volume-destroy: bulk-erase verb + data-store target, either order", () => {
    assertFires("disk-volume-destroy", [
      "shred -u the customer records archive",
      "overwrite the production database with an empty dump",
      "wipe the data volume and reformat it",
      "shred the decommissioned drive before disposal",
      "empty the recycle bin on the build agent",
      "erase the backup tapes offsite",
      "unmount the data volume before the snapshot",
    ]);
    assertSilent("disk-volume-destroy", [
      // Ambiguous verbs without a data-store target: routine prose or edits.
      "shred the cabbage for the coleslaw",
      "erase the whiteboard after standup",
      "overwrite the placeholder text",
      "empty the shopping cart before checkout",
      "empty the array before refilling it",
      "format the quarterly data as JSON",
      "overwrite the file with the new version",
      "clear the screen",
      "mount the data volume for reads",
    ]);
  });

  test("vcs-branch-delete: verb + branch, git branch -d/-D, git push --delete", () => {
    assertFires("vcs-branch-delete", [
      "purge the deleted release branches from the remote",
      "delete the stale feature branch",
      "git branch -D old-experiment",
      "git push origin --delete old-release",
    ]);
    assertSilent("vcs-branch-delete", [
      "create a branch for the feature",
      "merge the release branch into main",
      "checkout the main branch",
      "remove the unused import",
    ]);
  });

  test("cloud-infra-destroy: infra verb + infra noun, or verb + IAM role/policy", () => {
    assertFires("cloud-infra-destroy", [
      "terminate the EC2 instances in us-east-1 before the migration",
      "delete the S3 bucket holding the nightly backups",
      "decommission the staging servers over the weekend",
      "revoke the IAM role attached to the deploy user",
      "detach the EBS volume from the stopped instance",
      "destroy the staging cluster after the demo",
    ]);
    assertSilent("cloud-infra-destroy", [
      // Ambiguous verbs without an infra noun, or infra-adjacent nouns that
      // collide with everyday prose — under-match by design.
      "terminate the vendor contract at the end of Q3",
      "terminate the employee onboarding checklist",
      "destroy the enemy sprite when it leaves the screen",
      "remove the service worker registration in dev",
      "revoke the granted permission from the test user",
      "remove the role attribute from the component",
      "stop the web server before the deploy",
      "start the database before the tests",
    ]);
  });

  test("network-firewall-block: drop/delete/remove/flush + firewall noun, or block + L3 target", () => {
    assertFires("network-firewall-block", [
      "drop the inbound firewall rules on the edge router",
      "block all incoming traffic from 10.0.0.0/8",
      "flush the iptables chain on the bastion host",
      "remove the stale security group from the VPC",
    ]);
    assertSilent("network-firewall-block", [
      "block the calendar for focus time",
      "fix the code block rendering in the docs",
      "the build is blocked on a flaky test",
      "drop the kids off before standup",
      "add a keyboard shortcut",
    ]);
  });

  test("container-orchestration: verb + workload noun, or scale-to-zero shapes", () => {
    assertFires("container-orchestration", [
      "delete the staging namespace before the demo",
      "drain the worker node for kernel maintenance",
      "scale the API deployment to zero replicas overnight",
      "kubectl drain the node pool one host at a time",
      "set replicas: 0 on the preview environment",
      "evict the stuck pods from the node",
    ]);
    assertSilent("container-orchestration", [
      // `tree`, bare `release`, `service`, and `node version` are excluded.
      "add expand and collapse to the file tree view",
      "remove the release notes from the docs",
      "remove the service worker registration in dev",
      "scale the thumbnail images to 64 pixels",
      "remove the node version pin from CI",
      "add a namespace import to the C# project",
    ]);
  });

  test("db-object-drop: tight-window drop + object noun, or alter + schema/database", () => {
    assertFires("db-object-drop", [
      "drop the search index",
      "drop database analytics_prod",
      "DROP TABLE users",
      "drop the composite index on the orders table",
      "drop the production schema",
      "alter the warehouse schema to add the tenant column",
    ]);
    assertSilent("db-object-drop", [
      // Tight 2-word window: gapped prose stays silent (the score owns it).
      // `column`/`row` excluded: dataframe edits. `drop-down` hyphenated.
      "drop the mic at the launch party",
      "drop off the package then index the archive files",
      "Drop and recreate the users table",
      "drop the column from the dataframe",
      "alter the hem of the costume",
      "Fix the drop-down menu label styling",
      "index the archive files by date",
    ]);
  });

  test("credential-operations now covers certificate/cert/tls/ssl nouns", () => {
    assertFires("credential-operations", [
      "Revoke the signing certificate on the edge load balancer",
      "regenerate the TLS certificate on the API gateway",
      "rotate the expired SSL certs on the ingress",
    ]);
    assertSilent("credential-operations", [
      // `cache` is deliberately NOT a credential noun.
      "invalidate the React query cache on logout",
      "read the certificate transparency log",
    ]);
  });

  test("disk-format now covers reformat/re-format with the same device-target rule", () => {
    const re = patternFor("disk-format");
    re.lastIndex = 0;
    assert.equal(re.test("reformat the hard drive before disposal"), true);
    re.lastIndex = 0;
    assert.equal(re.test("re-format D: /q"), true);
    for (const s of ["reformatting the report", "I will format the currency", "format the quarterly data as JSON"]) {
      re.lastIndex = 0;
      assert.equal(re.test(s), false, `${JSON.stringify(s)} must stay silent`);
    }
  });
});

describe("held-out battle audit: the 7 misses now fire (verbatim)", () => {
  test("all seven held-out dangerous cases fire through the full wrapper", () => {
    for (const s of [
      "rmdir the node_modules directory and everything below it",
      "shred -u the customer records archive",
      "overwrite the production database with an empty dump",
      "Revoke the signing certificate on the edge load balancer",
      "purge the deleted release branches from the remote",
      "regenerate the TLS certificate on the API gateway",
      "wipe the data volume and reformat it",
    ]) {
      assert.equal(destructiveHint(s), true, `${JSON.stringify(s)} must fire`);
    }
  });
});

describe("held-out precision guard: the 14 protected benign cases stay silent (verbatim)", () => {
  test("all fourteen protected benign cases stay silent through the full wrapper", () => {
    for (const s of [
      "implement a recursive descent parser",
      "explain tail recursion",
      "the encryption key is derived from the user password",
      "update the tokenizer to handle unicode",
      "add a keyboard shortcut",
      "rotate the array left by n",
      "add a check that the cache expiry timestamp is in the past",
      "invalidate the React query cache on logout",
      "move the secret into vault",
      "the nested directories are walked by the build script",
      "add expand and collapse to the file tree view",
      "count the tokens consumed by the request",
      "replace the placeholder text in the template",
      "revoke the granted permission from the test user",
    ]) {
      assert.equal(destructiveHint(s), false, `${JSON.stringify(s)} must stay silent`);
    }
  });
});

describe("fresh operational cases (own invention, in neither battle set)", () => {
  test("fresh dangerous operational English fires", () => {
    for (const s of [
      "terminate the EC2 instances in us-east-1 before the migration",
      "delete the S3 bucket holding the nightly backups",
      "decommission the staging servers over the weekend",
      "revoke the IAM role attached to the deploy user",
      "drop the inbound firewall rules on the edge router",
      "block all incoming traffic from 10.0.0.0/8",
      "delete the staging namespace before the demo",
      "drain the worker node for kernel maintenance",
      "scale the API deployment to zero replicas overnight",
      "drop the composite index on the orders table",
      "alter the warehouse schema to add the tenant column",
      "rmdir /s the build output directory",
      "shred the decommissioned drive before disposal",
      "empty the recycle bin on the build agent",
    ]) {
      assert.equal(destructiveHint(s), true, `${JSON.stringify(s)} must fire`);
    }
  });

  test("fresh benign operational English stays silent", () => {
    for (const s of [
      "terminate the vendor contract at the end of Q3",
      "destroy the enemy sprite when it leaves the screen",
      "remove the service worker registration in dev",
      "fix the code block rendering in the docs",
      "drop the mic at the launch party",
      "drop off the package then index the archive files",
      "alter the hem of the costume",
      "scale the thumbnail images to 64 pixels",
      "add a namespace import to the C# project",
      "shred the cabbage for the coleslaw",
      "empty the shopping cart before checkout",
      "format the quarterly data as JSON",
    ]) {
      assert.equal(destructiveHint(s), false, `${JSON.stringify(s)} must stay silent`);
    }
  });
});
