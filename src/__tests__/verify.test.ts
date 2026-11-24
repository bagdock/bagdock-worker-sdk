/**
 * Tests for the webhook verification primitives.
 *
 * BDOK-1228 pinned accept-on-null: a request without the timestamp header
 * skipped the tolerance check. That made the replay window opt-out by the
 * sender, who only had to drop the header (BDOK-1649). Both primitives now
 * fail closed on a missing timestamp; `requireTimestamp: false` is the
 * explicit opt-out for a vendor that signs without one.
 */

import { describe, it, expect } from 'vitest'
import { ed25519Verify, hmacSha256Verify } from '../verify'

async function hmacHex(secret: string, signingString: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(signingString))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000))
}

function staleSeconds(): string {
  return String(Math.floor(Date.now() / 1000) - 3600)
}

function toBase64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
}

describe('hmacSha256Verify', () => {
  const secret = 'test-secret'
  const signingString = 'body-to-sign'

  it('rejects a missing signature', async () => {
    const result = await hmacSha256Verify({ signature: null, secret, signingString })
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(401)
  })

  it.each([undefined, null, ''])(
    'rejects a valid signature when timestamp is %j (missing header)',
    async (timestamp) => {
      const signature = await hmacHex(secret, signingString)
      const result = await hmacSha256Verify({ signature, secret, signingString, timestamp })
      expect(result).toBeInstanceOf(Response)
      expect((result as Response).status).toBe(401)
      expect(await (result as Response).json()).toEqual({ error: 'Missing webhook timestamp' })
    },
  )

  it('accepts a valid signature with a current timestamp', async () => {
    const signature = await hmacHex(secret, signingString)
    const result = await hmacSha256Verify({ signature, secret, signingString, timestamp: nowSeconds() })
    expect(result).toBe(true)
  })

  it.each([undefined, null])(
    'accepts a missing timestamp (%s) only with requireTimestamp: false',
    async (timestamp) => {
      const signature = await hmacHex(secret, signingString)
      const result = await hmacSha256Verify({
        signature,
        secret,
        signingString,
        timestamp,
        requireTimestamp: false,
      })
      expect(result).toBe(true)
    },
  )

  it('still checks a present timestamp when requireTimestamp is false', async () => {
    const signature = await hmacHex(secret, signingString)
    const result = await hmacSha256Verify({
      signature,
      secret,
      signingString,
      timestamp: staleSeconds(),
      requireTimestamp: false,
    })
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(401)
  })

  it('rejects a timestamp that is not all digits', async () => {
    const signature = await hmacHex(secret, signingString)
    const result = await hmacSha256Verify({
      signature,
      secret,
      signingString,
      timestamp: `${nowSeconds()}abc`,
    })
    expect(result).toBeInstanceOf(Response)
    expect(await (result as Response).json()).toEqual({ error: 'Invalid webhook timestamp' })
  })

  it('rejects an invalid signature', async () => {
    const result = await hmacSha256Verify({
      signature: '00'.repeat(32),
      secret,
      signingString,
      timestamp: nowSeconds(),
    })
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(401)
  })

  it('rejects an expired timestamp', async () => {
    const signature = await hmacHex(secret, signingString)
    const result = await hmacSha256Verify({
      signature,
      secret,
      signingString,
      timestamp: staleSeconds(),
    })
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(401)
  })
})

describe('ed25519Verify', () => {
  async function signer() {
    const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    const publicKey = toBase64(
      (await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer,
    )
    const sign = async (message: string) =>
      toBase64(
        await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(message)),
      )
    return { publicKey, sign }
  }

  it('accepts a valid signature with a current timestamp', async () => {
    const { publicKey, sign } = await signer()
    const timestamp = nowSeconds()
    const signingString = `${timestamp}|body`
    const result = await ed25519Verify({
      signature: await sign(signingString),
      publicKey,
      signingString,
      timestamp,
    })
    expect(result).toBe(true)
  })

  it.each([undefined, null, ''])(
    'rejects a valid signature when timestamp is %j (missing header)',
    async (timestamp) => {
      const { publicKey, sign } = await signer()
      // The Telnyx SMS lane signs `${headers.get('telnyx-timestamp')}|${body}`,
      // so a dropped header still yields a signature over "null|body".
      const signingString = `${timestamp}|body`
      const result = await ed25519Verify({
        signature: await sign(signingString),
        publicKey,
        signingString,
        timestamp,
      })
      expect(result).toBeInstanceOf(Response)
      expect((result as Response).status).toBe(401)
      expect(await (result as Response).json()).toEqual({ error: 'Missing webhook timestamp' })
    },
  )

  it('accepts a missing timestamp only with requireTimestamp: false', async () => {
    const { publicKey, sign } = await signer()
    const result = await ed25519Verify({
      signature: await sign('body'),
      publicKey,
      signingString: 'body',
      timestamp: null,
      requireTimestamp: false,
    })
    expect(result).toBe(true)
  })

  it('rejects an expired timestamp', async () => {
    const { publicKey, sign } = await signer()
    const timestamp = staleSeconds()
    const signingString = `${timestamp}|body`
    const result = await ed25519Verify({
      signature: await sign(signingString),
      publicKey,
      signingString,
      timestamp,
    })
    expect(result).toBeInstanceOf(Response)
    expect(await (result as Response).json()).toEqual({ error: 'Webhook timestamp expired' })
  })

  it('rejects a missing signature', async () => {
    const { publicKey } = await signer()
    const result = await ed25519Verify({
      signature: null,
      publicKey,
      signingString: 'body',
      timestamp: nowSeconds(),
    })
    expect((result as Response).status).toBe(401)
  })
})
