import { Ajv2020 } from "ajv/dist/2020.js";
import type { Source } from "../source.ts";

/**
 * Environment contracts, read from the repository:
 * - `dotenv-example`: a `.env.example`-style file. It DECLARES variables, but it
 *   cannot say which are required: many projects list optional keys with blank
 *   values. So Crashpad never reports a declared variable as "missing"; whether
 *   the application actually needs it is decided by the startup check. Non-empty
 *   values are committed examples, never secrets, and may be used as test values.
 * - `json-schema`: a JSON Schema object (`required`, `properties` with types,
 *   enums, patterns). Values are coerced from strings the way apps read them.
 *
 * Crashpad never reads `.env` or any other file holding real values, and never
 * copies the caller's environment into the application under test.
 */

export interface EnvVarDecl {
  name: string;
  line: number;
  example?: string;
}

export interface EnvSchema {
  path: string;
  format: "dotenv-example" | "json-schema";
  /** Variables that must be set (JSON Schema `required` only). */
  required: EnvVarDecl[];
  /** Every variable the file declares (dotenv: active lines; JSON Schema: properties and required). */
  declared: EnvVarDecl[];
  /** Committed example values (dotenv-example only). */
  examples: Record<string, string>;
  jsonSchema?: Record<string, unknown>;
}

export type EnvSchemaLoad = { ok: true; schema: EnvSchema } | { ok: false; path: string; missing: boolean; message: string };

/** Active `NAME=value` lines. With `commented`, also `# NAME=value` lines (documented defaults). */
export function parseDotenvExample(text: string, opts: { commented?: boolean } = {}): EnvVarDecl[] {
  const out: EnvVarDecl[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    let line = raw.trim();
    if (!line) return;
    if (line.startsWith("#")) {
      if (!opts.commented) return;
      line = line.replace(/^#+\s*/, "");
      if (!/^(?:export\s+)?[A-Z_][A-Z0-9_]*=/.test(line)) return;
    }
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) return;
    let v = m[2]!;
    if (/^"/.test(v)) v = v.replace(/^"((?:[^"\\]|\\.)*)".*$/, "$1").replace(/\\n/g, "\n");
    else if (/^'/.test(v)) v = v.replace(/^'([^']*)'.*$/, "$1");
    else v = v.replace(/\s+#.*$/, "").trim();
    out.push({ name: m[1]!, line: i + 1, ...(v ? { example: v } : {}) });
  });
  return out;
}

export async function loadEnvSchema(source: Source, ref: { path: string; format: "dotenv-example" | "json-schema" }): Promise<EnvSchemaLoad> {
  const text = await source.readFile(ref.path);
  if (text === null) return { ok: false, path: ref.path, missing: true, message: `${ref.path} not found` };
  if (ref.format === "dotenv-example") {
    const decls = parseDotenvExample(text);
    const examples: Record<string, string> = {};
    for (const d of decls) if (d.example !== undefined) examples[d.name] = d.example;
    return { ok: true, schema: { path: ref.path, format: ref.format, required: [], declared: decls, examples } };
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, path: ref.path, missing: false, message: `${ref.path} is not valid JSON: ${(err as Error).message}` };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return { ok: false, path: ref.path, missing: false, message: `${ref.path} is not a JSON Schema object` };
  const lines = text.split(/\r?\n/);
  const lineOf = (name: string) => Math.max(1, lines.findIndex((l) => l.includes(`"${name}"`)) + 1);
  const required: EnvVarDecl[] = (Array.isArray(json.required) ? json.required : []).filter((n: unknown) => typeof n === "string").map((n: string) => ({ name: n, line: lineOf(n) }));
  const declared = [...new Set([...required.map((d) => d.name), ...Object.keys(json.properties ?? {})])].map((n) => required.find((d) => d.name === n) ?? { name: n, line: lineOf(n) });
  return { ok: true, schema: { path: ref.path, format: ref.format, required, declared, examples: {}, jsonSchema: json } };
}

export interface EnvIssue {
  name: string;
  kind: "missing" | "invalid";
  message: string;
  line?: number;
}

/** Check a concrete environment against the schema. */
export function validateEnv(schema: EnvSchema, env: Record<string, string>): EnvIssue[] {
  const issues: EnvIssue[] = [];
  for (const d of schema.required) {
    if (env[d.name] === undefined) {
      issues.push({ name: d.name, kind: "missing", message: `${d.name} is required by ${schema.path}:${d.line} but has no value in the test environment`, line: d.line });
    }
  }
  if (schema.jsonSchema) {
    const props = (schema.jsonSchema.properties ?? {}) as Record<string, unknown>;
    const ajv = new Ajv2020({ strict: false, allErrors: true, coerceTypes: true });
    for (const [name, propSchema] of Object.entries(props)) {
      if (env[name] === undefined) continue;
      const validate = ajv.compile({ type: "object", properties: { v: propSchema } });
      const data = { v: env[name] };
      if (!validate(data)) {
        issues.push({ name, kind: "invalid", message: `${name}=${JSON.stringify(redactValue(name, env[name]!))} is invalid per ${schema.path}: ${(validate.errors ?? []).map((e) => e.message).join("; ")}` });
      }
    }
  }
  return issues;
}

const SECRETISH = /SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|_KEY$|^KEY$|DSN/i;

export function redactValue(name: string, value: string): string {
  if (SECRETISH.test(name)) return "***";
  return value.replace(/(\/\/[^:/@\s]+:)[^@\s]+@/g, "$1***@");
}

/** Variables passed through from the caller's environment: only what tools need to run. */
const PASSTHROUGH = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SystemRoot", "ComSpec", "PATHEXT", "npm_config_cache", "COREPACK_HOME"];

export function baseProcessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PASSTHROUGH) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * The environment for the application under test: tool passthrough variables,
 * committed example values (if allowed), explicit test values, then generated
 * values (port, throwaway database URL), in increasing precedence.
 */
export function buildTestEnv(opts: {
  schema: EnvSchema | null;
  useExampleValues: boolean;
  explicit: Record<string, string>;
  generated: Record<string, string>;
}): { env: Record<string, string>; appKeys: string[] } {
  const app: Record<string, string> = {};
  if (opts.schema && opts.useExampleValues) Object.assign(app, opts.schema.examples);
  Object.assign(app, opts.explicit, opts.generated);
  return { env: { ...baseProcessEnv(), ...app }, appKeys: Object.keys(app).sort() };
}

export function redactText(text: string, env: Record<string, string>): string {
  let out = text;
  for (const [k, v] of Object.entries(env)) {
    if (v.length >= 6 && SECRETISH.test(k)) out = out.split(v).join("***");
  }
  return out.replace(/(\/\/[^:/@\s]+:)[^@\s]+@/g, "$1***@");
}
