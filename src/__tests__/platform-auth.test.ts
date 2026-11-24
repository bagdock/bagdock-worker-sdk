/**
 * Platform lifecycle caller-authentication contract (BDOK-1277).
 *
 * The signer lives in a different package
 * (`apps/operator-api-hono/src/services/adapter-platform-dispatch.ts`), so the
 * two sides can only be kept honest by pinning the wire format. FIXTURE is that
 * pin: the operator API's own test asserts the identical secret, timestamp, url,
 * body and expected signature. If either side changes the canonical string, one
 * of the two suites fails.
 */

import { describe, it, expect } from 'vitest'
import {
  computePlatformSignature,
  verifyPlatformRequest,
  MAX_CLOCK_SKEW_SECONDS,
  PLATFORM_AUTH_HEADERS,
} from '../platform-auth'

/** Shared with the operator-api-hono adapter-platform-dispatch test. */
export const FIXTURE = {
  // The key a worker actually holds: the platform derives it per host and
  // installs it as BAGDOCK_PLATFORM_SECRET at deploy. Verification does not know
  // or care that it is derived, so this side simply treats it as the secret.
  secret: 'd1f61c56c8dee61c35e2bdd17cec9458cca2fc2450b7adfe9e852ad8cfc2866b', // gitleaks:allow (HMAC test fixture, not a real secret)
  timestamp: 1758500000,
  url: 'https://fixture.bdok.dev/__platform/setup',
  body: JSON.stringify({
    operator_id: 'opreg_fixture',
    installation_id: 'ainst_fixture',
    environment: 'test',
  }),
  /**
   * HMAC-SHA256 of `${timestamp}.POST.${origin}${pathname}.${body}` under
   * `secret`, for the setup URL above, hex-encoded. Generated with Node's
   * `crypto.createHmac`, independently of this package's WebCrypto
   * implementation, so the assertion below is a real cross-check of the
   * canonical string rather than the code agreeing with itself.
   */
  signature: 'ef9985857a17a4170deaf65654620a5294634d3ead8175bb49a51deb787c4a9f',
  /**
   * The same secret/timestamp/body, signed for `__platform/teardown` instead
   * of `__platform/setup`. Pins that the route is part of the signed string,
   * not just the body.
   */
  teardownSignature: 'bb77993bcecb7a589244f2cc1406a4975af91144607808c388ca655a9e177d0f',
} as const

const TEARDOWN_URL = 'https://fixture.bdok.dev/__platform/teardown'

/** `computePlatformSignature` with FIXTURE defaults, overridable per test. */
function sign(o: {
  secret?: string
  timestamp?: string | number
  method?: string
  url?: string
  body?: string
} = {}): Promise<string> {
  return computePlatformSignature(
    o.secret ?? FIXTURE.secret,
    o.timestamp ?? FIXTURE.timestamp,
    o.method ?? 'POST',
    o.url ?? FIXTURE.url,
    o.body ?? FIXTURE.body,
  )
}

function signedRequest(
  timestamp: string | number,
  signature: string,
  body: string = FIXTURE.body,
  url: string = FIXTURE.url,
): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [PLATFORM_AUTH_HEADERS.timestamp]: String(timestamp),
      [PLATFORM_AUTH_HEADERS.signature]: signature,
    },
    body,
  })
}

