# Validation summary

This is what has been validated, how, and what has not. Dates are 2026-11-26/27.

## Environments

| Where | Node | PostgreSQL | Result |
|---|---|---|---|
| Local, macOS (arm64) | 26.3.1 | 16.14 (Homebrew) | typecheck ✅, 145/145 tests ✅, demo 6/6 ✅, storefront tests 7/7 ✅ |
| Fresh `git clone` + `npm ci` (macOS) | 26.3.1 | 16.14 | the same commands, all ✅ |
| GitHub Actions `ubuntu-latest` (CI workflow) | 22.x and 24.x | `postgres:16` service container | typecheck, tests, storefront tests, demo ✅ on `main` |

Not tested: PostgreSQL 13–15 and 17+. Crashpad needs 13+ for `DROP DATABASE … WITH (FORCE)`. Windows is not tested either.

On a fresh install, npm 11 warns that `fsevents` (an optional macOS dependency of Vitest) has install scripts that are not yet approved. It is not needed by Crashpad.

## Automated tests (145)

Integration tests use a real PostgreSQL server and real Git repositories in temp directories. Only GitHub's HTTP API is faked (`FakeGitHub` in `test/integration/publish.test.ts`). Git is real: a local bare repository stands in for the GitHub remote via `url.<path>.insteadOf`, so fetch, push, and worktrees all run for real.

| Area | Covered by |
|---|---|
| Working and breaking reads (renamed/dropped column, dropped table), changed column types, changed rows | `checks.test.ts` |
| Columns compared on zero-row results | `checks.test.ts` |
| Duplicate rows (multiset), ordered vs unordered | `checks.test.ts`, `compare.test.ts` |
| Numeric precision beyond IEEE doubles (`…567.89` vs `…567.88`), scale (`1.50` vs `1.5`) | `checks.test.ts`, `compare.test.ts` |
| Parameters (numeric strings, NULL, ints, booleans), parameter-count mismatch | `checks.test.ts` |
| `maxRows` exceeded → inconclusive even with matching prefixes; statement timeout; total deadline | `checks.test.ts` |
| Writes: NOT NULL column, CHECK constraint, deferred FK, renamed column, affected-row counts, RETURNING with ignored generated ids | `checks.test.ts` |
| Write isolation (a DELETE of all rows does not affect later checks) | `checks.test.ts` |
| Assertions: pass, become false, already false at baseline, four kinds of invalid fixture | `checks.test.ts` |
| Failed migration (statement location, later migrations not run, checks skipped) | `checks.test.ts` |
| Migration order, edited/removed/out-of-order migrations, edited schema, seed edits ignored | `checks.test.ts` |
| Baseline setup failure, invalid config, no credentials in reports | `checks.test.ts` |
| Baseline from Git, query-only changes, commit-vs-commit comparison, new checks, removed vs retired checks, `CONCURRENTLY` and `BEGIN/COMMIT` migrations, missing baseline config | `git-baseline.test.ts` |
| Source-path validation (absolute, `..`, backslash, `.git`, NUL, symlink escape, overlay paths, config/manifest paths) | `paths-config.test.ts` |
| Identifier-aware rewriting: literals, comments, params, aliases, qualified names, other tables' same-named columns, quoted identifiers, reserved words, multi-byte offsets, ORDER BY/GROUP BY, INSERT/UPDATE/DELETE/RETURNING, 14 refusal cases | `rewriter.test.ts` |
| Rename detection, including refusing chained, re-added, or dropped renames and drop+add | `rewriter.test.ts` |
| Fix verified against the original baseline; patch applies with `git apply`; plan and PR body | `fix.test.ts` |
| A response-changing "fix" is rejected (partial) because the baseline keeps the original queries and output | `fix.test.ts` |
| Partial / unsupported / not-needed outcomes; inline SQL never edited; failed migrations not "fixed" | `fix.test.ts` |
| Guardrails: refuse edits to manifest, config, seed, migrations, assertion fixtures, unrelated files, out-of-repo paths, stale "before" text | `fix.test.ts` |
| Publishing: intended-files-only commit, parent equals the target tip, worktree removed, user checkout (HEAD, branch, dirty files) untouched | `publish.test.ts` |
| Refusing: repo mismatch, partial fix (nothing pushed), stale plan, unverified plan, existing branch (no force) | `publish.test.ts` |
| Pushed branch + failed PR creation → recovery branch and `gh pr create` command | `publish.test.ts` |
| PR comment create-then-update; 403 on fork PRs does not fail the job | `publish.test.ts` |
| CLI exit codes 0/1/2 (including an unreachable PostgreSQL server), report files, `fix --apply` | `cli-and-scenarios.test.ts` |
| All six demo scenarios | `cli-and-scenarios.test.ts` and `npm run demo` |

## End-to-end demo (`npm run demo`)

All six scenarios produce the expected real results. In scenario 06, the storefront's own integration tests fail before the fix (5 of 7 fail with `column "name" does not exist`). Crashpad's patch is verified against the original baseline. In an isolated worktree with the patch applied, the storefront tests pass 7/7, `crashpad check` exits 0, and the original checkout's status and HEAD are unchanged.

## Live GitHub demonstration (recalculator/crashpad)

- **Demo PR [#1](https://github.com/recalculator/crashpad/pull/1)** (`demo/rename-customer-name`, labeled DEMO, do not merge). It adds the rename migration without updating SQL. The **"Crashpad database checks"** job failed with exit 1, wrote the report to the job summary, uploaded the `crashpad-report` artifact, and posted the PR comment listing the 5 `42703` regressions. CI also fails on this PR, because the sample app itself is broken on that branch, as intended.
- **Draft fix PR [#2](https://github.com/recalculator/crashpad/pull/2)**, opened by `crashpad fix-pr` run locally with the maintainer's `gh` login. It targets `demo/rename-customer-name` and contains exactly the four rewritten SQL files, with before/after verification evidence. The local checkout's HEAD, status, branches, and worktrees were unchanged afterwards.
  - Checking the fix branch against `main` with `crashpad check --base origin/main --head origin/crashpad/fix-…` gives **All 13 checks passed (exit 0)**.
  - PR #2's own Crashpad check reports **exit 2, "existing baseline failure"** for the five checks. This is by design: its base, the demo branch, is itself broken, so Crashpad will not vouch for it. CI on PR #2 also fails, because the scenario fixtures collide with the demo branch's `002_*` migration. Nothing was merged.
- **Manual fix-PR workflow** (`workflow_dispatch`, dry run, against the same branch): in Actions it fetched the branch, ran the original checks, and re-verified the patch. It then **refused** because the fix branch already existed, demonstrating the no-force guard. It has not been used to open a PR from Actions, because this repository has **"Allow GitHub Actions to create and approve pull requests"** disabled (`can_approve_pull_request_reviews: false`). With that setting off, the documented behavior is a pushed branch plus a recovery command. That path is covered by an automated test, but not live.

## Not validated

- The composite `action.yml` has not been run from another repository.
- A real fork PR (read-only token) has not been run. The 403 handling is covered by an automated test with a faked API.
- Behavior on very large schemas or datasets, and on other operating systems.
