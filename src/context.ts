/**
 * HandlerContext factory + KV-backed InstallStore.
 */

import type {
  BaseEnv,
  HandlerContext,
  InstallStore,
  Logger,
} from './types'
import { createCredentialsProvider } from './credentials'

const DISPATCH_HEADERS = {
  operatorId: 'x-bagdock-operator-id',
  installationId: 'x-bagdock-installation-id',
  environment: 'x-bagdock-environment',
  /** Resolved install inputs (base64 JSON), attached by the platform when the
   *  adapter declares `inputs`. See `ctx.inputs` (BDOK-561). */
  installInputs: 'x-bagdock-install-inputs',
} as const

/**
 * Decode the per-request install-inputs header into `ctx.inputs`. The platform
 * resolves + unseals server-side and sends a base64-encoded JSON object of
 * string values. Tolerant by design: absent or malformed → `{}` (never throws),
 * so a bad header degrades to "no inputs" rather than 500-ing the dispatch.
 */
function parseInstallInputsHeader(request: Request): Record<string, string> {
  const raw = request.headers.get(DISPATCH_HEADERS.installInputs)
  if (!raw) return {}
  try {
    const bytes = Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0))
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export function parseDispatchHeaders(request: Request): {
  operatorId: string
  installationId: string
  environment: 'live' | 'test'
} | null {
  const operatorId = request.headers.get(DISPATCH_HEADERS.operatorId)
  const installationId = request.headers.get(DISPATCH_HEADERS.installationId)
  const environment = request.headers.get(DISPATCH_HEADERS.environment) as
    | 'live'
    | 'test'
    | null

  if (!operatorId || !installationId || !environment) return null
  return { operatorId, installationId, environment }
}

export class KvInstallStore implements InstallStore {
  constructor(
    private readonly kv: KVNamespace,
    private readonly installationId: string,
  ) {}

  private key(k: string): string {
    return `install:${this.installationId}:${k}`
  }

  async get(key: string): Promise<string | null> {
    return this.kv.get(this.key(key))
  }

  async put(key: string, value: string): Promise<void> {
    await this.kv.put(this.key(key), value)
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(this.key(key))
  }
}

class NoOpInstallStore implements InstallStore {
  async get(): Promise<string | null> {
    return null
  }
  async put(): Promise<void> {}
  async delete(): Promise<void> {}
}

function createLogger(
  operatorId: string,
  installationId: string,
): Logger {
  const prefix = `[${operatorId}/${installationId}]`
  return {
    info: (msg, data) => console.log(prefix, msg, data ?? ''),
    warn: (msg, data) => console.warn(prefix, msg, data ?? ''),
    error: (msg, data) => console.error(prefix, msg, data ?? ''),
  }
}

export function createContext<E extends BaseEnv>(
  request: Request,
  env: E,
  overrides?: {
    operatorId?: string
    installationId?: string
    environment?: 'live' | 'test'
    /** Lifecycle routes supply inputs from the request body (the dispatch
     *  header is absent on `__platform/setup`); dispatch routes read the header. */
    inputs?: Record<string, string>
  },
): HandlerContext<E> | null {
  const headers = parseDispatchHeaders(request)
  const operatorId = overrides?.operatorId ?? headers?.operatorId
  const installationId =
    overrides?.installationId ?? headers?.installationId
  const environment = overrides?.environment ?? headers?.environment

  if (!operatorId || !installationId || !environment) return null

  const store: InstallStore = env.OPERATOR_CONFIG
    ? new KvInstallStore(env.OPERATOR_CONFIG as KVNamespace, installationId)
    : new NoOpInstallStore()

  return {
    operatorId,
    installationId,
    environment,
    env,
    store,
    credentials: createCredentialsProvider(),
    inputs: overrides?.inputs ?? parseInstallInputsHeader(request),
    logger: createLogger(operatorId, installationId),
    request,
    idempotencyKey: installationId,
  }
}
