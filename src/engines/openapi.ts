import SwaggerParser from "@apidevtools/swagger-parser";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse as parseYaml } from "yaml";
import type { Source } from "../source.ts";

/**
 * OpenAPI support. Parsing, `$ref` dereferencing, and document validation use
 * @apidevtools/swagger-parser (MIT). Response validation uses Ajv (MIT). The
 * breaking-change rules below are Crashpad's own and operate on the dereferenced
 * documents. External `$ref`s are never fetched: only the committed file is used.
 */

export const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"] as const;

type Json = any;

export interface LoadedSpec {
  path: string;
  version: "3.0" | "3.1";
  doc: Json;
}

export type SpecLoad = { ok: true; spec: LoadedSpec } | { ok: false; missing: boolean; message: string };

export async function loadSpec(source: Source, path: string): Promise<SpecLoad> {
  const text = await source.readFile(path);
  if (text === null) return { ok: false, missing: true, message: `${path} not found` };
  let obj: Json;
  try {
    obj = path.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  } catch (err) {
    return { ok: false, missing: false, message: `${path} does not parse: ${(err as Error).message}` };
  }
  if (!obj || typeof obj !== "object") return { ok: false, missing: false, message: `${path} is not an OpenAPI document` };
  if (typeof obj.swagger === "string") return { ok: false, missing: false, message: `${path} is Swagger ${obj.swagger}; only OpenAPI 3.0 and 3.1 are supported` };
  const v = typeof obj.openapi === "string" ? obj.openapi : "";
  const version = v.startsWith("3.0") ? "3.0" : v.startsWith("3.1") ? "3.1" : null;
  if (!version) return { ok: false, missing: false, message: `${path}: unsupported or missing "openapi" version (${v || "none"})` };
  try {
    const opts = { resolve: { external: false, file: false, http: false } } as unknown as SwaggerParser.Options;
    await SwaggerParser.validate(structuredClone(obj), opts);
    const doc = await SwaggerParser.dereference(structuredClone(obj), opts);
    return { ok: true, spec: { path, version, doc } };
  } catch (err) {
    return { ok: false, missing: false, message: `${path} is not a valid OpenAPI ${version} document: ${(err as Error).message.split("\n")[0]}` };
  }
}

/** `/users/{id}` and `/users/{userId}` are the same route. */
export function normalizeTemplate(p: string): string {
  return p.replace(/\{[^}]+\}/g, "{}");
}

export interface Operation {
  method: string;
  path: string;
  key: string;
  op: Json;
  params: Json[];
}

export function operations(doc: Json): Map<string, Operation> {
  const out = new Map<string, Operation>();
  for (const [p, item] of Object.entries<Json>(doc.paths ?? {})) {
    if (!item || typeof item !== "object") continue;
    for (const m of METHODS) {
      const op = item[m];
      if (!op) continue;
      const key = `${m.toUpperCase()} ${normalizeTemplate(p)}`;
      // Path-level parameters apply unless the operation overrides them.
      const byKey = new Map<string, Json>();
      for (const prm of [...(item.parameters ?? []), ...(op.parameters ?? [])]) if (prm?.name && prm?.in) byKey.set(`${prm.in}:${prm.name}`, prm);
      out.set(key, { method: m.toUpperCase(), path: p, key, op, params: [...byKey.values()] });
    }
  }
  return out;
}

export interface BreakingChange {
  rule:
    | "removed-operation"
    | "new-required-parameter"
    | "parameter-type-changed"
    | "request-body-required"
    | "new-required-request-field"
    | "request-field-type-changed"
    | "request-enum-narrowed"
    | "removed-response-status"
    | "removed-response-media-type"
    | "removed-response-field"
    | "response-field-type-changed"
    | "response-field-optional"
    | "response-field-nullable";
  operation: string;
  /** JSON-pointer-like location inside the operation. */
  location: string;
  message: string;
}

function types(s: Json): Set<string> {
  if (!s || typeof s !== "object") return new Set();
  const t = s.type;
  const out = new Set<string>(Array.isArray(t) ? t : typeof t === "string" ? [t] : []);
  if (s.nullable === true) out.add("null");
  return out;
}

