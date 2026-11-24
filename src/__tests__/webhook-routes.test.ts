/**
 * Vendor webhook routes run their verifier before the dispatch headers are
 * read (BDOK-568). A direct vendor delivery carries no `x-bagdock-*` headers,
 * so the verifier has to be the first gate.
 */

import { describe, it, expect, vi } from 'vitest'
import { createBagdockWorker } from '../create-worker'
import { ACCOUNT_LEVEL_ID } from '../context'
import type { BaseEnv, HandlerContext } from '../types'

const URL_ = 'https://stripe-default.example/webhooks/platform'

function worker(verify: (req: Request, env: BaseEnv, raw: string) => Promise<true | Response>) {
  const seen: Array<Pick<HandlerContext, 'operatorId' | 'installationId' | 'environment'> & { body: string }> = []
  const w = createBagdockWorker<BaseEnv>({
    routes: {
      'webhooks/platform': {
        verify,
        handler: async (ctx) => {
          seen.push({
            operatorId: ctx.operatorId,
            installationId: ctx.installationId,
            environment: ctx.environment,
            body: await ctx.request.text(),
          })
          return Response.json({ received: true })
        },
      },
    },
  })
  return { w, seen }
}

const call = (w: ExportedHandler<BaseEnv>, headers: Record<string, string> = {}) =>
  w.fetch!(
    new Request(URL_, { method: 'POST', headers, body: '{"id":"evt_1"}' }) as any,
    {} as any,
    {} as any,
  ) as Promise<Response>

describe('verified webhook routes', () => {
  it('reaches the verifier and the handler with no dispatch headers', async () => {
    const verify = vi.fn(async () => true as const)
    const { w, seen } = worker(verify)
    const res = await call(w)
    expect(res.status).toBe(200)
    expect(verify).toHaveBeenCalledOnce()
    expect(seen[0]).toEqual({
      operatorId: ACCOUNT_LEVEL_ID,
      installationId: ACCOUNT_LEVEL_ID,
      environment: 'live',
      body: '{"id":"evt_1"}',
    })
  })

  it('answers the verifier failure, not 400, when the signature is bad', async () => {
    const { w, seen } = worker(async () => Response.json({ error: 'bad' }, { status: 401 }))
    const res = await call(w)
    expect(res.status).toBe(401)
    expect(seen).toHaveLength(0)
  })

  it('keeps the dispatch context when the headers are present', async () => {
    const { w, seen } = worker(async () => true)
    await call(w, {
      'x-bagdock-operator-id': 'op_1',
      'x-bagdock-installation-id': 'ainst_1',
      'x-bagdock-environment': 'test',
    })
    expect(seen[0]).toMatchObject({ operatorId: 'op_1', installationId: 'ainst_1', environment: 'test' })
  })
})
