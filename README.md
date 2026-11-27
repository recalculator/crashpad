# Crashpad

Crashpad checks whether a backend change breaks your application's **PostgreSQL behavior** before it merges. It runs SQL you already have (read queries, write statements, and integrity assertions) against two throwaway databases, one at the baseline commit and one with the change applied, and reports the differences. For explicit column renames, it can propose a fix, verify it, and open a draft fix PR.

The fixer is a deterministic, rules-based program built on the real PostgreSQL parser. It is not an AI model and needs no API key.

```
$ crashpad check --base main
❌ Crashpad: 5 of 13 check(s) broke (exit 1)
| `customer-profile` | read  | ❌ regression | ok, 1 row(s)          | error 42703 undefined_column | `sql/customer_profile.sql:3` |
| `signup`           | write | ❌ regression | ok, 1 row(s) affected | error 42703 undefined_column | `sql/create_customer.sql:2`  |
...
$ crashpad fix --base main
Crashpad fix: VERIFIED (exit 0)
  original:     5 of 13 check(s) broke
  verification: All 13 check(s) passed
$ git apply crashpad-fix/fix.patch       # e.g.  c.name  →  c.full_name AS name
```

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running checks](#running-checks)
- [GitHub integration](#github-integration)
- [Proposing fixes](#proposing-fixes)
- [Limitations](#limitations)
- [What has been tested, and how](#what-has-been-tested-and-how)
- [Development](#development)
- [Architecture](docs/architecture.md) · [Validation record](docs/validation.md)

## Requirements

- **Node.js 22.18 or later.** CI tests Node 22 and 24.
- **Git.** The baseline is read from Git history.
- **A PostgreSQL 13+ server where Crashpad may `CREATE DATABASE`**, such as a local install, `docker compose up -d` with this repository's `docker-compose.yml`, or a CI service container. Development and CI use **PostgreSQL 16**; other versions are untested.
- Crashpad creates databases named `crashpad_base_*` and `crashpad_cand_*` and drops them after each run. It only connects to the server you give it. **Never point it at production.**

## Installation

Crashpad is not published to the npm registry. Install it from GitHub as a dev dependency of your project, pinned to a commit:

```sh
npm install --save-dev github:recalculator/crashpad#<commit-sha>
npx crashpad --help
```

npm builds `dist/` with the package's `prepare` script during the install. npm 11 prints an `allow-scripts` warning about that script, but the build still runs. This was checked in a fresh, empty project (see [validation](docs/validation.md#installation)).

To run from source instead:

```sh
git clone https://github.com/recalculator/crashpad.git && cd crashpad
npm ci                  # installs and builds dist/
node bin/crashpad.js --help
```

Set the server URL with `--database-url` or `CRASHPAD_DATABASE_URL`. The default is `postgres://localhost:5432/postgres`.

## Configuration

A Crashpad project is a directory containing `crashpad.config.json`. This repository's test fixture, [`test/fixtures/storefront`](test/fixtures/storefront), is a complete example.

```
your-app/
  crashpad.config.json
  crashpad.checks.json
  db/schema.sql           # bootstrap schema: the state before the first migration
  db/seed.sql             # synthetic sample data
  db/migrations/*.sql     # plain-SQL migrations, applied in filename order
  sql/*.sql               # the queries your application runs
```

### `crashpad.config.json`

```json
{
  "version": 1,
  "schema": "db/schema.sql",
  "seed": "db/seed.sql",
  "migrations": "db/migrations",
  "checks": "crashpad.checks.json",
  "limits": { "maxRows": 1000, "statementTimeoutMs": 5000, "migrationTimeoutMs": 60000, "totalTimeoutMs": 300000 },
  "report": { "rowSamples": 0 }
}
```

| Key | Meaning |
|---|---|
| `schema` | Bootstrap schema: the database state **before the first file in `migrations`**. Change the schema with new migrations, not by editing this file. Editing it is reported as a history problem. |
| `seed` | Optional **synthetic** sample data. It is loaded after `schema` and **before** migrations, so migrations transform it the way they would transform real data. |
| `migrations` | A directory of `*.sql` files, applied in byte-wise filename order. |
| `checks` | The check manifest. |
| `limits.maxRows` | Rows compared per side. A larger result makes the check inconclusive, never a pass. |
| `limits.statementTimeoutMs` | Deadline per check statement. Exceeding it makes the check inconclusive. |
| `limits.migrationTimeoutMs` | Deadline per statement in schema, seed, and migration scripts. |
| `limits.totalTimeoutMs` | Deadline for the whole run. Checks not started before it are reported as not run. |
| `report.rowSamples` | Example differing rows per changed-result finding. The default is `0`. Only enable it with synthetic data. |

All paths are relative to the project directory. Absolute paths, `..`, `.git`, and symlinks that point outside the repository are rejected.

### Check manifest (`crashpad.checks.json`)

```json
{
  "version": 1,
  "checks": [
    { "id": "customer-profile", "category": "read",  "source": "sql/customer_profile.sql", "params": [1] },
    { "id": "order-summary",    "category": "read",  "source": "sql/order_summary.sql", "params": [1], "ordered": true },
    { "id": "signup",           "category": "write", "source": "sql/create_customer.sql",
      "params": ["new.customer@example.test", "Nova Customer"], "expectRows": 1, "ignoreColumns": ["id", "created_at"] },
    { "id": "no-negative-order-totals", "category": "assertion",
      "sql": "SELECT NOT EXISTS (SELECT 1 FROM orders WHERE total < 0)" }
  ],
  "retired": [
    { "id": "legacy-report", "reason": "report removed in #123" }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | A stable id (`[a-z0-9._-]`). Baseline and candidate checks are matched by id. |
| `category` | `read`, `write`, or `assertion`. |
| `source` **or** `sql` | A `.sql` file (preferred: the fixer only edits real files) or inline SQL. Each must be **one statement**. |
| `params` | JSON values bound to `$1…$n`. The count is validated. Pass numerics as strings (`"42.50"`) for exact precision. |
| `ordered` | Read checks only: compare rows in order. Otherwise rows are compared as a multiset. |
| `expectRows` | Write checks only: the expected affected-row count. Otherwise the baseline count is expected. |
| `compareReturning` | Write checks only: compare `RETURNING` output. The default is `true`. |
| `ignoreColumns` | Output columns to exclude, such as generated ids and `now()` timestamps. |
| `retired` | Deliberately removed checks, each with a reason. A check that disappears without being listed here is flagged. |

**Point checks at the files your application actually loads.** The fixture app in [`test/fixtures/storefront/app.ts`](test/fixtures/storefront/app.ts) reads the same `sql/*.sql` files its checks use. Then a fix to a checked file is also a fix to the app, and the tests confirm that.

### What each check type detects

Every check runs in its own transaction, which is **always rolled back**. Reads and assertions are `READ ONLY`.

- **Read** (`SELECT`):
  - queries that now fail, with the SQLSTATE and the `file:line:column` in your `.sql` file;
  - changed output columns or types (including type modifiers), even when the result has zero rows;
  - changed rows, compared as an exact multiset or in order.

  Values are compared as PostgreSQL's own text output, so `1.50` ≠ `1.5` and precision is never lost through JavaScript numbers.
- **Write** (`INSERT`/`UPDATE`/`DELETE`/`MERGE`):
  - new `NOT NULL` columns (`23502`);
  - constraint changes (`23514`, `23503`, `23505`, …). Deferred constraints are forced to be checked with `SET CONSTRAINTS ALL IMMEDIATE`.
  - renamed or dropped columns (`42703`);
  - changed affected-row counts or `RETURNING` output.
- **Assertion**: a `SELECT` that returns exactly one non-NULL boolean.
  - True before the change and false after → `failed-assertion` (exit 1).
  - Already false at the baseline → `baseline-failure`, which is not blamed on the change (exit 2).
  - Wrong shape, NULL, or a SQL error → `invalid-fixture` (exit 2).

Sequences are not transactional in PostgreSQL. Both databases start as identical copies and run the same checks in the same order, so generated ids normally match. List them in `ignoreColumns` anyway.

`crashpad validate` checks the config, the manifest, paths, statement kinds, and parameter counts without connecting to a database.

## Running checks

```
crashpad check    --base <ref> [--head <ref>] [--project <dir>] [--report-dir <dir>] [--format md|json]
crashpad validate [--project <dir>]
common options:   --database-url <url>  --keep-databases  --verbose
```

Without `--head`, the candidate is your **working tree**, including uncommitted edits.

How a run works:

1. The baseline's config, checks, SQL, schema, seed, and migrations are read **from the `--base` commit** in Git.
2. A baseline database is built: schema, then seed, then the baseline's migrations.
3. The candidate database is cloned from it with `CREATE DATABASE … TEMPLATE`, so both start with identical data and sequence positions.
4. Only the **new** migrations are applied to the candidate.
5. Each check runs on both sides. The baseline runs the queries as they were at the baseline commit; the candidate runs them as they are in the change.

Also:

- **Query-only changes** are checked too. No migration is needed.
- **New checks** must pass on the candidate.
- **Removed checks** are reported unless they are listed as `retired`.
- **Migration history problems** are reported rather than guessed at. These are edits to existing migrations, removed migrations, a new migration that sorts before existing ones, and edits to the bootstrap schema.
- **Seed edits are ignored**, because both sides use the baseline seed. That way a change cannot hide a regression by changing sample data.

| Exit | Meaning |
|---|---|
| **0** | All configured checks pass. |
| **1** | Actionable: a regression, changed result, failed assertion, unretired removed check, or failed migration. |
| **2** | Could not decide: invalid config, a baseline problem, an infrastructure failure, a timeout or limit (inconclusive), or rewritten migration history. |

A run that could not complete never exits 0. Reports are written as Markdown and as versioned JSON (`crashpad.report/v1`; see [`src/report/types.ts`](src/report/types.ts)) to `--report-dir` (default `crashpad-report/`). Reports never contain database URLs or credentials. PostgreSQL `detail` fields, which can contain row values, are left out.

**The first PR that introduces Crashpad exits 2,** because its baseline commit has no Crashpad config yet. Merge it, then later PRs compare against it.

## GitHub integration

### PR check (composite action)

Add a PostgreSQL service and [`action.yml`](action.yml) to a workflow in your repository:

```yaml
name: Crashpad
on: pull_request
permissions: { contents: read, pull-requests: write }
jobs:
  crashpad:
    name: Crashpad database checks
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_PASSWORD: postgres }
        ports: ["5432:5432"]
        options: --health-cmd pg_isready --health-interval 5s --health-retries 20
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 }                 # the baseline is read from Git history
      - uses: recalculator/crashpad@<commit-sha>
        with:
          project: .                             # directory containing crashpad.config.json
          database-url: postgres://postgres:postgres@localhost:5432/postgres
```

The action:

- installs Crashpad;
- runs `check` with the baseline set to the PR merge commit's first parent, which is the exact base the PR is merged onto;
- writes the report to the **job summary** and uploads it as the `crashpad-report` **artifact**;
- creates or updates a single **PR comment**;
- **fails the check** when the exit code is not 0.

It uses `pull_request`, never `pull_request_target`. On fork PRs the token is read-only, so the comment is skipped and everything else still works. Inputs: `project`, `base`, `database-url`, `comment`, `github-token`. Output: `exit-code`.

This repository runs the same action against its test fixture in [`.github/workflows/crashpad.yml`](.github/workflows/crashpad.yml).

### Comment command

`crashpad comment --report crashpad-report/crashpad-report.json --repo owner/name --pr 123` creates or updates the comment, identified by a hidden marker. A 403 (a read-only token) is logged and does not fail the job.

## Proposing fixes

```
crashpad fix    --base <ref> [--head <ref>] [--project <dir>] [--out <dir>] [--apply]
crashpad fix-pr --repo <owner/name> --branch <target-branch> --base <ref> [--project <dir>] [--plan <fix-plan.json>] [--remote origin] [--dry-run]
```

### What the fixer handles

Explicit `ALTER TABLE … RENAME [COLUMN] a TO b` in a new migration, nothing else:

- It never infers a rename from a drop-and-add.
- It edits only `.sql` source files of failing read and write checks.
- It edits only the identifier tokens that the PostgreSQL parser resolves to the renamed column of that table, using the baseline catalog. Literals, comments, and parameters are never touched.
- Response field names are preserved. `SELECT name` becomes `SELECT full_name AS name`, and `RETURNING name` becomes `RETURNING full_name AS name`.
- It **refuses** anything it cannot resolve with certainty: subqueries, CTEs, `UNION`, `*`, `USING`/`NATURAL` joins, `ON CONFLICT`, `INSERT … SELECT`, ambiguous names, inline SQL, chained renames, and more.

**Guardrails.** Proposals may never touch the config, the manifest, migrations, schema, seed data, or assertion fixtures. A "fix" cannot work by deleting or weakening checks.

### Verification

Crashpad re-runs **every** check with the patch applied to the candidate only. The **baseline side keeps the original queries and their original results.** A patch that makes a query run but changes its output (for example, a missing `AS name`) is reported as `partial`, not verified.

| Outcome | Meaning | Exit |
|---|---|---|
| `verified` | Every check passes against the original baseline contract | 0 |
| `partial` | A patch was proposed, but problems remain or verification was inconclusive | 1 or 2 |
| `unsupported` | No supported edit exists | 1 or 2 |
| `not-needed` | Everything already passes | 0 |

`crashpad fix` writes the following to `--out` (default `crashpad-fix/`):

- `fix.patch`, which applies with `git apply`;
- `fix-plan.json` (`crashpad.fixplan/v1`), with every edit, file hashes, refusals, and an inputs digest;
- the original and verification reports;
- the PR text.

`--apply` writes a verified patch to the working tree.

### Draft fix PRs

`fix-pr` publishes a verified fix as a draft PR **into the branch that contains the breaking change**:

1. It requires `--repo` to match the remote's configured URL.
2. It fetches the target branch and uses only committed remote content.
3. It **re-runs detection and verification**, and refuses anything not `verified`. With `--plan`, it also refuses a stale plan.
4. It commits only the patched files to `crashpad/fix-<branch>-<sha8>` from a temporary `git worktree`. Your checkout is never touched.
5. It pushes **without force**, and refuses if that branch already exists.
6. It opens a **draft** PR with the evidence: what broke, what changed, and a before/after table. Crashpad never approves or merges anything.

If the push succeeds but PR creation fails, `fix-pr` exits 2 and prints the pushed branch and a `gh pr create --draft …` recovery command. It also writes `publish-result.json`. `--dry-run` verifies without pushing.

Locally, `fix-pr` uses `GITHUB_TOKEN`, `GH_TOKEN`, or your `gh auth token`.

**From GitHub Actions:** [`.github/workflows/crashpad-fix-pr.yml`](.github/workflows/crashpad-fix-pr.yml) is a manual (`workflow_dispatch`) workflow:

- It runs Crashpad's code from the **trusted default branch** and reads the target branch only as Git objects. The target's SQL runs only in the throwaway PostgreSQL service.
- It needs `contents: write` and `pull-requests: write`.
- It needs the repository setting **Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"**.

That workflow is written for this repository, where it runs `node bin/crashpad.js`. In your own repository, install Crashpad as a dev dependency and run `npx crashpad fix-pr` with the same steps instead. The fix PR's own Crashpad check compares against the broken target branch, so it reports **exit 2 (existing baseline failure)**. To check the combined result, run `crashpad check --base main --head origin/<fix-branch>`.

## Limitations

This version deliberately **does not** provide:

- **Query discovery.** Only the SQL fixtures you configure are checked. Crashpad does not find queries in code, ORMs, or query builders.
- **Proof of migration safety.** Passing means your fixtures behaved the same on your sample data, nothing more.
- **Performance or locking analysis.** Crashpad does not look at plans, lock levels, rewrite cost, or downtime.
- **An understanding of business rules.** Integrity is checked only through the assertions you write.
- **Fixes beyond explicit column renames** in single-scope statements.

Also:

- It supports one setup: a schema file plus a directory of plain-SQL migrations, one project per config. Unqualified table names are assumed to be in `public`. Migration tools that keep migrations in other formats (JS or Ruby files, down-migrations, checksums tables) need an export step or are not supported.
- **Only a real PostgreSQL server works.** Crashpad uses `CREATE DATABASE … TEMPLATE`, `statement_timeout`, cursors, and deferred constraints. There is no embedded or SQLite mode.
- The rename fixer resolves names against the baseline catalog, so a table created in the same change is unknown to it.
- Results larger than `maxRows` are inconclusive, not compared.

## What has been tested, and how

| Area | How it was tested |
|---|---|
| Check engine, baseline-from-Git, migrations, history rules, every classification and exit code | **Automated, real PostgreSQL 16 and real Git** (`test/integration`) |
| Rename fixer, guardrails, verification against the original baseline | **Automated, real PostgreSQL and Git**, plus unit tests of the rewriter |
| The fixture app's own queries before and after a verified fix | **Automated, real PostgreSQL** (`test/integration/storefront.test.ts`) |
| `fix-pr`: worktree, commit contents, no-force push, refusals, recovery | **Automated against a real local bare Git remote. The GitHub API is faked** (`FakeGitHub`) |
| PR comment create/update, and 403 on fork PRs | **Faked GitHub API**. The create path was also run **live** on a real PR |
| PR check: job summary, artifact, comment, failing check | **Live** on PR #1 (2026-11-27), using the earlier inline version of the workflow |
| Composite `action.yml` | **Live in this repository** on a push to `main` (`uses: ./`): install, check, summary, artifact. Its PR-comment step has not yet run live on a pull request, and it has not been run from another repository |
| `fix-pr` run locally against GitHub | **Live** (draft PR #2) |
| `fix-pr` from GitHub Actions with `GITHUB_TOKEN` | **Live** (draft PR #3, opened by `github-actions[bot]`) |
| Install as a Git dependency (`npm install github:…`) | **Live**, in a fresh empty project, followed by a real `check` run |
| A fork PR with a read-only token | **Not run live.** Covered only by the faked-API test |
| Use on a real application other than the test fixture | **Not done** |
| PostgreSQL other than 16, Windows | **Not tested** |

Run links and details are in [docs/validation.md](docs/validation.md).

## Development

```sh
npm ci
docker compose up -d && export CRASHPAD_DATABASE_URL=postgres://postgres:postgres@localhost:5433/postgres   # or any local PG
npm run typecheck
npm test
```

| Path | Contents |
|---|---|
| `src/` | The CLI and library (strict TypeScript, ESM), compiled to `dist/` |
| `test/unit` | Parser and rewriter, comparison, config, and path validation tests |
| `test/integration` | Real PostgreSQL and real Git tests. Only GitHub's HTTP API is faked |
| `test/fixtures/storefront` | A complete Crashpad project: schema, synthetic seed, migrations, SQL, checks, and a minimal app that runs that SQL |
| `test/fixtures/scenarios` | Changes applied on top of the storefront: a healthy change, a rename, a new required column, a data transformation, a query-only change, and a rename fix |

MIT licensed.
