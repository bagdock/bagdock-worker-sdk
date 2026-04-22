/**
 * Webhook verification primitives.
 *
 * Cryptographic building blocks for webhook signature verification —
 * vendor-agnostic, constant-time, with timestamp-skew handling.
 *
 * Most adapters should use their vendor's own SDK for verification
 * (e.g. `telnyx.webhooks.constructEvent()`, `@shopify/shopify-api`,
 * `stripe.webhooks.constructEvent()`). The primitives here are the
 * escape hatch for vendors that don't publish a Workers-compatible SDK.
 */

import type {
  HmacSha256VerifyOptions,
  Ed25519VerifyOptions,
} from './types'

const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// Primitive: HMAC-SHA256
// ---------------------------------------------------------------------------

/**
 * Verify an HMAC-SHA256 signature with constant-time comparison
 * and optional timestamp tolerance.
 *
 * **Return semantics:** Never throws. `signature` is `null` → 401 Response.
 * Invalid/expired timestamp → 401. Signature mismatch (constant-time) → 401.
 * All checks pass → `true`. Callers can safely pass `headers.get(...)`
 * (returns `string | null`) without pre-checking.
 *
 * Usage (adapter-local verifier wrapping the primitive):
 * ```ts
 * import { hmacSha256Verify } from '@bagdock/worker-sdk'
 * import type { VerifyFunction } from '@bagdock/worker-sdk'
 *
 * export const myVendorVerify: VerifyFunction = (req, env, body) =>
 *   hmacSha256Verify({
 *     signature: req.headers.get('x-vendor-sig'),
 *     secret: env.VENDOR_SECRET,
 *     signingString: body,
 *   })
 * ```
 */
export async function hmacSha256Verify(
  opts: HmacSha256VerifyOptions,
): Promise<true | Response> {
  const { signature, secret, signingString, toleranceMs, timestamp } = opts

  if (!signature) {
    return Response.json(
      { error: 'Missing webhook signature' },
      { status: 401 },
    )
  }

  if (timestamp !== undefined) {
    const tolerance = toleranceMs ?? DEFAULT_TOLERANCE_MS
    const ts =
      typeof timestamp === 'string' ? parseInt(timestamp, 10) : null
    if (ts === null || isNaN(ts)) {
      return Response.json(
        { error: 'Invalid webhook timestamp' },
        { status: 401 },
      )
    }
    const now = Math.floor(Date.now() / 1000)
    if (Math.abs(now - ts) * 1000 > tolerance) {
      return Response.json(
        { error: 'Webhook timestamp expired' },
        { status: 401 },
      )
    }
  }

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const expected = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(signingString),
  )

  const sigBytes = hexToArrayBuffer(signature)
  const expectedBytes = new Uint8Array(expected)
  const actualBytes = new Uint8Array(sigBytes)

  if (expectedBytes.length !== actualBytes.length) {
    return Response.json(
      { error: 'Invalid webhook signature' },
      { status: 401 },
    )
  }

  let mismatch = 0
  for (let i = 0; i < expectedBytes.length; i++) {
    mismatch |= expectedBytes[i] ^ actualBytes[i]
  }

  if (mismatch !== 0) {
    return Response.json(
      { error: 'Invalid webhook signature' },
      { status: 401 },
    )
  }

  return true
}

// ---------------------------------------------------------------------------
// Primitive: Ed25519
// ---------------------------------------------------------------------------

/**
 * Verify an Ed25519 signature with optional timestamp tolerance.
 *
 * **Return semantics:** Never throws. `signature` is `null` → 401 Response.
 * Invalid/expired timestamp → 401. Signature invalid or crypto failure →
 * 401 (logged to console). All checks pass → `true`.
 *
 * Usage (adapter-local verifier wrapping the primitive):
 * ```ts
 * import { ed25519Verify } from '@bagdock/worker-sdk'
 * import type { VerifyFunction } from '@bagdock/worker-sdk'
 *
 * export const myVendorVerify: VerifyFunction = (req, env, body) =>
 *   ed25519Verify({
 *     signature: req.headers.get('x-sig-ed25519'),
 *     publicKey: env.VENDOR_PUBLIC_KEY,
 *     signingString: `${req.headers.get('x-timestamp')}|${body}`,
 *   })
 * ```
 */
export async function ed25519Verify(
  opts: Ed25519VerifyOptions,
): Promise<true | Response> {
  const { signature, publicKey, signingString, toleranceMs, timestamp } = opts

  if (!signature) {
    return Response.json(
      { error: 'Missing webhook signature' },
      { status: 401 },
    )
  }

  if (timestamp !== undefined && timestamp !== null) {
    const tolerance = toleranceMs ?? DEFAULT_TOLERANCE_MS
    const ts = parseInt(timestamp, 10)
    if (isNaN(ts)) {
      return Response.json(
        { error: 'Invalid webhook timestamp' },
        { status: 401 },
      )
    }
    const now = Math.floor(Date.now() / 1000)
    if (Math.abs(now - ts) * 1000 > tolerance) {
      return Response.json(
        { error: 'Webhook timestamp expired' },
        { status: 401 },
      )
    }
  }

  try {
    const pubKeyBytes = base64ToArrayBuffer(publicKey)
    const sigBytes = base64ToArrayBuffer(signature)

    const algorithm = { name: 'Ed25519', namedCurve: 'Ed25519' }
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      pubKeyBytes,
      algorithm as any,
      false,
      ['verify'],
    )

    const valid = await crypto.subtle.verify(
      'Ed25519',
      cryptoKey,
      sigBytes,
      new TextEncoder().encode(signingString),
    )

    if (!valid) {
      return Response.json(
        { error: 'Invalid webhook signature' },
        { status: 401 },
      )
    }

    return true
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown'
    console.error('[ed25519Verify] Verification error:', message)
    return Response.json(
      { error: 'Webhook signature verification failed' },
      { status: 401 },
    )
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

function hexToArrayBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes.buffer
}