describe('computePlatformSignature', () => {
  it('signs the timestamp, method, url and body as `${timestamp}.${method}.${origin}${pathname}.${body}`', async () => {
    const sig = await sign()
    // 32-byte HMAC, hex-encoded.
    expect(sig).toMatch(/^[0-9a-f]{64}$/)

    // Against the independently-generated vector: this is what pins the wire
    // format across the two packages.
    expect(sig).toBe(FIXTURE.signature)

    // The signed string is the contract. Recomputing it here by hand is the
    // check that the implementation has not started signing something else
    // (body only, a different separator, headers folded in).
    const u = new URL(FIXTURE.url)
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(FIXTURE.secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const expected = Array.from(
      new Uint8Array(
        await crypto.subtle.sign(
          'HMAC',
          key,
          encoder.encode(
            `${FIXTURE.timestamp}.POST.${u.origin}${u.pathname}.${FIXTURE.body}`,
          ),
        ),
      ),
    )
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    expect(sig).toBe(expected)
  })

  it('pins the teardown vector too, so both routes are cross-checked', async () => {
    const sig = await sign({ url: TEARDOWN_URL })
    expect(sig).toBe(FIXTURE.teardownSignature)
  })

  it('changes when the body changes', async () => {
    const a = await sign()
    const b = await sign({
      body: JSON.stringify({ ...JSON.parse(FIXTURE.body), installation_id: 'ainst_other' }),
    })
    expect(a).not.toBe(b)
  })

  it('changes when the timestamp changes, so a replay cannot be re-stamped', async () => {
    const a = await sign()
    const b = await sign({ timestamp: FIXTURE.timestamp + 1 })
    expect(a).not.toBe(b)
  })
})

describe('verifyPlatformRequest', () => {
  it('accepts a correctly signed request', async () => {
    const sig = await sign()
    const res = await verifyPlatformRequest(
      signedRequest(FIXTURE.timestamp, `sha256=${sig}`),
      FIXTURE.secret,
      FIXTURE.body,
      FIXTURE.timestamp,
    )
    expect(res).toEqual({ ok: true, reason: 'verified' })
  })

  it('fails as `unconfigured` when the worker holds no secret (BDOK-1701)', async () => {
    // A worker that cannot check the signature refuses the call, even one that
    // carries a valid signature it has no key to verify.
    for (const secret of [undefined, null, '']) {
      const res = await verifyPlatformRequest(
        signedRequest(FIXTURE.timestamp, `sha256=${FIXTURE.signature}`),
        secret,
        FIXTURE.body,
        FIXTURE.timestamp,
      )
      expect(res).toEqual({ ok: false, reason: 'unconfigured' })
    }
  })

  it('rejects an unsigned request once a secret is configured', async () => {
    const req = new Request(FIXTURE.url, {
      method: 'POST',
      body: FIXTURE.body,
    })
    const res = await verifyPlatformRequest(req, FIXTURE.secret, FIXTURE.body, FIXTURE.timestamp)
    expect(res).toEqual({ ok: false, reason: 'missing_signature' })
  })

  it('rejects a signature over a different body', async () => {
    const sig = await sign()
    const tampered = JSON.stringify({
      ...JSON.parse(FIXTURE.body),
      installation_id: 'ainst_someone_elses',
    })
    const res = await verifyPlatformRequest(
      signedRequest(FIXTURE.timestamp, `sha256=${sig}`, tampered),
      FIXTURE.secret,
      tampered,
      FIXTURE.timestamp,
    )
    expect(res).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects a signature made with the wrong secret', async () => {
    const sig = await sign({ secret: 'wrong_secret' })
    const res = await verifyPlatformRequest(
      signedRequest(FIXTURE.timestamp, `sha256=${sig}`),
      FIXTURE.secret,
      FIXTURE.body,
      FIXTURE.timestamp,
    )
    expect(res).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects a timestamp outside the skew window in both directions', async () => {
    const sig = await sign()
    const req = () => signedRequest(FIXTURE.timestamp, `sha256=${sig}`)

    const tooOld = await verifyPlatformRequest(
      req(),
      FIXTURE.secret,
      FIXTURE.body,
      FIXTURE.timestamp + MAX_CLOCK_SKEW_SECONDS + 1,
    )
    expect(tooOld).toEqual({ ok: false, reason: 'stale_timestamp' })

    const tooNew = await verifyPlatformRequest(
      req(),
      FIXTURE.secret,
      FIXTURE.body,
      FIXTURE.timestamp - MAX_CLOCK_SKEW_SECONDS - 1,
    )
    expect(tooNew).toEqual({ ok: false, reason: 'stale_timestamp' })
  })

  it('accepts a timestamp exactly at the skew boundary', async () => {
    const sig = await sign()
    const res = await verifyPlatformRequest(
      signedRequest(FIXTURE.timestamp, `sha256=${sig}`),
      FIXTURE.secret,
      FIXTURE.body,
      FIXTURE.timestamp + MAX_CLOCK_SKEW_SECONDS,
    )
    expect(res).toEqual({ ok: true, reason: 'verified' })
  })

  it('rejects a malformed signature header', async () => {
    const sig = await sign()
    for (const header of [sig, `sha1=${sig}`, 'sha256=', '=abc']) {
      const res = await verifyPlatformRequest(
        signedRequest(FIXTURE.timestamp, header),
        FIXTURE.secret,
        FIXTURE.body,
        FIXTURE.timestamp,
      )
      expect(res.ok).toBe(false)
      expect(res).toMatchObject({ reason: 'malformed_signature' })
    }
  })

  it('rejects a non-numeric timestamp', async () => {
    const sig = await sign()
    const res = await verifyPlatformRequest(
      signedRequest('not-a-number', `sha256=${sig}`),
      FIXTURE.secret,
      FIXTURE.body,
      FIXTURE.timestamp,
    )
    expect(res).toEqual({ ok: false, reason: 'malformed_signature' })
  })

  it('accepts an uppercase hex signature', async () => {
    const sig = await sign()
    const res = await verifyPlatformRequest(
      signedRequest(FIXTURE.timestamp, `sha256=${sig.toUpperCase()}`),
      FIXTURE.secret,
      FIXTURE.body,
      FIXTURE.timestamp,
    )
    expect(res).toEqual({ ok: true, reason: 'verified' })
  })

  it('rejects a setup signature presented at the teardown route', async () => {
    // FIXTURE.signature was minted for __platform/setup. Presenting it at
    // __platform/teardown must not verify, or a captured setup call could be
    // replayed to trigger a teardown.
    const res = await verifyPlatformRequest(
      signedRequest(FIXTURE.timestamp, `sha256=${FIXTURE.signature}`, FIXTURE.body, TEARDOWN_URL),
      FIXTURE.secret,
      FIXTURE.body,
      FIXTURE.timestamp,
    )
    expect(res).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects a signature minted for one worker host at a different worker host', async () => {
    // The cross-adapter replay the change exists to prevent: an app author who
    // legitimately receives signed setup calls at their own worker must not be
    // able to replay a captured call against a different adapter's worker.
    const otherHostUrl = 'https://other-app.bdok.dev/__platform/setup'
    const res = await verifyPlatformRequest(
      signedRequest(FIXTURE.timestamp, `sha256=${FIXTURE.signature}`, FIXTURE.body, otherHostUrl),
      FIXTURE.secret,
      FIXTURE.body,
      FIXTURE.timestamp,
    )
    expect(res).toEqual({ ok: false, reason: 'bad_signature' })
  })
})
