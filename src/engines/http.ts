import { z } from "zod";
import { ConfigError, formatConfigError, parseJson } from "../config.ts";
import type { PgSession } from "../db/postgres.ts";
import type { Source } from "../source.ts";
import type { Area, Evidence } from "../suite/types.ts";
import { validateResponse, type LoadedSpec } from "./openapi.ts";

/**
 * Runtime HTTP checks (`crashpad.http.json`): API behavior, permissions, and
 * multi-step workflows. Expectations here are explicit; Crashpad never infers an
 * access policy (for example, it never assumes an endpoint must be private).
 */

const Json: z.ZodType<unknown> = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(Json), z.record(z.string(), Json)]));
const Status = z.union([z.number().int().min(100).max(599), z.array(z.number().int().min(100).max(599)).min(1)]);

const RequestSchema = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
    path: z.string().startsWith("/"),
    query: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    json: Json.optional(),
    body: z.string().optional(),
  })
  .strict();

const RequestExpect = z
  .object({
    status: Status.optional(),
    /** Header name → expected value; `*` is a wildcard. `null` means the header must be absent. */
    headers: z.record(z.string(), z.string().nullable()).optional(),
    /** Path into the JSON body (e.g. `items.0.id`) → exact expected JSON value. */
    json: z.record(z.string(), Json).optional(),
    /** Validate the response body against the BASELINE OpenAPI contract for this operation and status. */
    contract: z.boolean().optional(),
  })
  .strict();

const Capture = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().regex(/^(status|body(\..+)?|header\..+)$/));

export const StepSchema = z
  .object({
    name: z.string().optional(),
    /** Identity to act as; omit or null for an unauthenticated request. */
    as: z.string().nullable().optional(),
    request: RequestSchema.optional(),
    /** A SQL read against this scenario's database, to verify resulting state and side effects. */
    sql: z.string().optional(),
    params: z.array(Json).optional(),
    expect: z
      .union([RequestExpect, z.object({ rows: z.array(z.array(z.string().nullable())).optional(), assert: z.literal(true).optional() }).strict()])
      .optional(),
    capture: Capture.optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (!!s.request === !!s.sql) ctx.addIssue({ code: "custom", message: "a step needs exactly one of 'request' or 'sql'" });
  });
export type Step = z.infer<typeof StepSchema>;

const IdentitySchema = z
  .object({
    /** Steps that create and/or log in this identity, run once per scenario on first use. */
    steps: z.array(StepSchema).default([]),
    /** Headers sent with every request made as this identity (templated, e.g. `Bearer {{alice.token}}`). */
    headers: z.record(z.string(), z.string()).default({}),
  })
  .strict();

const id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/, "check ids are lowercase letters, digits, '.', '_' or '-'");

const ScenarioCheck = z
  .object({
    id,
    area: z.enum(["api", "permissions", "workflows"]),
    description: z.string().optional(),
    steps: z.array(StepSchema).min(1),
  })
  .strict();

const MatrixCheck = z
  .object({
    id,
    area: z.literal("permissions"),
    description: z.string().optional(),
    setup: z.array(StepSchema).default([]),
    request: RequestSchema,
    /** Identity name (or `anonymous`) → expected status. Each identity's expectation is explicit. */
    expect: z.record(z.string(), Status),
  })
  .strict();

export const HttpManifestSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1),
    identities: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), IdentitySchema).default({}),
    checks: z.array(z.union([MatrixCheck, ScenarioCheck])),
    retired: z.array(z.object({ id: z.string(), reason: z.string().min(1) }).strict()).default([]),
  })
  .strict()
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    for (const c of m.checks) {
      if (seen.has(c.id)) ctx.addIssue({ code: "custom", message: `duplicate check id: ${c.id}` });
      seen.add(c.id);
      const steps = "steps" in c ? c.steps : [...c.setup];
      const who = [...steps.map((s) => s.as), ...("request" in c && !("steps" in c) ? Object.keys(c.expect).filter((k) => k !== "anonymous") : [])];
      for (const w of who) if (w && !m.identities[w]) ctx.addIssue({ code: "custom", message: `${c.id}: unknown identity "${w}"` });
    }
  });
