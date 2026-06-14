/**
 * Tests for `ctx.inputs` resolution (BDOK-561).
 *
 * The platform resolves + unseals install inputs server-side and delivers the
 * merged plaintext map to the worker — via the `x-bagdock-install-inputs`
 * header on dispatch routes, or via `createContext` overrides (from the body)
 * on `__platform/setup`. The SDK only decodes; it performs no crypto.
 */

import { describe, it, expect } from 'vitest'
import { createContext } from '../context'
import type { BaseEnv } from '../types'

const env = {} as BaseEnv

function encode(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
}

function dispatchRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://worker.example/sms/send', {
    headers: {
      'x-bagdock-operator-id': 'op_1',
      'x-bagdock-installation-id': 'ainst_1',
      'x-bagdock-environment': 'test',
      ...headers,
    },
  })
}

describe('ctx.inputs (dispatch header)', () => {
  it('decodes the base64 JSON install-inputs header into ctx.inputs', () => {
    const req = dispatchRequest({
      'x-bagdock-install-inputs': encode({ telnyx_api_key: 'KEY_live_123', region: 'eu' }),
    })
    const ctx = createContext(req, env)
    expect(ctx).not.toBeNull()
    expect(ctx!.inputs).toEqual({ telnyx_api_key: 'KEY_live_123', region: 'eu' })
  })

  it('defaults to {} when the header is absent', () => {
    const ctx = createContext(dispatchRequest(), env)
    expect(ctx!.inputs).toEqual({})
  })

  it('degrades to {} on a malformed header (never throws)', () => {
    const ctx = createContext(
      dispatchRequest({ 'x-bagdock-install-inputs': 'not-valid-base64-json!!' }),
      env,
    )
    expect(ctx!.inputs).toEqual({})
  })

  it('drops non-string values rather than passing them through', () => {
    const req = dispatchRequest({
      'x-bagdock-install-inputs': encode({ ok: 'yes', n: 5, nested: { a: 1 } }),
    })
    const ctx = createContext(req, env)
    expect(ctx!.inputs).toEqual({ ok: 'yes' })
  })

  it('ignores an array payload', () => {
    const req = dispatchRequest({ 'x-bagdock-install-inputs': encode(['a', 'b']) })
    const ctx = createContext(req, env)
    expect(ctx!.inputs).toEqual({})
  })
})

describe('ctx.inputs (setup override)', () => {
  it('uses the overrides.inputs (body-sourced) and ignores the header', () => {
    // Setup path: no dispatch headers, identity + inputs come from overrides.
    const req = new Request('https://worker.example/__platform/setup', {
      method: 'POST',
      headers: { 'x-bagdock-install-inputs': encode({ from_header: 'x' }) },
    })
    const ctx = createContext(req, env, {
      operatorId: 'op_1',
      installationId: 'ainst_1',
      environment: 'test',
      inputs: { telnyx_api_key: 'KEY_from_body' },
    })
    expect(ctx).not.toBeNull()
    expect(ctx!.inputs).toEqual({ telnyx_api_key: 'KEY_from_body' })
  })
})