function primary(s: Json): string | undefined {
  return [...types(s)].find((t) => t !== "null");
}

/** Merge `allOf` members so their properties and required lists are compared together. */
function flatten(s: Json, depth = 0): Json {
  if (!s || typeof s !== "object" || !Array.isArray(s.allOf) || depth > 8) return s;
  const out: Json = { ...s, properties: { ...(s.properties ?? {}) }, required: [...(s.required ?? [])] };
  delete out.allOf;
  for (const part of s.allOf) {
    const f = flatten(part, depth + 1);
    if (f.type && !out.type) out.type = f.type;
    Object.assign(out.properties, f.properties ?? {});
    out.required.push(...(f.required ?? []));
  }
  return out;
}

function jsonMedia(content: Json): string | undefined {
  return Object.keys(content ?? {}).find((m) => m === "application/json" || /\+json$/.test(m) || m === "*/*");
}

function compareResponse(b0: Json, c0: Json, op: string, loc: string, out: BreakingChange[], seen: Set<Json>, depth: number): void {
  const b = flatten(b0);
  const c = flatten(c0);
  if (!b || !c || depth > 12 || seen.has(b0)) return;
  seen.add(b0);
  const bt = primary(b);
  const ct = primary(c);
  // integer → number in a response can now carry fractions; number → integer is a narrowing, so it is safe.
  if (bt && ct && bt !== ct && !(bt === "number" && ct === "integer")) {
    out.push({ rule: "response-field-type-changed", operation: op, location: loc, message: `${loc || "response body"} changed type from ${bt} to ${ct}` });
    return;
  }
  if (!types(b).has("null") && types(c).has("null")) {
    out.push({ rule: "response-field-nullable", operation: op, location: loc, message: `${loc || "response body"} can now be null` });
  }
  if ((bt === "object" || b.properties) && b.properties) {
    const bReq = new Set<string>(b.required ?? []);
    const cReq = new Set<string>(c.required ?? []);
    for (const [name, bs] of Object.entries<Json>(b.properties)) {
      const cs = c.properties?.[name];
      const at = `${loc}/${name}`;
      if (cs === undefined) {
        out.push({ rule: "removed-response-field", operation: op, location: at, message: `response field ${at.slice(1)} was removed` });
        continue;
      }
      if (bReq.has(name) && !cReq.has(name)) out.push({ rule: "response-field-optional", operation: op, location: at, message: `response field ${at.slice(1)} is no longer required (clients may not get it)` });
      compareResponse(bs, cs, op, at, out, seen, depth + 1);
    }
  }
  if (bt === "array" && b.items && c.items) compareResponse(b.items, c.items, op, `${loc}[]`, out, seen, depth + 1);
}

function compareRequest(b0: Json, c0: Json, op: string, loc: string, out: BreakingChange[], seen: Set<Json>, depth: number): void {
  const b = flatten(b0);
  const c = flatten(c0);
  if (!b || !c || depth > 12 || seen.has(c0)) return;
  seen.add(c0);
  const bt = primary(b);
  const ct = primary(c);
  // Accepting number where integer was accepted is a widening; anything else breaks existing callers.
  if (bt && ct && bt !== ct && !(bt === "integer" && ct === "number")) {
    out.push({ rule: "request-field-type-changed", operation: op, location: loc, message: `request ${loc || "body"} changed type from ${bt} to ${ct}` });
    return;
  }
  if (Array.isArray(b.enum) && Array.isArray(c.enum)) {
    const dropped = b.enum.filter((v: unknown) => !c.enum.some((w: unknown) => JSON.stringify(w) === JSON.stringify(v)));
    if (dropped.length) out.push({ rule: "request-enum-narrowed", operation: op, location: loc, message: `request ${loc || "body"} no longer accepts ${dropped.map((d: unknown) => JSON.stringify(d)).join(", ")}` });
  }
  if (c.properties || ct === "object") {
    const bReq = new Set<string>(b.required ?? []);
    for (const name of c.required ?? []) {
      if (!bReq.has(name)) {
        const existed = b.properties?.[name] !== undefined;
        out.push({ rule: "new-required-request-field", operation: op, location: `${loc}/${name}`, message: `request field ${`${loc}/${name}`.slice(1)} is ${existed ? "now required (was optional)" : "new and required"}` });
      }
    }
    for (const [name, cs] of Object.entries<Json>(c.properties ?? {})) {
      const bs = b.properties?.[name];
      if (bs) compareRequest(bs, cs, op, `${loc}/${name}`, out, seen, depth + 1);
    }
  }
  if (bt === "array" && b.items && c.items) compareRequest(b.items, c.items, op, `${loc}[]`, out, seen, depth + 1);
}