export type HttpManifest = z.infer<typeof HttpManifestSchema>;
export type HttpCheck = HttpManifest["checks"][number];

export async function loadHttpManifest(source: Source, path: string): Promise<HttpManifest | null> {
  const raw = await source.readFile(path);
  if (raw === null) return null;
  const m = HttpManifestSchema.safeParse(parseJson(raw, path));
  if (!m.success) throw new ConfigError(`${path}: ${formatConfigError(m.error)}`);
  return m.data;
}

export function checkArea(c: HttpCheck): Area {
  return c.area;
}

/** A matrix permission check expands into explicit per-identity steps. */
export function expandSteps(c: HttpCheck): Step[] {
  if ("steps" in c) return c.steps;
  return [
    ...c.setup,
    ...Object.entries(c.expect).map(([who, status]) => ({
      name: `as ${who}`,
      as: who === "anonymous" ? null : who,
      request: c.request,
      expect: { status },
    })),
  ];
}

// ---------------------------------------------------------------------------
// Execution

export type StepFailure = { kind: "expectation" | "error"; step: number; stepName: string; message: string };

export interface ScenarioRun {
  status: "pass" | "fail" | "error";
  failure?: StepFailure;
  evidence: Evidence[];
  durationMs: number;
}

interface Jar {
  cookies: Map<string, string>;
}

export interface ScenarioContext {
  baseUrl: string;
  manifest: HttpManifest;
  /** Baseline OpenAPI contract, for `contract: true` expectations. */
  contract: LoadedSpec | null;
  db: PgSession | null;
  requestTimeoutMs: number;
  deadline: number;
  runId: string;
  side: "baseline" | "candidate";
  /** Throws if the app process died, so failures are attributed correctly. */
  appAlive: () => boolean;
}

function lookup(vars: Record<string, unknown>, key: string): unknown {
  if (key in vars) return vars[key];
  return undefined;
}

/** Replace `{{name}}` / `{{identity.name}}` / `{{$run}}`. A string that is exactly one placeholder keeps the value's type. */
export function template(value: unknown, vars: Record<string, unknown>, encode = false): unknown {
  if (typeof value === "string") {
    const whole = value.match(/^\{\{\s*([$A-Za-z0-9_.]+)\s*\}\}$/);
    if (whole && !encode) {
      const v = lookup(vars, whole[1]!);
      if (v === undefined) throw new Error(`unknown variable {{${whole[1]}}}`);
      return v;
    }
    return value.replace(/\{\{\s*([$A-Za-z0-9_.]+)\s*\}\}/g, (_, k: string) => {
      const v = lookup(vars, k);
      if (v === undefined) throw new Error(`unknown variable {{${k}}}`);
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return encode ? encodeURIComponent(s) : s;
    });
  }
  if (Array.isArray(value)) return value.map((v) => template(v, vars, encode));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, template(v, vars, encode)]));
  return value;
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function statusOk(expected: number | number[] | undefined, actual: number): boolean {
  if (expected === undefined) return true;
  return Array.isArray(expected) ? expected.includes(actual) : expected === actual;
}

function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
  return re.test(value);
}

const SENSITIVE_KEY = /token|password|passwd|secret|api[_-]?key|authorization|cookie|session/i;

/** Mask credential-like fields so reports (which may become PR comments) never carry session tokens or passwords. */
export function redactBody(text: string): string {
  try {
    const mask = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(mask) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SENSITIVE_KEY.test(k) && typeof x !== "object" ? "***" : mask(x)])) : v;
    return JSON.stringify(mask(JSON.parse(text)));
  } catch {
    return text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, "$1***");
  }
}

function excerpt(s: string, n = 600): string {
  const r = redactBody(s);
  return r.length > n ? `${r.slice(0, n)}…` : r;
}

