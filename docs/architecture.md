# Crashpad architecture

Crashpad is a TypeScript (strict, ESM) CLI and library. Its parts:

- **the check suite**, which compares the baseline and the candidate across five areas;
- **discovery**, which builds a configuration from what the repository already contains;
- **repair**, which proposes changes and then verifies them independently;
- **the GitHub integration**: a GitHub App service plus a local companion, or GitHub Actions as an alternative.

```
            crashpad check / repair / companion job
                          │
          ┌───────────────▼────────────────┐
          │ suite/runner.ts                 │   configuration layers (per side):
          │  resolve config per side ───────┼── discovery/ → Crashpad settings → crashpad.config.json
          │  1 database   → runner.ts       │
          │  2 api (spec) → engines/openapi │   static: baseline spec vs candidate spec
          │  3–5 runtime  → engines/runtime │   config/startup, API runtime, permissions, workflows
          │  aggregate → SuiteReport        │
          └───────────────┬────────────────┘
                          ▼
         suite/markdown.ts · JSON (crashpad.suite/v1) · check-run output · PR comment
```

## The common model

Every area produces `Finding`s (`src/suite/types.ts`), each with:

- an id (`<area>:<check>`);
- a classification;
- a reason and a message;
- the subject (file and line, or an operation such as `GET /notes/{id}`);
- the baseline and candidate outcomes;
- evidence: SQL errors, requests and responses, application logs, diffs.

Classifications are shared by all areas: `pass`, `regression`, `changed-result`, `failed-assertion`, `baseline-failure`, `invalid-fixture`, `inconclusive`, `skipped`, `removed`, `retired`.

**Exit codes.** Problems → 2. Any actionable finding → 1. Anything undecided → 2. **No passing finding at all → 2**, because nothing was verified. Otherwise 0.

**Coverage.** Each area gets a coverage entry: `complete`, `partial`, `not-configured`, `not-applicable`, or `unavailable`. The entry lists what ran and the exact missing requirements, so partial coverage is never mistaken for complete verification.

## Configuration layers

`suite/config.ts` merges three layers, the later ones winning:

1. **discovered** (`discovery/node.ts`, explicit rules for Node/TypeScript + PostgreSQL);
2. **Crashpad settings** (`~/.crashpad/repos/<key>/settings.json`);
3. the repository's optional **`crashpad.config.json`**.

The merged result is validated with zod. A discovery gap tagged with a setting key (for example `app.start`) disappears once a later layer sets that key.

- **Each side has its own configuration.** The baseline's configuration comes from the baseline commit, and the candidate's from the candidate.
- **Expectations.** For repair verification, the candidate's *expectations* (configuration and check manifests) come from the original, unpatched commit (`SuiteInput.expectations`), while its *code* comes from the patched workspace.
- **Discovery cache.** Results are cached per Git tree id, rules version, and tool version (`discovery/store.ts`).

## Engines

| Module | Responsibility |
|---|---|
| `runner.ts` (+ `db/`, `migrations.ts`, `fixtures.ts`, `compare.ts`) | Database area. Builds the baseline database (schema → seed → baseline migrations; or migrations → seed when there is no bootstrap schema) and clones the candidate with `CREATE DATABASE … TEMPLATE`. Applies only the new migrations (SQL directories or Prisma layout). Runs read, write, and assertion checks in always-rolled-back transactions with deadlines. Reports migration history issues. |
| `engines/openapi.ts` | Loads OpenAPI 3.0/3.1 with `@apidevtools/swagger-parser` (validation and `$ref` dereferencing, external references off). Crashpad's own breaking-change rules run per baseline operation. Responses are validated against the baseline schema with Ajv, converting OpenAPI 3.0 `nullable` and boolean bounds. |
| `engines/env.ts` | Environment contracts: `.env.example` declarations (never treated as required), or a JSON Schema whose `required` list is enforced, with string coercion. Builds the sanitized test environment: tool variables, committed examples, explicit test values, then generated values. Redacts secrets in logs. |
| `engines/app.ts` | Exports an exact commit (`git archive`) or a working tree (tracked plus untracked-not-ignored files, symlinks skipped). Runs argv commands without a shell, under deadlines, as a process group, and supports cancellation. `AppProcess` waits for readiness (a 2xx health path, or an open port) or for the process to exit. |
| `engines/http.ts` | The `crashpad.http.json` schema and the scenario runner: identities with lazy login and their own cookie jar and headers, `{{captures}}`, status/header/JSON/contract expectations, SQL side-effect steps. Permission matrices expand into explicit per-identity steps. |
| `engines/runtime.ts` | Runtime orchestration. Per side: export the code, install, build, build a template database. Per check: clone the database, start a fresh app process, run, stop, drop. Applies the shared `classifyRuntime` rules. Existing HTTP checks run with their **baseline** definition. Smoke checks are derived from the baseline contract. |

