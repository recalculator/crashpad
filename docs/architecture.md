# Crashpad architecture

Crashpad is a TypeScript (strict, ESM) CLI with no server and no frontend. Its interfaces are the CLI, the GitHub check and job summary, the PR comment, and the JSON and Markdown reports.

```
                    ┌──────────────┐
 crashpad CLI ─────►│  context.ts  │  repo root, project dir, base/candidate sources, DB URL
 (src/cli.ts)       └──────┬───────┘
                           ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ runner.ts                                                     │
   │  config.ts ── load + validate config/manifest (zod)           │
   │  fixtures.ts ── resolve check → SQL text, validate via parser │
   │  migrations.ts ── baseline vs candidate migration plan        │
   │  db/postgres.ts ── create/clone/drop DBs, scripts, execute    │
   │  compare.ts ── columns, multiset/ordered rows, ignore columns │
   │  classify() ── per-check verdict; exitCodeFor()               │
   └──────────────┬───────────────────────────────┬───────────────┘
                  ▼                               ▼
        report/{types,markdown}.ts         fix/pipeline.ts
        versioned JSON + Markdown           ├─ proposer.ts  (Proposer interface; RenameProposer)
                                            │    ├─ renames.ts   RENAME COLUMN detection
                                            │    └─ rewriter.ts  AST scope resolution + token edits
                                            ├─ guardrails (allowed files only)
                                            ├─ verification = runner again with OverlaySource
                                            ├─ patch.ts  unified diff, hashes
                                            └─ pr-body.ts
                                                  ▼
                                    github/publish.ts  (fix-pr: worktree, commit, push, draft PR)
                                    github/client.ts   (REST; faked in tests)
                                    commands/comment.ts (upsert PR comment)
```

## Key modules

| Module | Responsibility |
|---|---|
| `source.ts` | A read-only `Source` abstraction. `FsSource` is the working tree, and refuses symlinks that escape it. `GitSource` reads committed blobs via `git ls-tree`/`cat-file`, and refuses symlinks. `OverlaySource` lays proposed edits over another source. Baseline and candidate both read through this interface, so "baseline from Git" and "candidate plus patch" use the same code path. |
| `paths.ts` | Normalizes repository-relative paths. Rejects absolute paths, `..` escapes, backslashes, NUL, and `.git`. |
| `config.ts` | Zod schemas for `crashpad.config.json` and the check manifest. Every path is resolved and validated against the project directory. |
| `sql/parser.ts` | Wraps libpg-query, the real PostgreSQL parser compiled to WASM. Provides parse, scan, byte↔UTF-16 offset mapping, a generic tree walk, and script splitting. |
| `fixtures.ts` | Maps each check to SQL text and a source location. Validates that each fixture is a single statement, of the right kind for its category, with a matching parameter count. |
| `migrations.ts` | Computes baseline vs added migrations and the history issues: edited, removed, or out-of-order. |
| `db/postgres.ts` | Uses `pg` with every type parser replaced by identity, so values are raw text. Creates databases, and clones the candidate from the baseline with `CREATE DATABASE … TEMPLATE`. Runs reads through `pg-cursor` with `maxRows + 1`. Gives every check its own transaction that is always rolled back, with `SET LOCAL statement_timeout` and `SET CONSTRAINTS ALL IMMEDIATE`. Pins session formatting. Classifies errors (SQLSTATE vs infrastructure vs timeout). |
| `runner.ts` | Orchestrates a run and produces the `Report`. The order is: load both projects, plan migrations, build the baseline (schema → seed → baseline migrations), capture the baseline catalog, clone the candidate, apply new migrations, run each check id on both sides, classify, and drop the databases. |
| `fix/rewriter.ts` | The rename fixer core. Parses the statement, refuses unsupported scopes, builds the `FROM` scope from `RangeVar`s, resolves `ColumnRef`s against the baseline catalog, and maps the parser's byte locations to scanner tokens, checking that each token's text matches the AST. It then edits only those tokens and adds `AS <old>` where an output name would change. Finally it self-checks: the result must re-parse, rewriting again must produce no edits, and the output names must be unchanged. |
| `fix/pipeline.ts` | Original run → proposal → guardrails → verification run (baseline source unchanged, candidate replaced by an `OverlaySource`) → outcome, plan, patch, and PR body. |
| `github/publish.ts` | The fix-PR flow: remote match, fetch, fresh verification, stale-plan check, temporary worktree, intended-files-only commit, non-force push, draft PR, and a recovery message. |

## Design decisions

- **Text-exact comparison.** Every value comes back as PostgreSQL's text output, with formatting GUCs pinned. This preserves numeric precision and scale without the JavaScript number pitfalls.
- **The candidate is a template clone of the baseline.** Both databases start with identical rows and sequence positions, so a difference comes from the change, not from setup noise.
- **Seed before migrations.** Sample data is transformed by migrations, the same way production data is. The seed file never goes stale when a column is renamed.
- **Rollback isolation instead of per-check database clones.** This is fast and complete for table data. Sequence effects are documented, and `ignoreColumns` handles generated values.
- **The verification invariant is structural.** `proposeAndVerify` passes the same `input.base` to the verification run and only swaps `input.candidate.source`. The patched SQL cannot reach the baseline side.
- **Guardrails are independent of the proposer.** They inspect the edits themselves, so a future model-based proposer cannot weaken checks or touch migrations.
- **The publisher trusts committed content only.** `fix-pr` reads the target branch as Git objects at the fetched remote tip and commits from a separate worktree. Uncommitted local work can never leak into a PR.
