/**
 * Tests for the shared logger's PII redaction (BDOK-1111).
 *
 * This is the chokepoint for every adapter worker's `ctx.logger` — a
 * regression here (a widened phone regex swallowing dates, a depth cap
 * that passes nested objects through unredacted, etc.) leaks PII to
 * Cloudflare Workers Logs across every adapter, silently.
 */

import { describe, it, expect } from 'vitest'
import { redactForLog } from '../redact'

describe('redactForLog', () => {
  it('redacts an email in a string', () => {
    expect(redactForLog('contact jane@example.com now')).toBe('contact [EMAIL_REDACTED] now')
  })

  it('redacts phone numbers', () => {
    expect(redactForLog('+14155551234')).toBe('[PHONE_REDACTED]')
    expect(redactForLog('(415) 555-1234')).toBe('[PHONE_REDACTED]')
  })

  it('does not redact ISO dates or dashed reference numbers as phone numbers', () => {
    expect(redactForLog('2026-09-14')).toBe('2026-09-14')
    expect(redactForLog('order ref 2026-09-14-00931')).toBe('order ref 2026-09-14-00931')
  })

  it('redacts API keys/tokens', () => {
    expect(redactForLog('sk_live_ABC123XYZ789token')).toBe('[TOKEN_REDACTED]') // gitleaks:allow (fake key shape for the redaction test)
  })

  it('redacts street addresses', () => {
    expect(redactForLog('123 Main Street, Springfield')).toBe('[ADDRESS_REDACTED], Springfield')
  })

  it('deep-redacts nested objects and arrays', () => {
    const out = redactForLog({
      to: '+14155551234',
      participants: [{ email: 'a@b.com' }, { email: 'c@d.com' }],
    })
    expect(out).toEqual({
      to: '[PHONE_REDACTED]',
      participants: [{ email: '[EMAIL_REDACTED]' }, { email: '[EMAIL_REDACTED]' }],
    })
  })

  it('fails closed instead of passing deeply nested objects through unredacted', () => {
    let nested: Record<string, unknown> = { email: 'deep@example.com' }
    for (let i = 0; i < 10; i++) nested = { child: nested }
    const out = redactForLog(nested) as Record<string, unknown>
    // Walk down until we hit the depth cutoff — it must never be the raw email.
    let cursor: unknown = out
    for (let i = 0; i < 10; i++) {
      if (typeof cursor === 'string') break
      cursor = (cursor as Record<string, unknown>).child
    }
    expect(JSON.stringify(out)).not.toContain('deep@example.com')
  })

  it('redacts Error name/message/stack without dropping the stack entirely', () => {
    const err = new Error('failed for user jane@example.com')
    const out = redactForLog(err) as { name: string; message: string; stack?: string }
    expect(out.name).toBe('Error')
    expect(out.message).toBe('failed for user [EMAIL_REDACTED]')
    expect(out.stack).toBeDefined()
  })

  it('passes through non-PII primitives unchanged', () => {
    expect(redactForLog(42)).toBe(42)
    expect(redactForLog(true)).toBe(true)
    expect(redactForLog(null)).toBe(null)
    expect(redactForLog(undefined)).toBe(undefined)
  })
})