## Repair

`repair/loop.ts`:

1. Reproduce with the full suite at the exact commit.
2. Run the app's test commands once, to learn which ones already fail.
3. Try the deterministic rename fixer (`fix/`). If its patch makes the whole suite pass, the repair is done.
4. Otherwise run up to N agent attempts in a `Workspace` (`repair/workspace.ts`): a `--shared` clone detached at the commit, with the remote removed. After each attempt:
   - guardrails check and revert protected paths;
   - the full suite re-runs, with expectations from the original commit, and the app tests run in a fresh export;
   - any failure becomes feedback for the next attempt, which resumes the same agent session.
5. Return a verified, unresolved, or stopped outcome, with the attempt log and the patch.

The agent interface (`repair/agent.ts`) has one real implementation, `ClaudeCodeAgent` (`repair/claude.ts`):

- `status()` parses `claude auth status --json` and keeps only non-identifying fields.
- `run()` invokes `claude -p` with `--permission-mode dontAsk`, an allowlist, no MCP servers, and turn, budget, and time limits, and maps the CLI's JSON result and error text to typed outcomes.

Tests use a mock CLI with the same process contract (`test/fixtures/fake-claude/claude`).

## GitHub integration

**Service** (`service/`, `crashpad service`): one Node HTTP process with JSON-file state (`service/store.ts`).

- **App authentication** (`github-app.ts`): an RS256 App JWT, exchanged for installation tokens scoped per call, for example a single repository with `contents: read` for a companion clone.
- **Webhooks** (`server.ts`):
  - HMAC-SHA256 signatures are verified, and replayed deliveries are ignored;
  - `installation` and `installation_repositories` events maintain each installation's repository selection, and nothing outside it is acted on;
  - `pull_request` events create jobs, deduplicated per repo, PR, and head SHA, after superseding active jobs for older head commits;
  - `check_run` events handle re-runs and the **Run Crashpad** (approval) and **Repair with Claude** actions; the sender's write permission is verified through the collaborators API.
- **Policy** (`policy.ts`):
  - trusted-source rules;
  - loop prevention: no repairs of `crashpad/fix-*` branches or App-authored PRs;
  - repair bounds per commit and per PR;
  - opt-in automatic repair per repository.
- **Companion API.** Bearer companion tokens are stored as hashes.
  - **Pairing:** a GitHub device-flow user token, used once to call `GET /user` and `GET /user/installations`.
  - **Work:** heartbeat (presence), long-poll lease (with expiry and re-lease up to 3 times), progress (which also tells the companion to cancel superseded work), and complete (check-run conclusion, summary, and annotations in batches of 50).
  - **Publishing** (`fix`): re-check that the PR head is still the job's SHA, then create blobs, a tree based on the head commit's tree, a commit whose parent is that exact head, and a new ref (refused if it already exists, so nothing is overwritten), and finally a draft PR into the head branch.
- **Presence:** queued check runs say whether a companion is online, and they are refreshed when one reconnects and every 30 s.

**Companion** (`companion/`, `crashpad connect` / `crashpad companion`):

- `client.ts`: the service API and the device flow.
- `worker.ts` runs each job:
  - keeps a per-repository clone in Crashpad's storage and fetches the exact SHAs with the job's token, passed as a Git config environment variable;
  - uses the merge base of the base and head commits as the baseline;
  - runs the suite, or the repair loop with the local Claude Code;
  - reports back, and stops if the service says the job was superseded.

**Onboarding** (`commands/setup.ts`):

- checks prerequisites;
- for each repository in the installation, obtains a read-only token, fetches the default branch, runs discovery, and records `onboarding.json` in Crashpad's storage;
- prints readiness per area, with exact missing requirements;
- never writes to repositories.

## Design decisions

- **Baseline-relative everywhere.** Every area compares versions. A failure already present at the baseline is not blamed on the change.
- **Expectations are immutable during verification.** The baseline comes from Git. The candidate's expectations come from the original commit. Existing HTTP checks use their baseline definition, and guardrails keep agents away from expectation files. A patch can only pass by changing behavior.
- **Fresh state per runtime check.** Every scenario gets a database clone and a new process, so one scenario's writes cannot affect another.
- **Static vs runtime is explicit.** Spec findings are labeled `spec`. Runtime findings come from requests to the running app.
- **Local execution, central coordination.** Repository code and Claude run on the owner's machine. The service holds only the App's credentials and never executes code.
