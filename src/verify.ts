/**
 * Webhook verification primitives.
 *
 * Cryptographic building blocks for webhook signature verification —
 * vendor-agnostic, constant-time, with a fail-closed timestamp window.
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
 * and a timestamp tolerance window.
 *
 * **Return semantics:** Never throws. `signature` is `null` → 401 Response.
 * Missing, invalid or expired timestamp → 401 (pass `requireTimestamp: false`
 * only for a vendor that signs without one). Signature mismatch
 * (constant-time) → 401.
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
 *     signingString: `${req.headers.get('x-vendor-timestamp')}.${body}`,
 *     timestamp: req.headers.get('x-vendor-timestamp'),
 *   })
 * ```
 */
export async function hmacSha256Verify(
  opts: HmacSha256VerifyOptions,
): Promise<true | Response> {
  const { signature, secret, signingString } = opts

  if (!signature) {
    return Response.json(
      { error: 'Missing webhook signature' },
      { status: 401 },
    )
  }

  const timestampFailure = checkTimestamp(opts)
  if (timestampFailure) return timestampFailure

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
 * Verify an Ed25519 signature with a timestamp tolerance window.
 *
 * **Return semantics:** Never throws. `signature` is `null` → 401 Response.
 * Missing, invalid or expired timestamp → 401 (pass `requireTimestamp: false`
 * only for a vendor that signs without one). Signature invalid or crypto failure →
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
 *     timestamp: req.headers.get('x-timestamp'),
 *   })
 * ```
 */
export async function ed25519Verify(
  opts: Ed25519VerifyOptions,
): Promise<true | Response> {
  const { signature, publicKey, signingString } = opts

  if (!signature) {
    return Response.json(
      { error: 'Missing webhook signature' },
      { status: 401 },
    )
  }

  const timestampFailure = checkTimestamp(opts)
  if (timestampFailure) return timestampFailure

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

/**
 * Replay-window check shared by both primitives. Fails closed: a missing
 * (`undefined`, `null` or empty) timestamp is a 401 unless the caller set
 * `requireTimestamp: false` for a vendor that signs without one. A timestamp
 * that is present is always checked, whatever `requireTimestamp` says.
 * Returns the 401 Response on failure, `null` when the request may proceed.
 */
function checkTimestamp(
  opts: Pick<HmacSha256VerifyOptions, 'timestamp' | 'toleranceMs' | 'requireTimestamp'>,
): Response | null {
  const { timestamp, toleranceMs, requireTimestamp } = opts

  if (timestamp === undefined || timestamp === null || timestamp === '') {
    if (requireTimestamp === false) return null
    return Response.json(
      { error: 'Missing webhook timestamp' },
      { status: 401 },
    )
  }

  if (!/^\d+$/.test(timestamp)) {
    return Response.json(
      { error: 'Invalid webhook timestamp' },
      { status: 401 },
    )
  }
  const ts = Number(timestamp)
  const tolerance = toleranceMs ?? DEFAULT_TOLERANCE_MS
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) * 1000 > tolerance) {
    return Response.json(
      { error: 'Webhook timestamp expired' },
      { status: 401 },
    )
  }
  return null
}

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
