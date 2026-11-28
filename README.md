# Crashpad

Crashpad checks whether a backend change breaks behavior that already worked. It runs the baseline commit and the changed commit side by side, against real throwaway PostgreSQL databases and real application processes, and reports concrete evidence for every difference.

When something breaks, Crashpad can repair it. Repairs come from its deterministic rename fixer or, on request, from your own installed Claude Code. Crashpad verifies each proposed repair independently before anything is published, and opens a draft fix PR only after that verification passes.

```
$ crashpad check --base main
❌ Crashpad: 1 of 22 check(s) broke (exit 1)
| Permissions | permissions:note-visible-to-owner-and-admin | ❌ regression | 5 step(s) passed | as bob: GET /notes/{{noteId}}: expected status [403,404], got 200 |

$ crashpad repair --base main --agent claude
Crashpad repair: VERIFIED (exit 0)
  original:     1 of 22 check(s) broke
  verification: All 22 check(s) passed
  attempt 1 (claude-code) [completed, 7 turns, est. $0.12]: verified — all checks pass against the original expectations, and the application tests pass
  edit: server.js
```

## Contents

- [The five check areas](#the-five-check-areas)
- [Install](#install)
- [Running checks](#running-checks)
- [Automatic discovery](#automatic-discovery)
- [Optional configuration](#optional-configuration)
- [Repairs](#repairs)
- [GitHub integration](#github-integration)
- [Security and privacy](#security-and-privacy)
- [Limitations](#limitations)
- [What has been tested, and how](#what-has-been-tested-and-how)
- [Development](#development)
- [Architecture](docs/architecture.md) · [GitHub App setup](docs/github-app.md) · [Validation record](docs/validation.md) · [Reused components](docs/third-party.md)

## The five check areas

Each area runs on the **baseline** and the **candidate** and uses the same rules:

- Something that passed before and fails now is a **regression**.
- Something that already failed at the baseline is a **baseline failure**, not blamed on the change.
- Anything that could not be decided is **inconclusive** or **skipped**, never a pass.

Every check has a deadline, names the file or operation involved, and records evidence: SQL errors, requests and responses, application logs, and diffs.

| Area | What Crashpad checks | How |
|---|---|---|
| **1. Database compatibility** | Read queries, write statements, and integrity assertions. New migrations must apply. Migration history must not be rewritten. Query-only changes are checked too. **Without committed migrations** (a Drizzle schema applied with `drizzle-kit push`): **schema compatibility** between the two versions' schema definitions. | Two real PostgreSQL databases: the candidate is a `TEMPLATE` clone of the baseline, with only the new migrations applied. Every check runs in a rolled-back transaction. For Drizzle without migrations, see [Schema compatibility](#schema-compatibility-drizzle-without-migrations). |
| **2. API contracts** | **Specification comparison:** removed operations; newly required parameters, request fields, or bodies; incompatible request/response field types; removed response fields and statuses; fields that became optional or nullable. **Runtime contract checks:** status codes, headers, and response bodies, validated against the baseline OpenAPI schema. | The spec comparison is static: two OpenAPI documents, no app running. Runtime checks call the running app. The report always says which one produced a finding. |
| **3. Configuration and startup** | Startup failures and readiness within a deadline; required variables missing and invalid configured values, where the repository's contract can say so. | Reads the environment contract the repository already has. A JSON Schema's `required` list is enforced. A `.env.example` only *declares* variables: blank entries are often optional, so a missing value is never reported by itself. The startup check decides, and a newly declared variable without a test value is listed in coverage. Starts the app and polls its health endpoint or port. |
| **4. Permissions** | Unauthenticated access, normal user vs administrator, and user A reading user B's resources. | Scenarios with test identities and sessions. Every expected status is stated explicitly. Crashpad never infers that an endpoint should be private. This is **permission-regression testing, not a security audit.** |
| **5. Application workflows** | Multi-step flows such as signup → login → authenticated action, or create → read → update, plus the resulting state and side effects. | Steps can reuse values captured from earlier responses. SQL steps verify stored state, such as audit rows. Every scenario gets a fresh database clone and a fresh app process. |

**Only applicable areas run.** A repository without a database never needs PostgreSQL. An area that applies but lacks input it can't discover (for example, permission expectations) is reported as **not configured**, with the exact missing requirement. Partial coverage is labeled in the report and never counted as passing.

## Install

Requirements:

- Node.js **22.18 or later**.
- Git.
- For database checks, a **PostgreSQL 13+** server where Crashpad may `CREATE DATABASE`. Development uses PostgreSQL 16. Crashpad only creates and drops `crashpad_*` databases; never point it at production.
- Claude Code is **optional**. It is needed only for Claude repairs.

Crashpad is **not published to npm**. Install it from the package archive.

**From a GitHub release** (once a release is published; v0.3.0 is still a draft), download `crashpad-0.3.0.tgz` from the release page, then:

```sh
npm install -g ./crashpad-0.3.0.tgz
crashpad --version                    # 0.3.0
```

**From source:**

```sh
git clone https://github.com/recalculator/crashpad.git && cd crashpad
npm ci && npm pack                    # → crashpad-0.3.0.tgz (runs the build)
npm install -g ./crashpad-0.3.0.tgz   # or add it to one project: npm i -D /path/to/crashpad-0.3.0.tgz
```

Installing from this archive into an empty directory outside the source checkout is covered by an automated test. The archive also contains the service's deployment package (`deploy/`). A Git dependency also works: `npm install -D github:recalculator/crashpad#<commit>`.

## Running checks

```sh
cd your-repo
crashpad discover                 # what Crashpad found, and exactly what is missing
crashpad check --base main        # candidate = your working tree; or --head <ref>
```

| Exit | Meaning |
|---|---|
| **0** | Everything that ran passed. The report still says whether coverage was complete. |
| **1** | Actionable: a regression, changed result, failed assertion, failed migration, check removed without being retired, or a **project command the change broke** (it passed at the baseline). |
| **2** | Could not decide: configuration problem, baseline failure, infrastructure problem, timeout or limit, rewritten migration history, or **nothing was verified**. |

Reports are written as Markdown and as versioned JSON (`crashpad.suite/v1`, see [`src/suite/types.ts`](src/suite/types.ts)) to `--report-dir`. Each report has:

- a per-area coverage table;
- every finding, with baseline and candidate outcomes;
- evidence for each finding, with session tokens, passwords, and URL credentials masked;
- a separate **Project commands** section.

### Project commands

Crashpad also runs the project's own `build`, `typecheck`, and `test` scripts on both versions. They run with the same sanitized test environment and a throwaway database, because builds such as `next build` import server modules. The results are reported **separately** from the five areas:

- they are not counted as Crashpad checks or as coverage;
- a build or test result says nothing about database, API, permission, or workflow behavior.

A command that passed at the baseline and fails now exits 1. A command that already failed at the baseline is reported and not blamed on the change. A green build or startup check is never presented as API, permission, workflow, or database verification.

### Schema compatibility (Drizzle without migrations)

Some projects define their schema in Drizzle ORM code and apply it with `drizzle-kit push`, so there is no migration history. For these, discovery reads `schema` and `dialect` from `drizzle.config.*` by inspection; the file is never executed. Only a single file path is used. An array, a glob, or a directory is reported, and you can set `orm.schema` instead. With a schema found, the database area runs **schema compatibility testing**:

1. For each version, the project's own `drizzle-kit export` produces the DDL for an empty database. That DDL runs in a disposable PostgreSQL database. A candidate schema that does not export or does not create is a regression.
2. Two synthetic sample rows per table, generated from the column types, are written under the **baseline** schema. Parents come before children, and foreign keys point at real parent rows.
3. Those stored rows are replayed into the **candidate** schema. A row the baseline accepts but the candidate rejects is a regression, with the PostgreSQL error as evidence; a new `NOT NULL` column without a default is the typical case. Tables that reference a rejected table are still tested, against stand-in parent rows.
4. A dropped table or column, or a removed enum value, is a regression. ORM definitions do not record renames, so a rename looks like a drop. A changed column type that is not a known widening is reported as undecided: synthetic values fitting proves nothing about real ones.

What this is **not**:

- It does not generate or run the statements that would migrate an existing database. `drizzle-kit push` computes those interactively against a live database.
- It does not verify a migration sequence, and it never uses production data.
- Data-dependent problems are missed, for example duplicates under a new unique constraint.
- The application's queries are not exercised.

The coverage table always lists these gaps, so the database area reports **partial**. The runtime checks use the same exported DDL to give the app a real database.

Other options:

- `--keep-databases` keeps the throwaway databases and work directories for inspection.
- `--no-discovery` uses only explicit configuration.

## Automatic discovery

Discovery supports **one stack: Node.js / TypeScript applications on PostgreSQL**. Each rule looks for a specific file or field. Anything not found is reported with the exact setting that would supply it, and Crashpad asks only for what it cannot discover.

| What | Rule |
|---|---|
| Package manager | `package-lock.json` / `npm-shrinkwrap.json` → `npm ci`; `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`; `yarn.lock` → `yarn install --frozen-lockfile` (`--immutable` with `.yarnrc.yml`). Bun is reported as unsupported. |
| Build / start / tests | The `build`, `start`, `typecheck` (or `type-check`, `check-types`, `tsc`), and `test` scripts. npm's placeholder test script is ignored. |
| Migrations | Prisma (`prisma/migrations/*/migration.sql` with a `postgresql` datasource); Drizzle (`drizzle/` plus `meta/_journal.json`); plain SQL directories (`db/migrations`, `migrations`, `sql/migrations`, `database/migrations`). dbmate up/down files and JS/TS migrations (Knex, node-pg-migrate, TypeORM) are reported as unsupported rather than run incorrectly. If a project uses PostgreSQL but has no migration history (for example `drizzle-kit push` or `prisma db push`), discovery says so. |
| Drizzle schema (no migrations) | `schema` and `dialect` from `drizzle.config.{ts,js,mjs,json}`, read as text, only when it is a single existing file, the dialect is PostgreSQL, and `drizzle-kit` is a dependency. Enables [schema compatibility](#schema-compatibility-drizzle-without-migrations), and the fact says it is not migration testing. |
| Schema, seed, checks | A SQL seed (`db/seed.sql`, `seed.sql`, …) and `crashpad.checks.json`. A `schema.sql` is **not** assumed to be a bootstrap schema, because it may already contain the migrations. By default, migrations apply to an empty database. |
| OpenAPI | `openapi.{yaml,yml,json}` in the project root, `openapi/`, `api/`, `docs/`, or `spec/`. Only OpenAPI 3.0/3.1; Swagger 2 is reported. |
| Environment contract | `.env.example`, `.env.sample`, `.env.template` (declared variables; not treated as required), or `env.schema.json` (its `required` list is enforced). Crashpad **never reads `.env`** or `.env.local`. |
| Port variable | `PORT`, or the one `*_PORT` variable the env example declares, including a commented default such as `# APP_PORT=8787`. `next start` without `-p` reads `PORT`. If there is none, or more than one, Crashpad says it assumes `PORT` and asks for `app.portEnv`. |
| Database URL | The database URL variable's committed example value is **never** used: the app, the build, and the tests only ever get Crashpad's throwaway database. |
| Readiness | A `GET` health path (`/health`, `/healthz`, `/ready`, …) declared in the OpenAPI document. Otherwise readiness means the port accepts connections, and the report says so. |
| Runtime scenarios | `crashpad.http.json`. Permission and workflow expectations can't be discovered, so without this file those areas are reported as not configured. |

Discovery results are stored in Crashpad's own storage (`~/.crashpad`, or `CRASHPAD_HOME`), keyed by repository identity, the exact Git tree, the discovery rules version, and the Crashpad version. A new commit or a tool upgrade always rediscovers.

`crashpad setup` runs onboarding for every repository the GitHub App can see, plus any `--repo-dir` paths:

- it checks the prerequisites: Node, Git, PostgreSQL, Claude Code, and the GitHub connection;
- it discovers each repository from its default branch;
- it shows each area as ready, partial, or needing input, with the exact missing requirement.

It **never writes to a repository**.

## Optional configuration

Configuration is layered: **discovered → Crashpad settings → `crashpad.config.json` in the repo**. Later layers win, and every layer is optional.

**Crashpad settings** are per-repository overrides kept in Crashpad's storage, not in the repository:

```sh
crashpad settings --set 'app.start=["node","dist/server.js"]'
crashpad settings --set app.env.STRIPE_API_KEY=sk_test_placeholder     # a TEST value, never production
crashpad settings --repo acme/api --set app.readiness.path=/livez
```

**Runtime scenarios outside the repository.** If you do not want a Crashpad file in a repository, keep its scenarios (the `crashpad.http.json` format below) in Crashpad's storage instead:

```sh
crashpad scenarios --import ~/crashpad-scenarios/my-app.json      # inside the repository; or --repo owner/name
crashpad scenarios                                               # what is stored
crashpad scenarios --remove
```

- They are validated on import and stored with mode 600, because they may hold test identities' passwords.
- They are used only when the repository has no `crashpad.http.json`. The report's coverage says where they came from.
- They are not versioned with the code, so **the same expectations apply to the baseline and the candidate**.
- During a repair they are loaded once. A repair that changes the stored file is rejected and the file is restored.

**A repository file** (`crashpad.config.json`, version 2) uses the same keys. The existing version-1 database-only format still works.

```json
{
  "version": 2,
  "database": { "migrations": "db/migrations", "seed": "db/seed.sql", "checks": "crashpad.checks.json" },
  "api": { "openapi": "openapi.yaml", "smoke": true },
  "app": {
    "install": ["npm", "ci"], "build": ["npm", "run", "build"], "start": ["npm", "start"],
    "envSchema": { "path": ".env.example", "format": "dotenv-example" },
    "env": { "FEATURE_X": "off" },
    "readiness": { "path": "/health", "timeoutMs": 30000 }
  },
  "http": { "checks": "crashpad.http.json" },
  "tests": [["npm", "test"]]
}
```

Commands are argument arrays and never run through a shell. The **database check manifest** (`crashpad.checks.json`: read, write, and assertion checks) is unchanged from earlier versions; see [`test/fixtures/notes-api`](test/fixtures/notes-api) for a complete example.

**Runtime scenarios** (`crashpad.http.json`) define identities (sign-up and login steps whose captured tokens become headers) and checks:

```json
{
  "version": 1,
  "identities": {
    "alice": { "steps": [
      { "request": { "method": "POST", "path": "/signup", "json": { "email": "alice-{{$run}}@example.test", "password": "pw", "name": "Alice" } }, "expect": { "status": 201 } },
      { "request": { "method": "POST", "path": "/login", "json": { "email": "alice-{{$run}}@example.test", "password": "pw" } }, "capture": { "token": "body.token" } } ],
      "headers": { "authorization": "Bearer {{alice.token}}" } }
  },
  "checks": [
    { "id": "me-contract", "area": "api", "steps": [ { "as": "alice", "request": { "method": "GET", "path": "/me" }, "expect": { "status": 200, "contract": true } } ] },
    { "id": "note-owner-only", "area": "permissions",
      "setup": [ { "as": "alice", "request": { "method": "POST", "path": "/notes", "json": { "title": "x" } }, "capture": { "noteId": "body.id" } } ],
      "request": { "method": "GET", "path": "/notes/{{noteId}}" },
      "expect": { "anonymous": 401, "alice": 200, "bob": [403, 404], "admin": 200 } },
    { "id": "create-then-update", "area": "workflows", "steps": [ "…requests…",
      { "sql": "SELECT title FROM notes WHERE id = $1", "params": ["{{noteId}}"], "expect": { "rows": [["final"]] } } ] }
  ],
  "retired": []
}
```

- `"contract": true` validates the response against the **baseline** OpenAPI schema.
- An existing check is always run with its **baseline definition**, so a change cannot pass by editing its own expectations. To change an expectation, retire the check and add a new id. Removing a check without retiring it is flagged.
- Crashpad also derives **smoke checks** from the baseline contract: public `GET` operations with no required parameters are compared between the two versions.

**Test environment.** The app gets:

- tool variables only (`PATH`, `HOME`, …), and never the caller's other environment;
- committed example values from `.env.example`, which can be turned off;
- explicit test values from settings;
- a generated port, and the throwaway database's URL.

Crashpad never invents a value for a required secret. If one is missing, the report says so.

## Repairs

```sh
crashpad repair --base main                          # deterministic fixer only
crashpad repair --base main --agent claude           # + your Claude Code, if needed
crashpad repair --base main --branch feature --agent claude --publish --repo owner/name
```

1. **Reproduce.** Crashpad re-runs the full check at the **exact failing commit**. It refuses to repair uncommitted work.
2. **Deterministic fast path.** For an explicit `RENAME COLUMN`, the AST-based rename fixer edits the affected SQL files. It uses no model and consumes no Claude usage.
3. **Claude Code**, only with `--agent claude` (or an opt-in policy on your companion; see below):
   - Claude works in an isolated clone at that commit, with its Git remote removed.
   - It receives the failing findings, their evidence, how they were reproduced, and the rules.
   - It may inspect and edit application source, and run the app's own test commands.
4. **Independent verification after every attempt.** Crashpad re-runs every check against the **original commit's expectations**, with the baseline unchanged, and runs the app's tests. A repair is verified when:
   - every regression is gone;
   - nothing newly fails or becomes undecided;
   - something passes;
   - every app test command that passes **at the baseline** passes again.

   Checks that were already undecided before the change (for example, a baseline failure) may remain and are reported. A test command that already fails at the baseline is reported and not counted. Failures, including newly undecided checks, are fed back into the same Claude session for the next attempt.
5. **Stop or publish.** Crashpad stops after `--max-attempts`, the `--deadline-min` deadline, cancellation (Ctrl-C), or a terminal agent error. A draft PR is opened only for a verified result.

**A successful Claude exit proves nothing on its own.** An attempt where Claude reports success but verification fails is rejected. So is an attempt that changes nothing.

Guardrails reject and revert edits to:

- tests and test configuration;
- check manifests and Crashpad configuration;
- migrations that already exist;
- the database bootstrap schema and seed;
- CI configuration;
- `package.json` scripts.

Such attempts are never counted.

### How your Claude Code is used

- **Detection.** Crashpad runs `claude --version` and `claude auth status --json`, which is the CLI's own supported status output. It keeps only the sign-in method, expiry, and plan type. It never reads, copies, or uploads Claude's credential files or keychain.
- **Authentication.** Crashpad uses your existing sign-in, and no separate model-provider API key is needed. In the default `--claude-auth subscription` mode:
  - Crashpad requires a Claude subscription sign-in.
  - It removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from Claude's environment, because the CLI otherwise prefers an API key in print mode.
  - It never uses `--bare`, which ignores subscription sign-ins.
  - `--claude-auth existing` uses whatever method you have configured instead.
- **Invocation.** Claude runs as `claude -p … --output-format json --permission-mode dontAsk` with:
  - an explicit tool allowlist: read, search, and edit, plus your test commands;
  - no MCP servers;
  - `--max-turns`, and optionally `--max-budget-usd` (Claude Code's own cost estimate).

  Anything outside the allowlist is denied, never prompted. **Permission bypass flags are never used.**
- **Usage.** A repair consumes **your Claude usage**, and only when you run `repair --agent claude` or enable a repair policy. Ordinary checks never call Claude. In the live test, one repair took 7–10 turns (est. $0.12–0.14 as reported by Claude Code).
- **Failure handling.** Missing installation, missing or expired sign-in, exhausted usage or rate limits, turn or budget limits, deadlines, and cancellation are each reported plainly, and the repair stops.

**Without Claude Code,** checks, discovery, the deterministic fixer, and the GitHub integration all work. Only Claude repairs are unavailable.

## GitHub integration

### Primary: one GitHub App plus a companion on your computer

You install the Crashpad GitHub App on your account or organization, choosing all repositories or selected ones, and connect your computer once. No per-repository workflow file and no secrets in each repository.

```
GitHub ──webhooks──▶ Crashpad service ◀──HTTPS (outbound)── companion on your computer
  ▲                   (App credentials,                     (runs checks; runs your
  └── check runs,      job queue, policy)                    Claude Code for repairs)
      draft fix PRs
```

- **Service** (`crashpad service`): receives the App's webhooks, decides what may run, queues jobs, publishes check runs, and opens verified fix PRs. It holds the App's own GitHub credentials. It never runs repository code and never touches Claude.
- **Companion** (`crashpad connect --service <url>`, then `crashpad companion`):
  - Pairs through GitHub's device flow. The service uses your GitHub sign-in once to confirm which installations you can access, then discards it.
  - Leases jobs and fetches the **exact commits** using short-lived, single-repository, read-only tokens.
  - Runs the checks locally and repairs with your Claude Code.
  - Your Claude credentials stay on your machine.

How runs behave:

- **Targeting and concurrency.** Each run targets the PR's exact head SHA, compared with its merge base. Duplicate events are ignored. When a PR moves, older jobs are cancelled and their results discarded.
- **Who can trigger runs.** Same-repository branches by owners, members, and collaborators run automatically. **Forks and other authors wait for a user with write access to click "Run Crashpad"**, and are never repaired.
- **Repairs.** They run only when a user with write access clicks **"Repair with Claude"**, or when the owner turns on automatic repair for a repository (`crashpad policy --repo o/r --auto-repair on`). Repairs also have to be enabled on the companion (`crashpad companion --enable-repair`).
- **Loop prevention.** Crashpad's own fix PRs are checked but never repaired. Repairs are limited to one per commit and a small number per PR.
- **Offline.** While your companion is offline, checks stay **pending** with a message saying so and when it was last seen. Nothing is reported as checked, and repairs do not happen while your computer is off.

**Live setup has not been done yet.** Registering the App, hosting the service at a public URL, and enabling device flow need your participation.

- **Deployment package:** [`deploy/`](deploy/README.md). It contains a systemd unit, a backup timer, a Caddyfile, an installer, and a health check.
- **Registration:** `crashpad service register --url https://<host>` registers the App from its manifest and saves its credentials locally.
- **Configuration check:** `crashpad service check [--online]` validates the configuration.
- **Account steps and the acceptance test:** [docs/github-app.md](docs/github-app.md) and [docs/acceptance.md](docs/acceptance.md).

### Alternative: GitHub Actions

The composite action ([`action.yml`](action.yml)) runs `crashpad check` in a workflow with a PostgreSQL service container. It writes the job summary, uploads the report artifact, and posts a PR comment. A manual workflow ([`.github/workflows/crashpad-fix-pr.yml`](.github/workflows/crashpad-fix-pr.yml)) can open verified **rename** fix PRs. Both need per-repository setup and cannot use your local Claude Code.

```yaml
- uses: actions/checkout@v7
  with: { fetch-depth: 0 }
- uses: recalculator/crashpad@<commit-sha>
  with: { project: ., database-url: postgres://postgres:postgres@localhost:5432/postgres }
```

## Security and privacy

- **Running code.** Checks run the change's migrations, app, and tests on the machine running Crashpad. That is why untrusted PRs need explicit approval in the App flow.
- **The app's environment.** Applications under test get a minimal environment. Crashpad's own environment variables, `.env` files, and production values are never passed in.
- **Tokens.**
  - The companion token is stored with mode `600`, and the service keeps only its hash.
  - Installation tokens are short-lived, scoped to one repository, and passed to Git through environment variables, not command-line arguments.
  - GitHub user tokens from pairing are never stored.
- **Reports** mask credential-like JSON fields, `Bearer` tokens, and URL passwords. Database row samples are off by default.

## Limitations

- **One supported stack for discovery** (Node.js/TypeScript + PostgreSQL). Other stacks can be configured explicitly only where the checks are stack-neutral: SQL migrations, OpenAPI, and HTTP scenarios.
- **No query discovery.** Only configured SQL fixtures are checked. Permission and workflow expectations must be written down: they come from explicit scenarios, never from inference. Business rules are only checked through the assertions you write.
- **Spec comparison** covers the rules listed above. `oneOf`/`anyOf` and response enum changes are not compared.
- **Runtime checks** assume an HTTP server that reads its port from an environment variable (`PORT`, a discovered `*_PORT`, or `app.portEnv`).
- **Schema compatibility** (Drizzle without migrations) compares schema definitions using synthetic rows. It is not migration testing; see its section above. Only Drizzle is supported this way, not `prisma db push`.
- **No performance, locking, or downtime analysis, and no security audit.**
- **The companion must be running** for App-driven checks.
- **The service is a single process with file-based state.** It is not a hosted multi-tenant system.
- **Not tested:** PostgreSQL other than 16, Windows, and very large repositories.

## What has been tested, and how

| Area | Live (real) | Mocked / faked |
|---|---|---|
| All five check areas | Real PostgreSQL 16, real Git, real app processes (the `notes-api` fixture), with failures reproduced in each area | — |
| Discovery and onboarding | Real repositories, no Crashpad config file; packaged CLI's `discover` and `settings` | — |
| **Real-project trials** | **Willo** (the owner's Hono/TypeScript app): configuration/startup only; a regression was caught and a **live Claude repair was verified**. **autofounder** (the owner's Next.js + Drizzle `push` app): **database schema compatibility**, startup with a real throwaway database, and the project's `next build` ran; a NOT NULL-column regression that the build, `tsc`, and lint all miss was caught, and a **live Claude repair was verified**. Both used the packaged CLI with no Crashpad file in the repository. API, permission, and workflow areas did not apply to either (no OpenAPI document, no scenarios). See [validation](docs/validation.md). | — |
| Packaging | `npm pack` archive installed in a clean directory outside the checkout, then a real discovered `check` | — |
| Deterministic repair | Real checks and verification | — |
| **Claude Code repair** | **Live on this machine:** Claude Code 2.1.332 with a Pro subscription sign-in repaired a permission regression in 1 attempt (7 turns), verified by Crashpad with all 22 checks and the app tests passing | Rejection of incorrect patches, "success without a fix", guardrail violations, expired sign-in, usage exhaustion, limits, and cancellation use a **mock Claude CLI** |
| GitHub App service and companion | Real service, companion, Git, PostgreSQL, and app processes | **GitHub's API and device flow are faked**, including the Git Data API on a real bare repository. **Not yet run against github.com** |
| Service deployment package | `crashpad service check`, `register` (manifest code exchange), `/healthz`, state persistence, `backup.sh`, and `healthcheck.sh` run in tests against a real service process | GitHub is faked. **The systemd units, `install.sh`, and the Caddyfile have not run on a real host** |
| Stored scenarios | Real notes-api app: a permission regression is caught with no Crashpad file in the repository; a repair cannot change the stored expectations | The repair agent is the mock CLI |
| GitHub Actions integration | Live in this repository: check, summary, artifact, comment, and Actions-opened draft PR (earlier versions) | — |

Details, dates, and run links: [docs/validation.md](docs/validation.md).

## Development

```sh
npm ci
export CRASHPAD_DATABASE_URL=postgres://localhost:5432/postgres   # or: docker compose up -d (port 5433)
npm run typecheck && npm test
```

| Path | Contents |
|---|---|
| `src/suite/` | Common runner, configuration layers, report format, exit codes |
| `src/engines/` | OpenAPI, environment, app process, HTTP scenarios, runtime orchestration |
| `src/runner.ts`, `src/db/`, `src/fix/` | Database engine and the deterministic rename fixer |
| `src/discovery/` | Node/PostgreSQL discovery rules and Crashpad's storage |
| `src/repair/` | Repair loop, guardrails, workspace, Claude Code adapter |
| `src/service/`, `src/companion/` | GitHub App service and local companion |
| `deploy/` | Service deployment package (installer, systemd units, backup, Caddyfile, health check) |
| `test/fixtures/` | `notes-api` (runtime fixture, no Crashpad config), `storefront` (database fixture), `drizzle-app` (Drizzle push project), scenarios, mock Claude CLI |

MIT licensed. Reused open-source components and their licenses: [docs/third-party.md](docs/third-party.md).
