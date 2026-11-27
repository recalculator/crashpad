# Reused components

Crashpad's own code is MIT licensed. It reuses these open-source packages at runtime (versions as locked in `package-lock.json`):

| Package | Version | License | Used for |
|---|---|---|---|
| [pg](https://github.com/brianc/node-postgres) | 8.23.1 | MIT | PostgreSQL connections |
| [pg-cursor](https://github.com/brianc/node-postgres) | 2.22.1 | MIT | Bounded reads (`maxRows + 1`) |
| [libpg-query](https://github.com/constructive-io/libpg-query-node) | 18.3.0 | MIT | The real PostgreSQL parser (WASM): statement splitting, fixture validation, the rename fixer |
| [zod](https://github.com/colinhacks/zod) | 4.6.7 | MIT | Configuration and manifest validation |
| [diff](https://github.com/kpdecker/jsdiff) | 9.0.0 | BSD-3-Clause | Unified patches |
| [@apidevtools/swagger-parser](https://github.com/APIDevTools/swagger-parser) | 13.1.0 | MIT | OpenAPI 3.0/3.1 validation and `$ref` dereferencing (external references disabled) |
| [@apidevtools/json-schema-ref-parser](https://github.com/APIDevTools/json-schema-ref-parser) | 16.1.1 | MIT | (dependency of swagger-parser) |
| [js-yaml](https://github.com/nodeca/js-yaml) | 5.5.0 | MIT | (dependency of json-schema-ref-parser) |
| [ajv](https://github.com/ajv-validator/ajv) | 8.20.0 | MIT | Runtime response validation against the baseline OpenAPI contract; JSON Schema environment contracts |
| [ajv-formats](https://github.com/ajv-validator/ajv-formats) | 3.0.1 | MIT | `format` keywords (date-time, email, uuid, …) |
| [yaml](https://github.com/eemeli/yaml) | 2.9.1 | ISC | Reading YAML OpenAPI documents from Git |

What is Crashpad's own: the OpenAPI breaking-change rules (`src/engines/openapi.ts`, applied to the documents swagger-parser dereferences), the baseline/candidate runner, the HTTP scenario runner, discovery, the repair loop, and the GitHub App service and companion.

External programs Crashpad invokes but does not bundle: `git`, `tar`, the project's package manager (npm, pnpm, or Yarn), a PostgreSQL server, and, only for `repair --agent claude`, the user's own Claude Code CLI.

Crashpad reads `.env.example` files itself. It treats them as declarations, not as a list of required variables: the strict "every key is required" convention of [dotenv-safe](https://github.com/rolodato/dotenv-safe) misreported optional keys in a real project.
