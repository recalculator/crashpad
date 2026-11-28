# Validation record

This is what has been validated, how, and what has not. Dates are 2026-11-26 and 2026-11-27. **Live** means it ran against the real thing. **Mocked** or **faked** means a stand-in, named in each entry.

## Environments

| Where | Node | PostgreSQL | Result |
|---|---|---|---|
| Local, macOS (arm64) | 26.3.1 | 16.14 (Homebrew) | typecheck ✅, **196/196** tests ✅ |
| Fresh `git clone` of `main` (e863c08) + `npm ci`, macOS | 26.3.1 | 16.14 | typecheck ✅, 196/196 tests ✅ |
| GitHub Actions `ubuntu-latest` (CI workflow) | 22.x and 24.x | `postgres:16` service container | typecheck and all tests ✅ on `main` at e863c08 ([run 46068485534](https://github.com/recalculator/crashpad/actions/runs/46068485534)), including the packaged-CLI and GitHub App tests |

Not tested: PostgreSQL 13–15 and 17+, and Windows. Crashpad needs PostgreSQL 13+ for `DROP DATABASE … WITH (FORCE)`. npm 11 prints harmless `allow-scripts` warnings (for `fsevents`, and for Crashpad's own build script when it is installed from Git or an archive).

## Real-project trial (2026-11-27)

**Target:** Willo (`github.com/recalculator/Willo-Story-Generation`), the owner's own project.

- **Why this one:** a TypeScript Node app (Hono HTTP API with a Vite UI) that runs locally without API keys in demo mode, with `typecheck` and `test` scripts and a clean working tree. It stores data in SQLite, not PostgreSQL.
- **Second, discovery-only target:** `autofounder` (Next.js + Drizzle + PostgreSQL, local-only repository), chosen to see how discovery handles a Postgres project.
- **Not used:** TasteSync, because it is not the owner's repository, and the Swift/Jac projects, which are not Node.

**How it was run:**

- Crashpad came from an `npm pack` archive installed into an empty directory outside the source checkout. Every command used that install's `node_modules/.bin/crashpad`, with an isolated `CRASHPAD_HOME`.
- No Crashpad file was added to either repository. Both working trees were unchanged afterwards: the original Willo checkout stayed at `d29c840` on `main` only.
- Regressions and repairs happened only in disposable clones. Nothing was pushed, and no PR was opened in the target project.

### Round 1: package built from `ea2556c`

Commands: `crashpad setup --repo-dir ~/Projects/Willo --repo-dir ~/Projects/autofounder`, then `crashpad check --base HEAD` in a disposable clone.

| | Result |
|---|---|
| Discovered correctly | npm and its lockfile; the `build` and `start` scripts; the `typecheck` and `test` scripts (used for repair); `.env.example`; no database (correct: SQLite); no OpenAPI. For autofounder: the `postgres` client dependency, the `start` and `build` scripts, and `.env.example`. |
| Not discoverable (correctly reported) | Permission and workflow scenarios; an OpenAPI contract; a health endpoint. |
| **Defect: misleading status** | Willo's four blank, **optional** keys (`ANTHROPIC_API_KEY` and so on: "leave blank to run in demo mode") were reported as **missing required variables**. That made every run exit 2, and no setting could work around it. |
| **Defect: undiscovered port** | Willo reads `WILLO_PORT` (documented only as a commented default) and binds 8787. Crashpad set `PORT`, so startup failed on both versions: here with `EADDRINUSE`, because the owner's own Willo dev server was using 8787. Discovery did not flag the assumption. Manual step: `crashpad settings --set app.portEnv=WILLO_PORT`, after which startup passed. |
| **Defect: unexplained "not detected"** | autofounder's database area said "not detected" next to "found: PostgreSQL client". The project applies its schema with `drizzle-kit push` and has no migration history, and nothing said so. |
| Minor | "no health endpoint in the OpenAPI document" when there was no OpenAPI document; permission and workflow gaps listed twice; discovered test commands not shown in `setup`. |
| Regression caught | Incomplete rename (`renderRubric` → `formatRubric` in `src/core/rubric.ts` only): `config:startup` regression, exit 1, with the exact `SyntaxError` from the app's output as evidence. |
| **Live repair: UNRESOLVED (a Crashpad bug)** | Claude Code 2.1.332 (Pro subscription) produced the **correct** fix in attempt 1 (updated `src/core/prompts.ts`), and Willo's `typecheck` and `test` passed. Crashpad rejected it anyway, for three reasons: (a) the misreported env keys kept verification at exit 2; (b) the feedback prompt named no failing checks, so attempt 2 changed nothing; (c) Willo's tests were classed as "already failing before the change", because they were compared with the **failing** commit instead of the baseline. Cost: about $0.27 estimated across 2 attempts (11 + 4 turns). |

### Fixes (`9434733` and the following commit)

- `.env.example` declares variables and no longer marks them required. Startup decides, and a newly declared variable without a test value is listed in coverage.
- The port variable is discovered (`PORT`, or a single `*_PORT`, including commented defaults). Otherwise discovery says `PORT` is assumed.
- Postgres projects without migration history now get an exact explanation.
- Repair verification:
  - excuses only app-test failures present at the **baseline**;
  - accepts undecided checks only if they were already undecided before the change;
  - names newly undecided checks in the feedback.
- An unknown `--base` ref prints a one-line message with an `origin/<ref>` suggestion instead of a stack trace. This turned up during the round-2 cross-check.
- Regression coverage: the `optional-env-app` fixture (shaped like Willo), discovery unit tests (including autofounder's Drizzle shape), and repair tests for both verification rules.

### Round 2: fresh package, install, `CRASHPAD_HOME`, and clone, with no manual settings

| | Result |
|---|---|
| `setup` | Willo: port variable `WILLO_PORT` found; the 4 env keys reported as "declared; startup decides"; setup shows the `typecheck` and `test` commands. autofounder: "drizzle.config.ts is present but no generated Drizzle migrations were found … generate migrations (`drizzle-kit generate`) or set database.migrations". |
| Unchanged code (`check --base HEAD`) | **exit 0**: "All 2 check(s) passed (partial coverage)". The 2 checks are the environment contract and startup/readiness. |
| Same regression | **exit 1**: `config:startup` regression with the `SyntaxError` evidence |
| **Live repair (real Claude Code CLI)** | **VERIFIED after 1 attempt** (11 turns, est. $0.12, 17.5 s of agent time). The patch changed `src/core/prompts.ts` only, completing the rename (import and call). Verification required `typecheck` and `test` to pass, because both pass at the baseline, and both did. |
| Independent cross-check | Patch applied with `git apply` in another clone: `tsc` ok, `vitest` 40/40 passed, installed `crashpad check --base origin/main` exit 0 |

**What the trial does not show:**

- The **database area was not exercised** on a real project. Willo has no PostgreSQL, and autofounder has no migration history.
- **API, permission, and workflow checks did not run**, because neither project has an OpenAPI document or scenarios.

On a project like Willo, today's real coverage is the environment contract plus startup and readiness, and the report says so.

## Second real-project trial: autofounder (2026-11-27)

**Project.** `~/Projects/autofounder`, the owner's Next.js 16 + Drizzle ORM + PostgreSQL app. Its schema is `src/db/schema.ts` (9 tables, 7 enums), applied with `drizzle-kit push`. It has **no committed migrations, no OpenAPI document, and no test or typecheck script**.

**How it was run.**

- An `npm pack` archive was installed in an empty directory outside the Crashpad checkout, with a fresh `CRASHPAD_HOME`, against fresh disposable clones of the original checkout.
- No Crashpad file was added to the project.
- The original checkout was never modified: still clean at `c37b0ba`, no stash, nothing pushed.
- Regressions and repairs happened only in clones under the session scratchpad.

### Round 1: package built from `12504d1`

| Step | Result |
|---|---|
| `crashpad setup --repo-dir <clone>` | Correct facts. Database "needs input": `drizzle.config.ts` but no migrations. The repository was labelled with the original checkout's path, lowercased, not the clone that was analyzed. |
| `crashpad check --base HEAD` (unchanged) | **Exit 2. Nothing useful verified.** `next build` ran with an empty environment and failed on both versions (`DATABASE_URL is not set`, thrown at import time while collecting page data). Startup was therefore inconclusive, and the multi-line build log was pasted into the coverage table. |

Defects:

1. Builds ran without the test environment or a database.
2. The project's own build result was folded into the startup check instead of reported on its own.
3. There was no database coverage at all for `drizzle-kit push` projects.
4. The committed example `DATABASE_URL` (a placeholder Supabase URL) was eligible as a test value.
5. Coverage cells contained raw command output.
6. Setup showed the wrong directory.

### Fixes

- **Shared code trees.** Each version is exported and installed once.
- **Builds** get the sanitized test environment plus a clone of that version's throwaway database. If that database cannot be built, the build is not run and the build result is "not decided"; it is never blamed on the change.
- **Project commands** (`build`, `typecheck`, `test`) run on both versions and are reported in their own section and JSON field (`projectCommands`). A command the change broke exits 1, and the headline names it. Repair verification now uses these baseline-relative results instead of running the tests separately.
- **Database URL.** The database URL's example value is never used.
- **Drizzle schema compatibility.** Discovery reads the schema path from `drizzle.config.*` without executing it, and the new engine (`src/engines/drizzle.ts`) compares the two versions. It is labelled as schema compatibility, not migrations, everywhere.
- **Stand-in parent rows.** When a parent table's rows are rejected, its children are still tested against stand-in parent rows. This was added after the first regression run reported 8 child tables as "blocked".
- **Smaller fixes:**
  - coverage cells show one line per item;
  - the headline says which areas the passes come from;
  - `next start` is known to read `PORT`;
  - setup shows the analyzed directory and the raw origin.

Regression coverage:

- `test/integration/schema-compat.test.ts`, using the `drizzle-app` fixture and the real `drizzle-kit`, covering:
  - unchanged schema, new NOT NULL column, removed enum value plus dropped column, type change, compatible additions, and a schema module that does not export;
  - a broken build;
  - setup output.
- Unit tests in `test/unit/suite-rules.test.ts`:
  - the Drizzle config shapes: path, glob, array, directory, missing `drizzle-kit`, MySQL;
  - the example database URL never being used;
  - command classification;
  - `next start`.

### Round 2: fresh package, `CRASHPAD_HOME`, and clone, with no manual settings

**Manual steps:**

- `npm pack` and install;
- clone the project;
- `crashpad setup --repo-dir <clone>`;
- `crashpad check --base <ref>`.

No settings were needed, and nothing was written to the repository.

**Discovery assumptions** (all printed by setup):

- npm with `package-lock.json`, and `npm ci`;
- the schema module comes from `drizzle.config.ts`;
- `next start` reads `PORT`;
- readiness means the port accepts connections, since no health endpoint is known;
- the committed placeholder `ANTHROPIC_API_KEY=sk-ant-...` is used as a test value, while the example `DATABASE_URL` is not.

| Step | Result |
|---|---|
| Unchanged (`--base HEAD`) | **Exit 0**: "All 19 check(s) passed (database schema compatibility 17, config/startup 2) (partial coverage)". Project command `next build` passed on both versions. |
| Regression in a clone: `ownerEmail: text("owner_email").notNull()` added to `projects`, with `createProject` passing `"unknown"` so everything compiles | **Exit 1**, one regression: `database:schema:table:projects`, `not_null_violation (23502): null value in column "owner_email" of relation "projects" violates not-null constraint`. Evidence: the schema diff (`+ column owner_email text NOT NULL without a default`) and the two synthetic baseline rows. The other 8 tables and 7 enums passed. `next build` passed on both versions, reported as a project command. |
| `crashpad repair --agent claude --max-attempts 2 --max-turns 25 --max-budget-usd 1 --model sonnet` (live Claude Code 2.1.332, Pro sign-in) | **VERIFIED in 1 attempt** (11 turns, est. $0.16, 88 s in total). The patch makes `owner_email` nullable and drops the `"unknown"` placeholder (`src/db/schema.ts`, `src/db/queries/projects.ts`). Verification: all 19 checks pass, and `next build` passes. |

**Independent verification.** In a separate clone, the regression commit and then `repair.patch` were applied with `git am` / `git apply`. Then:

- **Real `drizzle-kit push --force`.** On a disposable database holding a project row created under the baseline schema, pushing the **regression** schema **truncated `projects` (0 rows left)**: data loss that push's `--force` approves silently. Pushing the **patched** schema kept the row and added `owner_email` as nullable.
- **Build, `tsc --noEmit`, and `eslint`** all pass on the baseline, the regression, and the patch. The project's own checks cannot see this regression; only the schema-compatibility check caught it.
- **Installed `crashpad check --base c37b0ba`** on the patched clone, with fresh storage: exit 0.

**Database coverage actually achieved.** Schema compatibility for all 9 tables and 7 enums, plus a real database for the startup check.

**Not covered:**

- no migration sequence, and the statements push would run were not generated by Crashpad;
- synthetic rows only;
- the application's queries were not exercised.

### Not exercised on autofounder

- **API, permissions, workflows.** There is no OpenAPI document and no `crashpad.http.json`, so these were not configured.
- **Startup** only proves `next start` opens its port. No page or route was requested.
- **Typecheck and test commands.** There are none, so only `next build` ran. `next build` runs TypeScript, but Crashpad does not count that as a separate typecheck.

## Release 0.3.0 preparation (2026-11-27)

**Stored scenarios** (`test/integration/stored-scenarios.test.ts`, real notes-api app and PostgreSQL). The repository under test has no `crashpad.http.json` on either version.

- **No stored scenarios:** permissions are "not configured".
- **After `crashpad scenarios --import`:** the permission regression is caught. Coverage says the scenarios came from Crashpad's storage, and the file is mode 600.
- **Precedence:** a repository's own `crashpad.http.json` wins, and the report says the stored ones were ignored.
- **Invalid files** are rejected on import.
- **Repairs cannot change them.** A mock agent that edits the stored file during a repair is recorded as a violation, the file is restored, and verification uses the copy loaded before the repair.

**Service deployment** (`test/integration/service-deploy.test.ts`; **GitHub is faked**):

- **`crashpad service check`:**
  - names each missing setting;
  - rejects a non-numeric App ID, an invalid slug, a non-RSA key, and a relative state path;
  - warns about a short webhook secret, a world-readable key, and state in `/tmp`.
- **`--online`:** confirms matching credentials, and catches a wrong slug and a key from another App.
- **Startup:** `crashpad service` exits 2 with an invalid configuration.
- **Manifest:** it requests exactly the permissions and events the service uses, and requires HTTPS.
- **`crashpad service register`:**
  - the local page posts to `/settings/apps/new`, and the callback rejects a wrong `state`;
  - the code exchange writes the key and `service.env` with mode 600;
  - it refuses to overwrite, and rejects used or expired codes.
- **`/healthz`** reports the version and storage. State persists across a restart.
- **`deploy/backup.sh`:** dated copies, pruning, refusal of corrupt state, and no leftover temporary files.
- **`deploy/healthcheck.sh`** passes against a running service.

**Installed-package rehearsal** (outside the checkout, manual). `npm pack` built `crashpad-0.3.0.tgz`; it contains `deploy/` with executable scripts. It was installed into an empty directory, then:

- `crashpad --version` printed 0.3.0;
- `service check` with nothing set listed all six settings (exit 2), and with throwaway credentials it passed, warning that the scratch directory may be cleared on reboot;
- the installed `crashpad service` ran, and the shipped `healthcheck.sh` passed all four checks;
- a signed `installation` webhook returned 200, the state file was mode 600, and the installation was still in the state after a restart;
- the shipped `backup.sh` kept one dated copy, mode 600.

**Not run:**

- `install.sh`, the systemd units, and the Caddyfile on a Linux host (none was provisioned; `systemd-analyze` and `caddy` are not available here);
- anything against github.com.

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

- **Real-project use is limited to two trials** (Willo and autofounder; see above). On real projects, the configuration/startup area and Drizzle schema compatibility ran. Migration-based database checks, API contracts, permissions, and workflows have run only on fixtures.
- **The GitHub App flow has not run against github.com** (see above). This includes App registration from the manifest, `crashpad service check --online`, real webhooks, device-flow pairing, check runs, and fix PRs. The [acceptance test](acceptance.md) is the plan for verifying them.
- **The deployment package on a real host:** `install.sh`, the systemd units, the backup timer, and the Caddyfile.
- A real fork PR with a read-only token: covered only with fakes.
- The composite `action.yml` from another repository, and its PR-comment step on a live pull request.
- PostgreSQL other than 16, Windows, very large schemas or repositories, and package managers other than npm in runtime checks. The pnpm and Yarn commands are discovered, but only npm installs were executed in tests.
