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
  RouteEntry,
} from './types'
import { createContext } from './context'
import { dispatchRoute, handleSetup, handleTeardown, handleHealth, readLifecycleBody } from './create-worker'

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
          const body = await readLifecycleBody<{
            operator_id: string
            installation_id: string
            environment: string
            input_values?: Record<string, string>
          }>(request, env, '__platform/setup')
          if (body instanceof Response) return body
          const ctx = createContext(request, env, {
            operatorId: body.operator_id,
            installationId: body.installation_id,
            environment: body.environment as 'live' | 'test',
            // Setup has no dispatch header; install inputs (if any) arrive in the
            // body (BDOK-560 sends `input_values`). Exposed on `ctx.inputs`.
            inputs: body.input_values ?? {},
          })
          if (!ctx)
            return Response.json({ error: 'Missing context' }, { status: 400 })
          return await handleSetup(ctx, config.onInstall, {
            capabilities: config.capabilities,
          })
        }

        if (path === '__platform/teardown' && request.method === 'POST') {
          const body = await readLifecycleBody<{
            operator_id: string
            installation_id: string
          }>(request, env, '__platform/teardown')
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

        return await dispatchRoute(route, request, env, path)
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
