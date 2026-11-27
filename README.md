# Crashpad

Crashpad checks whether a backend change breaks your application's **PostgreSQL behavior** before it merges. It proposes fixes for the cases it understands, verifies them, and can open a draft fix PR.

For a pull request that changes SQL queries or database migrations, Crashpad:

1. Builds two throwaway PostgreSQL databases from your **baseline** schema and synthetic sample data.
2. Applies the PR's **new migrations** to the candidate database only.
3. Runs your configured **read**, **write**, and **integrity-assertion** checks on both databases. The baseline runs the queries as they were at the baseline commit; the candidate runs the queries as the PR changes them.
4. Reports concrete differences: PostgreSQL errors with SQLSTATE codes and `file:line:column`, changed output columns or types, changed rows, changed affected-row counts, and assertions that became false.
5. For an explicit `RENAME COLUMN`, proposes AST-based edits to your real `.sql` files.
6. Re-runs **every** check with the patch. The baseline side still runs the **original** queries and keeps the original results.
7. Optionally pushes the verified patch to a new branch and opens a **draft PR**.

The fixer is a deterministic, rules-based program built on the real PostgreSQL parser. It is not an AI agent and needs no API key.

```
$ crashpad check --base main
❌ Crashpad: 5 of 13 check(s) broke (exit 1)
| `customer-profile` | read | ❌ regression | ok, 1 row(s) | error 42703 undefined_column | `sql/customer_profile.sql:3` |
| `signup` | write | ❌ regression | ok, 1 row(s) affected | error 42703 undefined_column | `sql/create_customer.sql:2` |
...
$ crashpad fix --base main
Crashpad fix: VERIFIED (exit 0)
  original:     5 of 13 check(s) broke
  verification: All 13 check(s) passed
  edit: sql/create_customer.sql (3 change(s))
  edit: sql/customer_profile.sql (3 change(s))
  edit: sql/order_summary.sql (2 change(s))
  edit: sql/update_customer_name.sql (3 change(s))
$ git apply crashpad-fix/fix.patch     # e.g.  c.name,  →  c.full_name AS name,
```

---

## Contents

