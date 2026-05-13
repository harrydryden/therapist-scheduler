/**
 * Stable JSON stringify: object keys are emitted in lexicographic order
 * at every depth, so semantically-equal inputs produce identical strings
 * regardless of the property order the producer happened to use.
 *
 * The default `JSON.stringify` preserves insertion order, so a tool call
 * `{a: 1, b: 2}` and `{b: 2, a: 1}` hash differently — fine when one
 * producer always emits consistent ordering, but our idempotency hashes
 * (see availability-tool-executor and ai-tool-executor) are designed to
 * dedupe retries across model invocations, where stability is not
 * guaranteed. Canonicalising before hashing closes the gap.
 *
 * Arrays preserve their order (semantically significant). Non-object
 * scalars are stringified normally. Circular structures throw — callers
 * pass JSON-safe inputs already (Zod-validated tool inputs).
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalise);
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of sortedKeys) out[k] = canonicalise(obj[k]);
  return out;
}
