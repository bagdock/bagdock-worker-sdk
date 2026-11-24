/**
 * Log redaction for the shared adapter-worker logger (BDOK-1111).
 *
 * `@bagdock/worker-sdk` publishes standalone (mirror-inversion, see
 * docs/mirror-inversion-runbook.md) and must stay dependency-free, so this
 * deliberately duplicates the redaction patterns in `packages/utils` rather
 * than taking a workspace dependency on it. Both exist to keep emails,
 * phone numbers, tokens and addresses out of logs — this one is the
 * chokepoint for every adapter worker's `ctx.logger` (Telnyx, Stripe, and
 * any future adapter), applied once instead of at each call site.
 *
 * @compliance SOC 2 CC6.1 | ISO 27001 A.18.1
 */

const REDACT_TOKEN_RE =
  /\b(?:sk|rk_test|rk_live|sk_personal|ik|pk)_[A-Za-z0-9_-]{8,}\b|\bBearer\s+[A-Za-z0-9._-]{10,}\b|\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g
const REDACT_EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
// Phone shape (matches the established pattern in
// apps/operator-api-hono/src/agent/pii-scrub.ts): requires 2-3 grouped runs
// of digits so it doesn't also swallow ISO dates or dashed reference numbers.
const REDACT_PHONE_RE = /(?:\+?\d{1,4}[\s-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g
const REDACT_ADDRESS_RE =
  /\b\d{1,5}\s+(?:[A-Za-z0-9.'-]+\s){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl)\b/gi

function redactString(input: string): string {
  return input
    .replace(REDACT_TOKEN_RE, '[TOKEN_REDACTED]')
    .replace(REDACT_EMAIL_RE, '[EMAIL_REDACTED]')
    .replace(REDACT_ADDRESS_RE, '[ADDRESS_REDACTED]')
    .replace(REDACT_PHONE_RE, '[PHONE_REDACTED]')
}

const MAX_DEPTH = 6

/** Deep-redact PII from any loggable value before it reaches console output. */
export function redactForLog(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value !== 'object') return value
  // Fail closed on excessive nesting rather than passing an unredacted
  // subtree through — a deep webhook/event payload must not bypass this.
  if (depth >= MAX_DEPTH) return '[MAX_DEPTH_REDACTED]'
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    }
  }
  if (Array.isArray(value)) return value.map((v) => redactForLog(v, depth + 1))
  if (value instanceof Date) return value.toISOString()
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    // Not a plain object (Map, Set, RegExp, a class instance, ...) — walking
    // its own enumerable keys would silently collapse it to `{}` for types
    // like Map/Set. Redact its string form instead of losing it outright.
    return redactString(String(value))
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactForLog(v, depth + 1)
  }
  return out
}