- [Quickstart](#quickstart)
- [Supported checks](#supported-checks)
- [Configuration](#configuration)
- [Demo](#demo)
- [How baseline comparison works](#how-baseline-comparison-works)
- [How fix verification works](#how-fix-verification-works)
- [Exit codes and reports](#exit-codes-and-reports)
- [GitHub setup](#github-setup)
- [Opening a draft fix PR](#opening-a-draft-fix-pr)
- [Limitations and scope](#limitations-and-scope)
- [Adapting Crashpad to another project](#adapting-crashpad-to-another-project)
- [Architecture](docs/architecture.md) · [Validation summary](docs/validation.md)

## Quickstart

Requirements: Node.js **22.18+** (an LTS line; CI tests 22 and 24), Git, and a PostgreSQL **13+** server where Crashpad can `CREATE DATABASE`. CI and the tests use PostgreSQL 16.

```sh
git clone https://github.com/recalculator/crashpad.git
cd crashpad
npm ci                      # installs and builds dist/ (via the prepare script)

# PostgreSQL: use any server you can create databases on, or start one:
docker compose up -d
export CRASHPAD_DATABASE_URL=postgres://postgres:postgres@localhost:5433/postgres
# (default if unset: postgres://localhost:5432/postgres)

npm run typecheck
npm test                    # unit + real-PostgreSQL integration tests
npm run demo                # the six end-to-end scenarios below
```

Crashpad only connects to the server you give it, creates databases named `crashpad_*`, and drops them after each run (`--keep-databases` keeps them). It never connects to production or tries to infer missing state from a live database.

### CLI

```
crashpad check    --base <ref> [--head <ref>] [--project <dir>] [--report-dir <dir>] [--format md|json]
crashpad fix      --base <ref> [--head <ref>] [--project <dir>] [--out <dir>] [--apply]
crashpad fix-pr   --repo <owner/name> --branch <target-branch> --base <ref> [--project <dir>] [--plan <fix-plan.json>] [--dry-run]
crashpad comment  --report <crashpad-report.json> --repo <owner/name> --pr <number>
crashpad validate [--project <dir>]
```

Inside this repository, run it with `node bin/crashpad.js …` or `npm run crashpad -- …`. Without `--head`, the candidate is your working tree, including uncommitted edits.

## Supported checks

Every check runs in its own transaction, and that transaction is **always rolled back**. Reads and assertions run in `READ ONLY` transactions. Every statement has a deadline (`statement_timeout`).

### 1. Read query compatibility (`"category": "read"`)

A representative `SELECT`, with optional `$1…$n` parameters, runs on both databases. Crashpad reports:

- **Queries that worked before and now fail**, with the PostgreSQL error code and message, mapped to the line and column in your `.sql` file (for example `42703 undefined_column`, `42P01 undefined_table`).
- **Changed output columns**: renamed, added, removed, or retyped. Types include modifiers, so `numeric(12,2) → numeric(14,4)` counts as a change. Columns are compared **even when the result has zero rows**.
- **Changed result contents.** Unordered checks compare rows as a **multiset**, so duplicate counts matter. `"ordered": true` compares rows in order and reports the first differing row.
- **Exact values.** Every value is compared as PostgreSQL's own text output, so values are never rounded through JavaScript numbers. `12345678901234567.89` and `…88` are different, and so are `1.50` and `1.5`. Output settings (time zone, DateStyle, float digits) are pinned, so both sides format values the same way.
- **Results above `limits.maxRows`** make the check **inconclusive** (exit 2). Crashpad never reports a pass by comparing only a truncated prefix.

### 2. Write compatibility (`"category": "write"`)

A representative `INSERT`, `UPDATE`, `DELETE`, or `MERGE` runs on both databases and is then rolled back. Crashpad reports:

- New required columns that break existing inserts (`23502 not_null_violation`).
- Constraint changes that break writes (`23514`, `23503`, `23505`, …). Deferred constraints are checked with `SET CONSTRAINTS ALL IMMEDIATE` before the rollback.
- Renamed or dropped columns that break application writes (`42703`).
- Unexpected affected-row counts, compared with `expectRows` if you set it, otherwise with the baseline's count.
- Changed `RETURNING` output (`compareReturning`, on by default). Columns listed in `ignoreColumns` are excluded.

**Isolation.** Because each write is rolled back, no check can contaminate another, and later checks see the original data. A test covers this: a `DELETE` of every row runs before a count check, and the count check still passes.

**Sequences.** `nextval()` is not transactional in PostgreSQL, so a rolled-back insert still advances its sequence or identity column. Both databases start from an identical copy (`CREATE DATABASE … TEMPLATE`) and run the same checks in the same order, so generated ids usually match. A migration that consumes sequence values, or changes an identity column, shifts them. Generated ids and `now()` timestamps are not stable results: list them in `ignoreColumns`.

### 3. Data-integrity assertions (`"category": "assertion"`)

You define explicit expectations as a `SELECT` that returns **exactly one row with one non-NULL boolean column**:

```sql
SELECT NOT EXISTS (SELECT 1 FROM orders WHERE total < 0)                    -- no negative totals
SELECT NOT EXISTS (SELECT 1 FROM order_items i LEFT JOIN orders o ON o.id = i.order_id WHERE o.id IS NULL)  -- no orphans
SELECT count(*) = 6 FROM customers                                           -- expected record count
SELECT coalesce(sum(total), 0) = 519.56 FROM orders WHERE status IN ('paid', 'shipped')  -- revenue preserved
```

Crashpad keeps three cases apart:

| Case | Classification | Exit |
|---|---|---|
| True before the change, false after | `failed-assertion` | 1 |
| Already false before the change | `baseline-failure` (not blamed on this change) | 2 |
| Not a single boolean: wrong shape, NULL, or a SQL error at baseline | `invalid-fixture` | 2 |

Crashpad does not work out business correctness automatically. Assertions are expectations you write.

## Configuration

`crashpad.config.json` lives in the project directory. All paths are relative to that directory. Absolute paths, `..`, and symlinks that point outside the repository are rejected.

```json
{
  "version": 1,
  "schema": "db/schema.sql",
  "seed": "db/seed.sql",
  "migrations": "db/migrations",
  "checks": "crashpad.checks.json",
  "limits": {
    "maxRows": 1000,
    "statementTimeoutMs": 5000,
    "migrationTimeoutMs": 60000,
    "totalTimeoutMs": 300000
  },
  "report": { "rowSamples": 3 }
}
```

| Key | Meaning |
|---|---|
| `schema` | Bootstrap schema: the database state **before the first file in `migrations`**. Change the schema with new migrations, not by editing this file. |
| `seed` | Optional synthetic sample data. It is loaded right after `schema` and **before** any migrations, so migrations transform it the way they would transform production data. |
| `migrations` | Directory of `*.sql` files, applied in byte-wise filename order (`001_…`, `002_…`). |
| `checks` | The check manifest. |
| `limits.maxRows` | Rows compared per side. A larger result makes the check inconclusive. |
| `limits.statementTimeoutMs` | Deadline per check statement. Exceeding it makes the check inconclusive. |
| `limits.migrationTimeoutMs` | Deadline per statement in schema, seed, and migration scripts. |
| `limits.totalTimeoutMs` | Deadline for the whole run. Checks not started before it are reported as not run, which is inconclusive. |
| `report.rowSamples` | Example differing rows included per changed-result finding. Default `0` (none). Only enable it for synthetic data. |

The check manifest (`crashpad.checks.json`):

```json
{
  "version": 1,
  "checks": [
    { "id": "customer-profile", "category": "read",  "source": "sql/customer_profile.sql", "params": [1] },
    { "id": "order-summary",    "category": "read",  "source": "sql/order_summary.sql",    "params": [1], "ordered": true },
    { "id": "signup",           "category": "write", "source": "sql/create_customer.sql",
      "params": ["new.customer@example.test", "Nova Customer"], "expectRows": 1, "ignoreColumns": ["id", "created_at"] },
    { "id": "no-negative-order-totals", "category": "assertion",
      "sql": "SELECT NOT EXISTS (SELECT 1 FROM orders WHERE total < 0)" }
  ],
  "retired": [
    { "id": "legacy-report", "reason": "report removed in #123; covered by revenue-preserved" }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | Stable check id (`[a-z0-9._-]`). Baseline and candidate checks are matched by id. |
| `category` | `read`, `write`, or `assertion`. |
| `source` **or** `sql` | A real `.sql` file (preferred), or inline SQL. Automatic fixes only ever edit real source files. |
| `params` | JSON values bound to `$1…$n`. Pass numerics as strings (`"42.50"`) for exact precision. The parameter count is validated against the statement. |
| `ordered` | Read checks: compare rows in order. |
| `expectRows` | Write checks: the expected affected-row count. |
| `compareReturning` | Write checks: compare `RETURNING` output (default `true`). |
| `ignoreColumns` | Output columns excluded from comparison, such as generated ids and timestamps. |
| `retired` | Checks deliberately removed, each with a reason. Removing a check without listing it here is flagged for review. |

Each fixture must be **one statement**. Read checks and assertions must be `SELECT`, with no `SELECT INTO` and no data-modifying `WITH`.

**Use the same files as your app.** The sample backend loads `sql/*.sql` at runtime ([`examples/storefront/src/queries.ts`](examples/storefront/src/queries.ts)). There is no second copy of any query, so a fix to a checked file also fixes the application.

`crashpad validate` checks configuration, manifest, paths, statement kinds, and parameter counts without connecting to a database.

## Demo

```sh
npm run demo                     # all six scenarios
npm run demo -- 06-rename-fix    # one scenario
npm run demo -- --keep           # keep the temp repositories and reports for inspection
```

Each scenario builds a **real Git repository** in a temp directory: `main` holds the unchanged [sample storefront](examples/storefront), and a `change` branch holds the scenario's edits. The demo then runs the **real CLI** against your PostgreSQL server and checks the actual exit codes and classifications against the expectations in each [`scenario.json`](examples/scenarios). Nothing in it is a canned report.

| Scenario | What changes | Expected `crashpad check` result |
|---|---|---|
| `01-healthy-change` | Adds a nullable `loyalty_tier` column, an index, and a **new** assertion | exit **0**, and the new check is reported as new |
| `02-renamed-column` | `RENAME COLUMN name TO full_name`; SQL not updated | exit **1**: profile reads, checkout summary, signup, and profile edit fail with `42703` |
| `03-new-required-field` | Adds `NOT NULL marketing_opt_in` (existing rows backfilled) | exit **1**: every read passes; signup fails with `23502` |
| `04-data-transformation` | `UPDATE orders SET total = -total WHERE status = 'refunded'` | exit **1**: all SQL runs; `no-negative-order-totals` and `order-totals-match-items` fail |
| `05-query-only-change` | Edits `order_summary.sql` to use a non-existent `o.shipping_total`, with no migration | exit **1**: `42703` at `sql/order_summary.sql:10:18` |
| `06-rename-fix` | Same rename as 02, then `crashpad fix` | before: exit 1, and **5 of 7 storefront tests fail**; `fix`: **VERIFIED**, exit 0; patched worktree: **storefront tests 7/7 pass**, `check` exits 0; original checkout untouched |

**Exit 1 is the correct, expected result** for scenarios 02–05, and for scenario 06 before the fix: those changes break the app on purpose. The demo script itself exits 0 only if every scenario behaved exactly as expected.

The storefront ([`examples/storefront`](examples/storefront)) is a small TypeScript backend run by Node's built-in type stripping, with a JSON HTTP API. Its operations are customer profile, checkout/order summary, order history, signup, profile edit, order creation, and payment. Its own integration tests (`cd examples/storefront && npm test`) build a database from schema, seed, and every migration.

## How baseline comparison works

```
 baseline commit (--base)                          candidate (working tree or --head)
 ────────────────────────                          ──────────────────────────────────
 crashpad.config.json, checks, *.sql               crashpad.config.json, checks, *.sql
 schema.sql ─┐
 seed.sql   ─┼─► crashpad_base_*  ──TEMPLATE copy──► crashpad_cand_*  ◄── new migrations only
 migrations ─┘     (schema → seed → baseline         (identical data and sequence positions)
 at baseline        migrations)
                       │                                    │
       original fixtures (from the baseline commit)   candidate fixtures (from the candidate)
                       └──────────── compare per check id ──┘
```

- **Baseline source comes from Git.** The config, check manifest, fixture SQL, schema, seed, and migrations are read from the baseline commit with `git ls-tree` and `git cat-file`. The candidate is the working tree, or another commit given with `--head`. Fixtures are matched by check id.
- **Query-only changes** need no migration. If the candidate's SQL references a column that does not exist, it fails on the candidate database, and Crashpad reports it at the exact line and column.
- **New checks** have no baseline contract. They are reported as new and must pass on the candidate. A new check that fails is a regression.
- **Removed checks** are reported as `removed` (exit 1) unless the candidate manifest lists them under `retired` with a reason. A disappeared check never counts as success.
- **New migrations** are the files present in the candidate's migration directory but absent at the baseline. They are applied to the candidate only, in filename order. A failed migration is reported separately from application checks (exit 1), and the remaining checks are skipped.
- **Rewritten history is reported, not guessed at.** An **edited** migration that already existed at the baseline, a **removed** migration, a new migration that sorts **before** the newest baseline migration, or an edited **bootstrap schema** is a blocking history issue (exit 2 unless a regression is also found). Crashpad does not re-apply edited migrations, because databases that already ran the original would never see the edit.
- **Seed edits are ignored on purpose.** Both databases always use the baseline seed, so a change cannot hide a regression by changing sample data. A seed edit is reported as a note.
- Each schema, seed, or migration script runs statement by statement inside one transaction, which gives precise `file:line` errors. Scripts with their own `BEGIN`/`COMMIT`, `CREATE INDEX CONCURRENTLY`, `VACUUM`, and similar statements run as a whole instead.

## How fix verification works

The first fixer handles straightforward **column renames**. It uses the real PostgreSQL parser and scanner ([`libpg-query`](https://github.com/constructive-io/libpg-query-node)):

1. It finds explicit `ALTER TABLE … RENAME [COLUMN] a TO b` statements in the new migrations. It never infers a rename from a drop-and-add or a copy via `UPDATE`. It refuses chained renames, a renamed column that is re-added, and a renamed target that is later dropped.
2. For each failing read or write check backed by a real `.sql` file, it resolves every column reference against the statement's `FROM`/`JOIN` scope and the **baseline catalog**. Only identifier tokens that the parser attributes to the renamed table's column are edited. String literals, comments, and `$n` parameters are never touched.
3. **It preserves response field names.** `SELECT name FROM customers` becomes `SELECT full_name AS name FROM customers`; `RETURNING name` becomes `RETURNING full_name AS name`. `ORDER BY name` keeps referring to the output column. Qualified references (`c.name`, `public.customers.name`), aliases, `INSERT (…)` target columns, and `UPDATE … SET` targets are all handled.
4. **It refuses** cases it cannot reason about. These include subqueries, CTEs, `UNION`, `SELECT *` / `c.*` over the renamed table, `JOIN … USING` / `NATURAL JOIN`, `ON CONFLICT`, `INSERT … SELECT`, casts of the renamed column without an alias, ambiguous unqualified names, tables missing from the baseline catalog, and inline SQL.
5. **Guardrails apply to every proposal**, from this fixer or from a future model-based proposer. A proposal may only edit existing `.sql` source files of configured read and write checks. Crashpad never edits the config, the check manifest, migrations, schema, seed data, or **assertion** fixtures. So a "fix" cannot work by deleting checks, weakening assertions, dropping constraints, or changing data.

**The critical rule: verification never changes the baseline side.** The baseline database runs the **original** queries from the baseline commit and keeps their original results. Only the candidate runs the patched queries, on the migrated database, and **every** configured check is re-run. If a patch made a query run but changed its response (for example `SELECT c.full_name` without the alias), the output-column comparison catches it. The proposal is then `partial`, not verified. [`test/integration/fix.test.ts`](test/integration/fix.test.ts) covers exactly this case.

| Outcome | Meaning | `fix` exit |
|---|---|---|
| `verified` | All checks pass with the patch against the original baseline contract | 0 |
| `partial` | Patch proposed, but some issues remain, or verification was inconclusive | 1 or 2 |
| `unsupported` | No supported edit is possible (not a rename, refused construct, failed migration, …) | 1 or 2 |
| `not-needed` | Everything already passes | 0 |

`crashpad fix` writes these files to `--out` (default `crashpad-fix/`):

- `fix.patch`: a unified diff that applies with `git apply`
- `fix-plan.json`: the machine-readable plan (`crashpad.fixplan/v1`), with every edit and its line and column, before/after SHA-256 hashes, refusals, and an **inputs digest**
- `original-report.{json,md}`: the original findings
- `verification-report.{json,md}`: the verification results
- `pr-description.md` / `pr-body.md`: the proposed PR text

`--apply` writes a **verified** patch to the working tree, after checking that the files have not changed since verification. Only verified proposals can be published as a PR.

The proposer boundary is the `Proposer` interface in [`src/fix/proposer.ts`](src/fix/proposer.ts). A model-based proposer could implement it later. Its output would pass through the same guardrails and the same verification against the original baseline. No model integration is included or required.

## Exit codes and reports

| Exit | Meaning |
|---|---|
| **0** | All configured checks pass |
| **1** | Actionable: regression, changed result, failed assertion, unretired removed check, or failed migration |
| **2** | Invalid configuration, baseline problem (failing baseline check or broken baseline setup), infrastructure failure, deadline/limit/timeout (inconclusive), or rewritten migration history |

If a run finds actionable regressions, it exits 1 even when other checks are undecided. A run that could not complete or decide never exits 0, so an incomplete run cannot look green.

Reports come as Markdown and as versioned JSON (`crashpad.report/v1`, see [`src/report/types.ts`](src/report/types.ts)). Each finding has:

- check id and category
- source file and line
- baseline and candidate outcomes
- the PostgreSQL SQLSTATE, message, and `file:line:column` where available
- a classification: `pass`, `regression`, `changed-result`, `failed-assertion`, `baseline-failure`, `invalid-fixture`, `inconclusive`, `skipped`, `removed`, or `retired`

Migration failures appear in their own section, separate from application checks. Reports contain no database URLs or credentials. Row samples are off by default and only meant for synthetic data. PostgreSQL error `detail` fields, which can contain row values, are not included.

## GitHub setup

This repository runs three workflows:

- [`.github/workflows/crashpad.yml`](.github/workflows/crashpad.yml) runs on every `pull_request` as the check **"Crashpad database checks"**. The baseline is the PR merge commit's first parent, which is the exact base the PR is merged onto. The job writes the Markdown report to the **job summary**, uploads `crashpad-report/` as an **artifact**, creates or updates a single **PR comment** (identified by a hidden marker), and **fails the check** when Crashpad exits non-zero.
- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs typecheck, tests, storefront tests, and the full demo against a PostgreSQL 16 service container on Node 22 and 24.
- [`.github/workflows/crashpad-fix-pr.yml`](.github/workflows/crashpad-fix-pr.yml) is the manual fix-PR workflow ([below](#opening-a-draft-fix-pr)).

**Fork PRs and security.** The PR check uses `pull_request`, never `pull_request_target`, so PR code never runs with write credentials it shouldn't have. For fork PRs, GitHub makes the token read-only. The check, job summary, and artifact still work, and the comment step logs that it was skipped instead of failing.

### Using Crashpad in another repository

Add a PostgreSQL service and the composite action ([`action.yml`](action.yml)):

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
        with: { fetch-depth: 0 }          # Crashpad reads the baseline from Git history
      - uses: recalculator/crashpad@main  # pin to a commit SHA for production use
        with:
          project: .                      # directory with crashpad.config.json
          database-url: postgres://postgres:postgres@localhost:5432/postgres
```

## Opening a draft fix PR

The fix PR **targets the branch that contains the breaking change**, because the patch only makes sense on top of that change's migration. Merge the fix PR into that branch, and the original PR's Crashpad check goes green.

**From your machine** (uses `GITHUB_TOKEN`/`GH_TOKEN`, or your `gh auth` login):

```sh
crashpad fix --base main                    # optional: inspect the patch and plan first
crashpad fix-pr --repo owner/name --branch my-feature --base main \
                --project examples/storefront --plan crashpad-fix/fix-plan.json
```

`fix-pr` does the following:

1. Requires `--repo` to match the configured `origin` URL.
2. Fetches the target branch from the remote. It only uses committed remote content, never your uncommitted work.
3. **Re-runs detection, proposal, and verification right before publishing.** It refuses anything that is not fully `verified`.
4. If `--plan` is given, refuses when the plan is stale: a different base, a changed inputs digest (any SQL source, migration, config, or check changed), or a different patch.
5. Creates `crashpad/fix-<branch>-<sha8>` in a **temporary `git worktree`**, checks that each file still matches the verified input, commits **only** those files, and confirms that the commit's diff touches exactly those paths.
6. Pushes the new branch **without force**. It refuses if the branch already exists.
7. Opens a **draft** PR into the target branch, with the original failures, the changes, a before/after verification table, and the patch.
8. Removes the worktree. Your checkout's HEAD, branch, index, and working tree are never touched.

If the push succeeds but PR creation fails, `fix-pr` exits 2 and prints the pushed branch name plus a ready-made `gh pr create --draft …` recovery command. The same details are written to `publish-result.json`. `--dry-run` verifies everything without pushing.

**From GitHub Actions:** run **Actions → Crashpad fix PR → Run workflow** from the default branch, with `target_branch` set. The workflow runs Crashpad's own code from the trusted default branch. It reads the target branch only as Git objects, and the target's SQL runs only inside the throwaway PostgreSQL service; none of the target branch's scripts or dependencies are executed. For the default `GITHUB_TOKEN` to open PRs, the repository setting **Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"** must be enabled. Without it, the branch is pushed and the PR step fails with the recovery message above. Also, PRs opened with `GITHUB_TOKEN` do not trigger other workflows, so use a GitHub App token if you need CI on the fix PR itself.

## Limitations and scope

This first version deliberately **does not provide**:

- **Universal ORM or query discovery.** Crashpad checks the SQL fixtures you configure. It does not find queries in your code, ORMs, or query builders. SQL that is not in the manifest is not checked or fixed.
- **Guaranteed migration safety.** Passing checks mean your representative fixtures behaved the same on your sample data. They are not a proof that every query or data shape is safe.
- **Production performance or lock-contention analysis.** Timeouts guard the run, but Crashpad does not measure plans, lock levels, rewrite costs, or downtime.
- **Automatic understanding of all business rules.** Integrity is checked only through the assertions you write.
- **Automatic fixes for arbitrary backend bugs.** The only fixer handles explicit column renames in single-scope statements. Everything else is reported and left to you.

Also:

- One well-defined setup: **PostgreSQL 13+** (developed and tested on 16; the SQL parser is libpg-query's PostgreSQL 18 grammar), a bootstrap schema file plus a directory of plain-SQL migrations, and one project per config. Unqualified table names are assumed to be in `public`.
- The rename fixer resolves names against the baseline catalog. A table created by a new migration in the same change is unknown to it, and a query involving it is refused if the reference is ambiguous.
- Very large results are not compared. They become inconclusive above `maxRows`.
- **No embedded PostgreSQL (PGlite) mode.** Crashpad relies on real-server behavior: `CREATE DATABASE … TEMPLATE` cloning, `statement_timeout`, protocol-level cursors, and deferred-constraint checks. Use Docker or any local PostgreSQL. SQLite is not supported, because it cannot stand in for PostgreSQL migration behavior.

## Adapting Crashpad to another project

1. Put your bootstrap schema in a `.sql` file. One way is `pg_dump --schema-only` of a fresh database at the commit where you start using Crashpad, then start `migrations/` from there. If your migration tool keeps one directory of ordered `.sql` files, point `migrations` at it.
2. Write **synthetic** seed data that covers the shapes your queries care about: NULLs, duplicates, empty relationships, large numerics, every status value.
3. Move the queries you care about into `.sql` files that your application loads at runtime, and add a check for each one with representative parameters. Add assertions for the invariants your business relies on.
4. Run `crashpad validate`, then `crashpad check --base HEAD`, which should exit 0.
5. Commit the config and checks, and add the GitHub workflow or composite action. Crashpad compares against the baseline commit's config, so the PR that introduces Crashpad exits 2: there is no baseline contract yet.

## Development

```sh
npm ci && npm run typecheck && npm test && npm run demo
```

- `src/`: the CLI and library (TypeScript, strict). It is compiled to `dist/` by `npm run build`, which `npm ci` runs.
- `test/unit`: parser, rewriter, comparison, config, and path validation tests.
- `test/integration`: real PostgreSQL and real Git tests. Only GitHub HTTP calls are faked: a fake `GitHubApi` stands in for them, while a local bare repository serves as the remote.
- `examples/storefront`: the sample backend. `examples/scenarios`: the demo inputs. `scripts/demo.ts`: the demo runner.

MIT licensed.
