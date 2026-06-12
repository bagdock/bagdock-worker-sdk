/**
 * createPaymentsWorker — Capabilities-driven payments contract factory.
 *
 * Extends createBagdockWorker with typed route enforcement per declared
 * capabilities. Auto-appends capabilities to the __platform/setup response.
 *
 * Thin generalization only (RFC 0004 decision 5): the route taxonomy in
 * PaymentsRouteMap is the PSP contract that must stay stable for sibling
 * PSP workers (Mangopay/Ryft/Adyen). Cross-PSP normalization is deliberately
 * absent until a second PSP forces real requirements.
 */

import type {
  BaseEnv,
  PaymentsCapability,
  PaymentsWorkerConfig,
  HandlerContext,
  RouteEntry,
} from './types'
import { createContext } from './context'
import { handleSetup, handleTeardown, handleHealth, parseJsonBody } from './create-worker'

/**
 * E first so callers can specify only the env type:
 *   createPaymentsWorker<Env>({ capabilities: ['charges', 'webhooks'], ... })
 * C is inferred from the capabilities literal via const type parameter.
 */
export function createPaymentsWorker<
  E extends BaseEnv,
  const C extends readonly PaymentsCapability[] = readonly PaymentsCapability[],
>(config: PaymentsWorkerConfig<E, C>): ExportedHandler<E> {
  const allRoutes = config.routes as Record<string, RouteEntry<E>>

  return {
    async fetch(request: Request, env: E): Promise<Response> {
      const startMs = Date.now()
      const url = new URL(request.url)
      const path = url.pathname.replace(/^\/+/, '')

      try {
        if (path === '__platform/setup' && request.method === 'POST') {
          const body = await parseJsonBody<{
            operator_id: string
            installation_id: string
            environment: string
          }>(request)
          if (body instanceof Response) return body
          const ctx = createContext(request, env, {
            operatorId: body.operator_id,
            installationId: body.installation_id,
            environment: body.environment as 'live' | 'test',
          })
          if (!ctx)
            return Response.json({ error: 'Missing context' }, { status: 400 })
          return await handleSetup(ctx, config.onInstall, {
            capabilities: config.capabilities,
          })
        }

        if (path === '__platform/teardown' && request.method === 'POST') {
          const body = await parseJsonBody<{
            operator_id: string
            installation_id: string
          }>(request)
          if (body instanceof Response) return body
          const ctx = createContext(request, env, {
            operatorId: body.operator_id,
            installationId: body.installation_id,
            environment: 'live',
          })
          if (!ctx)
            return Response.json({ error: 'Missing context' }, { status: 400 })
          return await handleTeardown(ctx, config.onUninstall)
        }

        if (path === 'health' && request.method === 'GET') {
          const ctx = createContext(request, env)
          return await handleHealth(
            {
              version: config.version,
              healthCheck: config.healthCheck,
              routes: allRoutes,
            },
            env,
            ctx,
          )
        }

        const route = allRoutes[path]
        if (!route) {
          return Response.json(
            { error: 'Not found', path },
            { status: 404 },
          )
        }

        const ctx = createContext(request, env)
        if (!ctx) {
          return Response.json(
            { error: 'Missing dispatch headers' },
            { status: 400 },
          )
        }

        if (typeof route === 'object' && 'handler' in route && 'verify' in route) {
          const clone = request.clone()
          const rawBody = await request.text()

          const result = await route.verify(clone, env, rawBody)
          if (result !== true) return result

          const verifiedCtx: HandlerContext<E> = { ...ctx, request: clone }
          return await route.handler(verifiedCtx)
        }

        return await (route as (ctx: HandlerContext<E>) => Promise<Response>)(ctx)
      } catch (err: unknown) {
        // Full error stays in logs only — PSP errors can carry internal
        // detail (account ids, endpoints) that must not reach callers.
        console.error(`[worker-sdk/payments] ${path} error:`, err)
        return Response.json(
          { error: 'Internal error', path },
          {
            status: 500,
            headers: { 'X-Response-Time-Ms': String(Date.now() - startMs) },
          },
        )
      }
    },
  }
}