export async function runScenario(check: HttpCheck, ctx: ScenarioContext): Promise<ScenarioRun> {
  const started = Date.now();
  const vars: Record<string, unknown> = { $run: ctx.runId };
  const jars = new Map<string | null, Jar>();
  const loggedIn = new Set<string>();
  const evidence: Evidence[] = [];
  const steps = expandSteps(check);

  const jar = (who: string | null): Jar => {
    let j = jars.get(who);
    if (!j) jars.set(who, (j = { cookies: new Map() }));
    return j;
  };

  const exec = async (step: Step, index: number, label: string, identity: string | null, ns: string | null): Promise<StepFailure | null> => {
    const fail = (kind: StepFailure["kind"], message: string): StepFailure => ({ kind, step: index, stepName: label, message });
    if (Date.now() > ctx.deadline) return fail("error", "scenario deadline reached");
    if (step.sql !== undefined) {
      if (!ctx.db) return fail("error", "SQL step requires a database, but this project has none configured");
      const params = (template(step.params ?? [], vars) as unknown[]) ?? [];
      const r = await ctx.db.execute(step.sql, params, { readOnly: true, maxRows: 1000, timeoutMs: ctx.requestTimeoutMs });
      if (!r.ok) {
        evidence.push({ kind: "sql", side: ctx.side, label: `${label}: SQL`, detail: `${step.sql}\n→ error ${r.error.code ?? ""} ${r.error.message}` });
        return fail(r.error.infrastructure ? "error" : "expectation", `SQL check failed: ${r.error.message}`);
      }
      const rows = r.value.rows;
      evidence.push({ kind: "sql", side: ctx.side, label: `${label}: SQL`, detail: `${step.sql}\n→ ${JSON.stringify(rows.slice(0, 5))}${rows.length > 5 ? ` (+${rows.length - 5} rows)` : ""}` });
      const e = (step.expect ?? {}) as { rows?: (string | null)[][]; assert?: true };
      if (e.rows && JSON.stringify(rows) !== JSON.stringify(e.rows)) return fail("expectation", `SQL rows ${JSON.stringify(rows)} != expected ${JSON.stringify(e.rows)}`);
      if (e.assert && !(rows.length === 1 && rows[0]!.length === 1 && rows[0]![0] === "t")) return fail("expectation", `SQL assertion is not true (got ${JSON.stringify(rows)})`);
      if (step.capture) for (const [name, from] of Object.entries(step.capture)) vars[ns ? `${ns}.${name}` : name] = getPath({ body: rows }, from);
      return null;
    }

    const req = step.request!;
    const who = step.as ?? identity;
    if (who && !loggedIn.has(who)) {
      loggedIn.add(who);
      const def = ctx.manifest.identities[who];
      if (!def) return fail("error", `unknown identity ${who}`);
      for (const [i, s] of def.steps.entries()) {
        const f = await exec(s, index, `${label} › login ${who} step ${i + 1}`, who, who);
        if (f) return f;
      }
    }
    let url: string;
    let headers: Record<string, string>;
    let body: string | undefined;
    try {
      const path = template(req.path, vars, true) as string;
      const query = req.query ? new URLSearchParams(template(req.query, vars) as Record<string, string>).toString() : "";
      url = `${ctx.baseUrl}${path}${query ? `${path.includes("?") ? "&" : "?"}${query}` : ""}`;
      // An identity's own login steps run before its session headers can be filled in.
      const idHeaders = who && ns !== who ? (template(ctx.manifest.identities[who]!.headers, vars) as Record<string, string>) : {};
      headers = { ...idHeaders, ...((template(req.headers ?? {}, vars) as Record<string, string>) ?? {}) };
      if (req.json !== undefined) {
        body = JSON.stringify(template(req.json, vars));
        headers["content-type"] ??= "application/json";
      } else if (req.body !== undefined) body = template(req.body, vars) as string;
    } catch (err) {
      return fail("error", (err as Error).message);
    }
    const cookies = jar(who).cookies;
    if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    let res: Response;
    let text: string;
    const t0 = Date.now();
    try {
      res = await fetch(url, { method: req.method, headers, ...(body !== undefined ? { body } : {}), redirect: "manual", signal: AbortSignal.timeout(Math.max(1, Math.min(ctx.requestTimeoutMs, ctx.deadline - Date.now()))) });
      text = await res.text();
    } catch (err) {
      const msg = (err as Error).name === "TimeoutError" ? `request timed out after ${ctx.requestTimeoutMs} ms` : `request failed: ${(err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message}`;
      evidence.push({ kind: "request", side: ctx.side, label, detail: `${req.method} ${url.replace(ctx.baseUrl, "")} as ${who ?? "anonymous"} → ${msg}` });
      return fail("error", ctx.appAlive() ? msg : `${msg}; the application process exited`);
    }
    for (const c of res.headers.getSetCookie()) {
      const m = c.match(/^([^=;\s]+)=([^;]*)/);
      if (m) cookies.set(m[1]!, m[2]!);
    }
    let parsed: unknown = undefined;
    const ctype = res.headers.get("content-type");
    if (text && ctype && /json/i.test(ctype)) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    evidence.push({
      kind: "request",
      side: ctx.side,
      label,
      detail: `${req.method} ${url.replace(ctx.baseUrl, "")} as ${who ?? "anonymous"} → ${res.status} (${Date.now() - t0} ms)${text ? `\n${excerpt(text)}` : ""}`,
    });
    const e = (step.expect ?? {}) as z.infer<typeof RequestExpect>;
    if (!statusOk(e.status, res.status)) return fail("expectation", `${req.method} ${req.path} as ${who ?? "anonymous"}: expected status ${JSON.stringify(e.status)}, got ${res.status}`);
    for (const [h, expected] of Object.entries(e.headers ?? {})) {
      const actual = res.headers.get(h);
      if (expected === null ? actual !== null : actual === null || !globMatch(expected, actual)) {
        return fail("expectation", `header ${h}: expected ${expected === null ? "absent" : JSON.stringify(expected)}, got ${actual === null ? "absent" : JSON.stringify(actual)}`);
      }
    }
    for (const [p, expected] of Object.entries(e.json ?? {})) {
      const actual = getPath(parsed, p);
      const want = template(expected, vars);
      if (JSON.stringify(actual) !== JSON.stringify(want)) return fail("expectation", `body.${p}: expected ${JSON.stringify(want)}, got ${JSON.stringify(actual)}`);
    }
    if (e.contract) {
      if (!ctx.contract) return fail("error", "contract validation requested, but there is no baseline OpenAPI contract");
      const pathOnly = url.slice(ctx.baseUrl.length);
      const v = validateResponse(ctx.contract, req.method, pathOnly, res.status, ctype, parsed);
      if (v.unchecked) evidence.push({ kind: "note", side: ctx.side, label, detail: `contract: ${v.unchecked}` });
      if (!v.ok) return fail("expectation", `response does not match the baseline contract (${v.operation ?? "no operation"}): ${v.errors.join("; ")}`);
    }
    if (step.capture) {
      for (const [name, from] of Object.entries(step.capture)) {
        const v = from === "status" ? res.status : from === "body" ? parsed : from.startsWith("body.") ? getPath(parsed, from.slice(5)) : res.headers.get(from.slice(7));
        if (v === undefined || v === null) return fail("expectation", `could not capture ${name} from ${from}`);
        vars[ns ? `${ns}.${name}` : name] = v;
      }
    }
    return null;
  };

  for (const [i, step] of steps.entries()) {
    const label = step.name ?? `step ${i + 1}`;
    const f = await exec(step, i + 1, label, null, null);
    if (f) return { status: f.kind === "expectation" ? "fail" : "error", failure: f, evidence, durationMs: Date.now() - started };
  }
  return { status: "pass", evidence, durationMs: Date.now() - started };
}
