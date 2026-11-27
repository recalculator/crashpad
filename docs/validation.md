# Validation record

This is what has been validated, how, and what has not. Dates are 2026-11-26 and 2026-11-27. **Live** means it ran against the real thing. **Mocked** or **faked** means a stand-in, named in each entry.

## Environments

| Where | Node | PostgreSQL | Result |
|---|---|---|---|
| Local, macOS (arm64) | 26.3.1 | 16.14 (Homebrew) | typecheck ✅, **TESTCOUNT** tests ✅ |
| Fresh `git clone` of `main` + `npm ci`, macOS | 26.3.1 | 16.14 | CLEANCLONE |
| GitHub Actions `ubuntu-latest` (CI workflow) | 22.x and 24.x | `postgres:16` service container | CIRESULT |

Not tested: PostgreSQL 13–15 and 17+, and Windows. Crashpad needs PostgreSQL 13+ for `DROP DATABASE … WITH (FORCE)`. npm 11 prints harmless `allow-scripts` warnings (for `fsevents`, and for Crashpad's own build script when it is installed from Git or an archive).

## Packaged CLI (automated: `test/integration/package.test.ts`)

The test does the following:

1. `npm pack` builds `crashpad-0.2.0.tgz`. The archive contains `bin/`, `dist/`, the README, the license, and the third-party notice. It contains no `src/`, `test/`, or `.env` files.
2. The archive is installed with `npm install` into an **empty directory outside the source checkout**, and the installed `crashpad --version` reports 0.2.0.
3. The installed binary runs `check` on a copy of the `notes-api` fixture that has **no Crashpad config file**. The configuration is discovered, and the check exits **1** with the permission regression.
4. `discover` reports all five areas ready. For a copy without a `start` script or runtime scenarios, `discover` names exactly those missing items. After `crashpad settings --set app.start=…` (stored in Crashpad's storage), the configuration area becomes ready and the repository stays unmodified.

Nothing was published to a registry.

## Five check areas (automated: `test/integration/suite-areas.test.ts`)

These tests use the `notes-api` fixture, a Node.js + PostgreSQL notes API with signup/login, notes with ownership, an admin endpoint, an audit log, OpenAPI, `.env.example`, SQL migrations, and runtime scenarios.

- **Real components:** the app processes, PostgreSQL, Git commits for the baseline and candidate, `npm ci` installs, and discovery (the fixture has no `crashpad.config.json`).
- **Every failure below was produced by actually running the changed code.**

| Scenario | Expected and observed |
|---|---|
| Compatible change (new migration, optional field) | exit 0; all five areas complete |
| `RENAME COLUMN` the app still uses | database read regression `42703`, plus the runtime smoke and permission checks for `/products` regress (500) |
| `GET /me` drops `role` (code and spec) | spec `removed-response-field` **and** runtime contract check regress |
| New required env var with no test value | `config:env:PAYMENTS_API_KEY` regression; `config:startup` regression (process exits); runtime checks skipped, not passed |
| Ownership check removed | `permissions:note-visible-to-owner-and-admin` regression (bob gets 200); other checks pass |
| Audit record no longer written on update | `workflows:signup-login-create-update` regression at the SQL side-effect step |
| `POST /notes` requires a new field | spec `new-required-request-field`; workflow and permission scenarios regress (400) |
| Endpoint removed | spec `removed-operation`; permission scenario regresses (404) |

Also covered:

- A repository **without a database** runs fully with an unreachable PostgreSQL URL; the database area is "not applicable".
- An **unsupported project** (no `package.json`) exits 2 with "Nothing was verified" and the exact discovery gaps.
- Unit tests (`test/unit/suite-rules.test.ts`) cover:
  - the OpenAPI rules and runtime validation;
  - environment parsing, validation, and sanitization (the caller's other environment variables are not passed in);
  - templating and redaction;
  - the shared classification and exit-code rules;
  - the discovery rules for Prisma, pnpm, dbmate, JS migrations, Bun, and a non-PostgreSQL Prisma provider.

## Repair

### Mocked agent (automated: `test/integration/repair.test.ts`)

The agent is a **mock Claude Code CLI** (`test/fixtures/fake-claude/claude`). It imitates the CLI's flags, JSON result, and error output, and applies scripted edits. Crashpad's checks, verification, Git, and PostgreSQL are real. These tests show:

- an **incorrect patch is rejected** by independent verification; the failure is fed back on `--resume`; the corrected patch is accepted only after verification;
- a "success" exit **with no fix** is rejected, as are attempts that change nothing;
- edits to `crashpad.http.json` and to a test file are reverted and never counted;
- expired sign-in, exhausted usage, turn limits, deadlines, and cancellation stop the run with clear messages;
- no permission-bypass flags or `--bare` are used, and `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` are removed from Claude's environment in subscription mode;
- the account details printed by `claude auth status` are not kept;
- the deterministic rename fixer repairs a rename **without invoking any agent**;
- a verified repair is published with `publishFiles` as a draft PR whose commit's parent is the exact failing commit and which touches only the repaired file; the branch is never overwritten, and Crashpad refuses to repair its own fix branches and commits.

### Live Claude Code repair (2026-11-27, this machine)

- **Setup:** Claude Code 2.1.332, signed in with a Claude subscription (`authMethod: claude.ai`, Pro). No API key was involved.
- **Command:** `crashpad repair --base main --head change --agent claude --max-attempts 2 --max-turns 25 --max-budget-usd 1 --deadline-min 15 --model sonnet`
- **Target:** the `notes-api` permission-regression scenario (ownership check removed from `GET /notes/{id}`).

| Run | Result |
|---|---|
| 1 | **Verified after 1 attempt** (10 turns, est. $0.14 as reported by Claude Code). The patch restored the exact ownership condition in `server.js`. Crashpad's verification: all 22 checks passed. The fixture's own `npm test` was reported as **already failing before the change** (a fixture bug: `node --test test/` on Node 26), so it was not counted. The fixture was fixed afterwards. |
| 2 (after the fixture fix) | **Verified after 1 attempt** (7 turns, est. $0.12, 15 s of agent time). Same one-line patch. All 22 checks passed **and** `npm run --silent test` passed. |

Claude's own summary in run 1 said it "couldn't verify it by running it". Crashpad's independent verification is what established the result. Neither live run produced an incorrect patch, so **live rejection of a wrong patch was not observed**; that path is covered by the mocked test above.

## GitHub App service and companion (automated: `test/integration/github-app.test.ts`)

- **Real:** the Crashpad service (HTTP), the companion, Git, PostgreSQL, the app processes, and discovery.
- **Faked:** GitHub's REST API and device flow (`test/helpers/fake-github-server.ts`) and the Claude CLI (the mock above).
  - The fake verifies the App JWT's RS256 signature and claims, and scopes installation tokens to the requested repositories and permissions.
  - It implements the Git Data API with git plumbing on a **real bare repository**, so the fix commits are real Git objects.

The tests cover:

- **webhook signature rejection**, replayed deliveries, and per-commit deduplication;
- the **installation's repository selection**: events for other repositories are ignored, and a repository removed from the selection stops being served;
- **device-flow pairing**:
  - a user without access to the installation cannot pair;
  - the GitHub user token is never stored;
  - the companion token file is mode 600, and only its hash is kept on the service;
- **offline state**: the check run says the companion is offline and that nothing has been checked; after a heartbeat it says "Queued on your Crashpad companion";
- **exact-SHA checks** on the companion with a read-only, single-repository token; the check run is completed with the report and a **Repair with Claude** action;
- **requested repair** (refused for a reader; one per commit):
  - verified locally;
  - published as a **draft PR into the PR branch**, whose commit's parent is the exact head SHA and which changes only `server.js` (with a `Crashpad-Repair` trailer);
  - a successful **Crashpad repair** check run;
- **stale jobs**: when the PR moves, the old check run is cancelled ("Superseded by …"), the companion is told to stop, and its result is refused (409); the new commit is leased instead;
- **fork PRs**: action required, with **Run Crashpad**; approval refused for a reader and accepted from a writer; never repairable;
- **automatic repair**: off by default; when the owner opts in for a repository, a failing check queues a repair; a companion with repairs disabled reports "Repairs are turned off" and changes nothing;
- **loop prevention**: Crashpad's own fix PR is checked but gets no repair action and no automatic repair, even with automatic repair on;
- **onboarding** (`crashpad setup`): lists the installation's repositories, fetches each default branch with a read-only token, and reports all five areas ready for `acme/notes`; results are stored in Crashpad's storage and the repository is unchanged.

**Not run live:** no GitHub App has been registered, and no service has been deployed at a public URL. App authentication, webhook delivery, check-run rendering, device-flow pairing, and fix-branch creation have not been exercised against github.com. See [github-app.md](github-app.md) for the remaining steps.

## Database engine and earlier coverage

Integration tests use a real PostgreSQL server and real Git repositories in temp directories. Only GitHub's HTTP API is faked (`FakeGitHub`, now in `test/helpers/fake-github.ts`). Git is real: a local bare repository stands in for the GitHub remote via `url.<path>.insteadOf`, so fetch, push, and worktrees all run for real.

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
| Six scenario fixtures (healthy change, rename, new required column, data transformation, query-only change, rename fix) | `cli-and-scenarios.test.ts` |
| The fixture app works on the migrated fixture. In the rename scenario, its query fails with `42703` before the fix. After `git apply` of the verified patch, every app operation works and `check` exits 0. The checkout is unchanged by `fix` | `storefront.test.ts` |


## Live GitHub runs (recalculator/crashpad, 2026-11-27)

These PRs were opened only to exercise the GitHub integration end to end. Both were **closed without merging** during the cleanup, and their branches were deleted. The PR pages, comments, and Actions run logs below stay available on GitHub.

- **PR [#1](https://github.com/recalculator/crashpad/pull/1)**: branch `demo/rename-customer-name` at `a30a8e5f`, into `main`. It added a `RENAME COLUMN` migration without updating the SQL.
  - The "Crashpad database checks" job ([run 45919979975](https://github.com/recalculator/crashpad/actions/runs/45919979975/job/140248159837)) failed with exit 1. It wrote the report to the job summary and uploaded the `crashpad-report` artifact.
  - It posted the PR comment ([comment](https://github.com/recalculator/crashpad/pull/1#issuecomment-7206930056)) listing the five `42703 undefined_column` regressions.
- **Draft PR [#2](https://github.com/recalculator/crashpad/pull/2)**: branch `crashpad/fix-demo-rename-customer-name-a30a8e5f` at `15eed2da`, into PR #1's branch.
  - It was opened by `crashpad fix-pr`, run **locally** with the maintainer's `gh` login, not from Actions. It contained exactly the four rewritten SQL files, plus before/after verification evidence in the body.
  - The local checkout's HEAD, status, branches, and worktrees were unchanged afterwards.
  - `crashpad check --base origin/main --head origin/crashpad/fix-…` gave **All 13 checks passed (exit 0)**.
  - Its own PR check ([run 45920097985](https://github.com/recalculator/crashpad/actions/runs/45920097985/job/140248513538)) reported **exit 2, "existing baseline failure"**. This is by design: its base, PR #1's branch, was itself broken, so Crashpad would not vouch for it.
- **Fix-PR workflow, dry run** ([run 45920220798](https://github.com/recalculator/crashpad/actions/runs/45920220798)), against PR #1's branch. In Actions it fetched the branch, ran the original checks, and re-verified the patch. It then **refused** because the fix branch already existed, which is the no-force guard.
  - At that time, the repository setting "Allow GitHub Actions to create and approve pull requests" was off, so Actions-based PR creation had not been run live.
- Before cleanup, `npm run demo` ran all six scenarios with the expected results, locally and in CI. In the rename-fix scenario, the fixture app's tests went from 5 of 7 failing to 7 of 7 passing once the patch was applied. That script has since been removed; the same assertions are now automated tests (see above).

### Actions-based draft PR creation (verified 2026-11-27)

1. **Setting.** "Allow GitHub Actions to create and approve pull requests" was enabled for recalculator/crashpad with `PUT /repos/recalculator/crashpad/actions/permissions/workflow`.
   - Only that setting was changed: `can_approve_pull_request_reviews: false → true`.
   - `default_workflow_permissions` stayed `read`.
   - The setting remains enabled, so the fix-PR workflow works.
2. **Target.** A temporary branch, `verify/actions-fix-pr` (`0f3356be`), was created from `main`. It added one migration renaming `customers.name → full_name` in the fixture. No PR was opened for it.
3. **Run.** The "Crashpad fix PR" workflow was dispatched from `main` with `dry_run=false` ([run 46057416060](https://github.com/recalculator/crashpad/actions/runs/46057416060), success). Using the workflow's `GITHUB_TOKEN`, it:
   - re-verified the patch;
   - pushed `crashpad/fix-verify-actions-fix-pr-0f3356be`;
   - opened **draft PR [#3](https://github.com/recalculator/crashpad/pull/3)**.
4. **Checked on GitHub:**
   - the PR author is `app/github-actions` and the PR is a draft;
   - its base is `verify/actions-fix-pr`;
   - it has one commit by `github-actions[bot]`, whose parent is exactly `0f3356be`;
   - it changes exactly the four rewritten SQL files.

   `crashpad check --base origin/main --head origin/crashpad/fix-verify-actions-fix-pr-0f3356be` gave **All 13 checks passed (exit 0)**.
5. **Cleanup.** PR #3 was retitled `[VERIFICATION] …`, closed without merging, and both branches were deleted. Nothing was approved or merged.
6. **Workflow runs on the bot-opened PR.** GitHub created `pull_request` runs for it (actor `github-actions[bot]`: CI 46057480875 and Crashpad 46057480844). They executed **zero jobs** and were marked failed after the PR was closed and its branch deleted. So whether CI runs usefully on Actions-opened fix PRs was not established.

### Composite action

The PR-check workflow now runs `action.yml` via `uses: ./` against `test/fixtures/storefront` on PRs and on pushes to `main`. [Run 46057365430](https://github.com/recalculator/crashpad/actions/runs/46057365430), a push to `main` at `85242fe`, installed Crashpad through the action, ran `check` against the parent commit, wrote the job summary, and passed.

The action's PR-comment step has not yet run on a pull request. PR #1's comment came from the earlier inline workflow.


## Not validated

- **Crashpad has not been used on a real application** other than the test fixtures.
- **The GitHub App flow has not run against github.com** (see above).
- A real fork PR with a read-only token: covered only with fakes.
- The composite `action.yml` from another repository, and its PR-comment step on a live pull request.
- PostgreSQL other than 16, Windows, very large schemas or repositories, and package managers other than npm in runtime checks. The pnpm and Yarn commands are discovered, but only npm installs were executed in tests.
