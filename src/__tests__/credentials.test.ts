/**
 * Tests for the platform credential surface (BDOK-557).
 *
 * The public SDK performs NO crypto — it only lets an adapter declare a
 * credential for the platform to seal server-side. These tests pin that contract
 * and the runtime guard that backs scope-4 enforcement.
 */

import { describe, it, expect } from 'vitest'
import {
  createCredentialsProvider,
  isPreparedCredential,
} from '../credentials'

describe('ctx.credentials.store', () => {
  const credentials = createCredentialsProvider()

  it('returns a PreparedCredential carrying the raw payload + field (no crypto)', () => {
    const payload = { sandbox_id: 'sbx_1', secret_key: 'sk_test_123' }
    const prepared = credentials.store(payload, { field: 'stripe_sandbox_key' })

    expect(prepared.__sealOnIngest).toBe(true)
    expect(prepared.payload).toEqual(payload)
    expect(prepared.field).toBe('stripe_sandbox_key')
  })

  it('does not transform or seal the payload — the platform does that', () => {
    const payload = { secret_key: 'sk_test_plaintext' }
    const prepared = credentials.store(payload, { field: 'k' })
    // The raw secret is still present (sealing happens server-side on ingest).
    expect(prepared.payload).toBe(payload)
  })
})

describe('isPreparedCredential', () => {
  it('accepts a value produced by store()', () => {
    const prepared = createCredentialsProvider().store({ a: 1 }, { field: 'f' })
    expect(isPreparedCredential(prepared)).toBe(true)
  })

  it('rejects a bare secret string or object (the scope-4 backstop)', () => {
    expect(isPreparedCredential('sk_live_raw_secret')).toBe(false)
    expect(isPreparedCredential({ secret_key: 'sk_live_raw' })).toBe(false)
    expect(isPreparedCredential(null)).toBe(false)
    expect(isPreparedCredential(undefined)).toBe(false)
    expect(isPreparedCredential({ __sealOnIngest: false })).toBe(false)
  })
})