/** Breaking changes from the baseline contract to the candidate contract, per baseline operation. */
export function diffSpecs(base: Json, cand: Json): { operations: string[]; changes: BreakingChange[] } {
  const bOps = operations(base);
  const cOps = operations(cand);
  const changes: BreakingChange[] = [];
  for (const [key, b] of bOps) {
    const c = cOps.get(key);
    if (!c) {
      changes.push({ rule: "removed-operation", operation: key, location: "", message: `${b.method} ${b.path} was removed` });
      continue;
    }
    const bParams = new Map(b.params.map((p) => [`${p.in}:${p.name}`, p]));
    for (const p of c.params) {
      const k = `${p.in}:${p.name}`;
      const old = bParams.get(k);
      if (p.in === "path") continue; // path parameters are part of the route itself
      if (p.required && (!old || !old.required)) {
        changes.push({ rule: "new-required-parameter", operation: key, location: `parameters/${k}`, message: `${p.in} parameter "${p.name}" is ${old ? "now required" : "new and required"}` });
      }
      if (old?.schema && p.schema) {
        const bt = primary(old.schema);
        const ct = primary(p.schema);
        if (bt && ct && bt !== ct && !(bt === "integer" && ct === "number")) {
          changes.push({ rule: "parameter-type-changed", operation: key, location: `parameters/${k}`, message: `${p.in} parameter "${p.name}" changed type from ${bt} to ${ct}` });
        }
      }
    }
    const bBody = b.op.requestBody;
    const cBody = c.op.requestBody;
    if (cBody?.required && !bBody?.required) {
      changes.push({ rule: "request-body-required", operation: key, location: "requestBody", message: "a request body is now required" });
    }
    if (bBody && cBody) {
      const bm = jsonMedia(bBody.content);
      const cm = jsonMedia(cBody.content);
      if (bm && cm) compareRequest(bBody.content[bm].schema, cBody.content[cm].schema, key, "", changes, new Set(), 0);
    }
    for (const [status, bResp] of Object.entries<Json>(b.op.responses ?? {})) {
      if (!/^2\d\d$|^2XX$/i.test(status)) continue;
      const cResp = c.op.responses?.[status];
      if (!cResp) {
        changes.push({ rule: "removed-response-status", operation: key, location: `responses/${status}`, message: `response ${status} is no longer returned` });
        continue;
      }
      const bm = jsonMedia(bResp.content);
      if (!bm) continue;
      const cm = jsonMedia(cResp.content);
      if (!cm) {
        changes.push({ rule: "removed-response-media-type", operation: key, location: `responses/${status}`, message: `response ${status} no longer returns ${bm}` });
        continue;
      }
      const before = changes.length;
      compareResponse(bResp.content[bm].schema, cResp.content[cm].schema, key, "", changes, new Set(), 0);
      for (const ch of changes.slice(before)) ch.location = `responses/${status}${ch.location}`;
    }
  }
  return { operations: [...bOps.keys()], changes };
}

// ---------------------------------------------------------------------------
// Runtime response validation against a (baseline) contract.

