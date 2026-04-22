/**
 * createCommsWorker — Capabilities-driven comms contract factory.
 *
 * Extends createBagdockWorker with typed route enforcement per declared
 * capabilities. Auto-appends capabilities to the __platform/setup response.
 */

import type {
  BaseEnv,
  CommsCapability,
  CommsWorkerConfig,
  HandlerContext,
  RouteEntry,
} from './types'
import { createContext } from './context'
import { handleSetup, handleTeardown, handleHealth } from './create-worker'

/**
 * E first so callers can specify only the env type:
 *   createCommsWorker<Env>({ capabilities: ['sms', 'numbers'], ... })
 * C is inferred from the capabilities literal via const type parameter.
 */
export function createCommsWorker<
  E extends BaseEnv,
  const C extends readonly CommsCapability[] = readonly CommsCapability[],
>(config: CommsWorkerConfig<E, C>): ExportedHandler<E> {
  const allRoutes = config.routes as Record<string, RouteEntry<E>>

  return {
    async fetch(request: Request, env: E): Promise<Response> {
      const startMs = Date.now()
      const url = new URL(request.url)
      const path = url.pathname.replace(/^\/+/, '')

      try {
        if (path === '__platform/setup' && request.method === 'POST') {
          const body = (await request.json()) as {
            operator_id: string
            installation_id: string
            environment: string
          }
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
          const body = (await request.json()) as {
            operator_id: string
            installation_id: string
          }
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
        const message = err instanceof Error ? err.message : 'Internal error'
        console.error(`[worker-sdk/comms] ${path} error:`, err)
        return Response.json(
          { error: message, path },
          {
            status: 500,
            headers: { 'X-Response-Time-Ms': String(Date.now() - startMs) },
          },
        )
      }
    },
  }
}