/** Convert an OpenAPI 3.0 schema object into JSON Schema 2020-12 (nullable, boolean exclusive bounds). */
export function toJsonSchema(s: Json, version: "3.0" | "3.1", memo = new Map<Json, Json>()): Json {
  if (!s || typeof s !== "object") return s;
  if (memo.has(s)) return memo.get(s);
  if (Array.isArray(s)) {
    const arr: Json[] = [];
    memo.set(s, arr);
    for (const x of s) arr.push(toJsonSchema(x, version, memo));
    return arr;
  }
  const out: Json = {};
  memo.set(s, out);
  for (const [k, v] of Object.entries<Json>(s)) {
    if (["example", "examples", "xml", "externalDocs", "discriminator", "deprecated"].includes(k) && version === "3.0") continue;
    out[k] = toJsonSchema(v, version, memo);
  }
  if (version === "3.0") {
    if (out.nullable === true) {
      if (typeof out.type === "string") out.type = [out.type, "null"];
      else if (Array.isArray(out.enum)) out.enum = [...out.enum, null];
    }
    delete out.nullable;
    if (out.exclusiveMinimum === true) out.exclusiveMinimum = out.minimum, delete out.minimum;
    else if (out.exclusiveMinimum === false) delete out.exclusiveMinimum;
    if (out.exclusiveMaximum === true) out.exclusiveMaximum = out.maximum, delete out.maximum;
    else if (out.exclusiveMaximum === false) delete out.exclusiveMaximum;
  }
  return out;
}

function hasCycle(s: Json, stack = new Set<Json>()): boolean {
  if (!s || typeof s !== "object") return false;
  if (stack.has(s)) return true;
  stack.add(s);
  for (const v of Object.values(s)) if (hasCycle(v, stack)) return true;
  stack.delete(s);
  return false;
}

/** Find the spec operation matching a concrete request path, e.g. `/orders/42` → `GET /orders/{}`. */
export function matchOperation(spec: LoadedSpec, method: string, concretePath: string): Operation | null {
  const pathOnly = concretePath.split("?")[0]!;
  for (const op of operations(spec.doc).values()) {
    if (op.method !== method.toUpperCase()) continue;
    const esc = (x: string) => x.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
    const re = new RegExp(`^${op.path.split(/\{[^}]+\}/).map(esc).join("[^/]+")}$`);
    if (re.test(pathOnly)) return op;
  }
  return null;
}

export interface ResponseValidation {
  ok: boolean;
  operation: string | null;
  errors: string[];
  /** Set when the contract has no schema for this status/media type, so nothing was validated. */
  unchecked?: string;
}

/** Validate a response against the contract's schema for its operation and status. */
export function validateResponse(spec: LoadedSpec, method: string, path: string, status: number, contentType: string | null, body: unknown): ResponseValidation {
  const op = matchOperation(spec, method, path);
  if (!op) return { ok: false, operation: null, errors: [`${method.toUpperCase()} ${path} is not in the contract ${spec.path}`] };
  const responses = op.op.responses ?? {};
  const resp = responses[String(status)] ?? responses[`${String(status)[0]}XX`] ?? responses.default;
  if (!resp) return { ok: false, operation: op.key, errors: [`status ${status} is not documented for ${op.method} ${op.path}`] };
  const media = jsonMedia(resp.content);
  if (!media) return { ok: true, operation: op.key, errors: [], unchecked: `no JSON schema documented for status ${status}` };
  if (contentType && !/json/i.test(contentType)) return { ok: false, operation: op.key, errors: [`expected a JSON response, got content-type ${contentType}`] };
  const schema = resp.content[media].schema;
  if (!schema) return { ok: true, operation: op.key, errors: [], unchecked: `no schema documented for status ${status}` };
  if (hasCycle(schema)) return { ok: true, operation: op.key, errors: [], unchecked: "recursive schema; not validated" };
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  (addFormats as unknown as (a: Ajv2020) => void)(ajv);
  const validate = ajv.compile(toJsonSchema(schema, spec.version));
  const ok = validate(body) as boolean;
  return { ok, operation: op.key, errors: ok ? [] : (validate.errors ?? []).slice(0, 10).map((e) => `${e.instancePath || "(body)"} ${e.message ?? "is invalid"}`) };
}
