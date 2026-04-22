/**
 * @bagdock/worker-sdk — Core types.
 *
 * @compliance SOC 2 CC6.1 | ISO 27001 A.8.1
 */

// ---------------------------------------------------------------------------
// Worker Environment
// ---------------------------------------------------------------------------

export interface BaseEnv {
  ADAPTER_NAME?: string
  OPERATOR_CONFIG?: KVNamespace
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Handler Context
// ---------------------------------------------------------------------------

export interface HandlerContext<E extends BaseEnv = BaseEnv> {
  operatorId: string
  installationId: string
  environment: 'live' | 'test'
  env: E
  store: InstallStore
  logger: Logger
  request: Request
  /**
   * Lifecycle routes: set to `installationId` (stable across retries, correct for dedup).
   * Dispatch routes: set to `installationId` as fallback. NOT suitable for dedup --
   * two unrelated dispatch requests to the same installation get the same key.
   * v0.1.0 does not promise dispatch-level dedup. When the dispatch layer injects
   * `x-bagdock-request-id` (v0.2.0), the SDK will use it for dispatch routes.
   */
  idempotencyKey: string
}

export interface InstallStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface InstallResult {
  installation_state?: Record<string, unknown>
}

export interface TeardownResult {
  ok: true
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'down'
  version: string
  uptime_seconds: number
  adapter: string
  reason?: string
}

export type HealthCheckFn<E extends BaseEnv = BaseEnv> = (
  ctx: HandlerContext<E>,
) => Promise<{ status: 'healthy' | 'degraded' | 'down'; reason?: string }>

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------

export type RouteHandler<E extends BaseEnv = BaseEnv> = (
  ctx: HandlerContext<E>,
) => Promise<Response>

export interface VerifiedRouteConfig<E extends BaseEnv = BaseEnv> {
  handler: RouteHandler<E>
  verify: VerifyFunction<E>
}

export type RouteEntry<E extends BaseEnv = BaseEnv> =
  | RouteHandler<E>
  | VerifiedRouteConfig<E>

// ---------------------------------------------------------------------------
// Webhook Verification
// ---------------------------------------------------------------------------

/**
 * The stable contract for webhook verification.
 *
 * Generic `E` lets adapter-local verifiers type-check env bindings:
 * `export const myVerify: VerifyFunction<Env> = (req, env, body) => ...`
 * means `env.MY_SECRET` is checked at compile time -- no `as any` casts.
 *
 * Most adapters should use their vendor's own SDK (e.g. Telnyx, Stripe,
 * Shopify all publish verification helpers). For vendors without a
 * Workers-compatible SDK, wrap `hmacSha256Verify` or `ed25519Verify`
 * in an adapter-local `VerifyFunction`.
 *
 * Returns `true` if valid, or a `Response` (401/500) if rejected.
 */
export type VerifyFunction<E extends BaseEnv = BaseEnv> = (
  request: Request,
  env: E,
  rawBody: string,
) => Promise<true | Response>

/**
 * Options for the HMAC-SHA256 verification primitive.
 * The developer chooses where the signature and secret come from.
 *
 * **Return semantics on missing/invalid inputs:**
 * - `signature` is `null` → returns `Response.json({ error: 'Missing webhook signature' }, { status: 401 })`
 * - `timestamp` provided but unparseable or outside `toleranceMs` → 401 Response
 * - Signature mismatch (constant-time) → 401 Response
 * - All checks pass → `true`
 *
 * Primitives never throw. Callers can safely pass `headers.get(...)` (which
 * returns `string | null`) without pre-checking — the null case is a 401, not
 * an exception.
 */
export interface HmacSha256VerifyOptions {
  signature: string | null
  secret: string
  signingString: string
  toleranceMs?: number
  timestamp?: string | null
}

/**
 * Options for the Ed25519 verification primitive.
 *
 * **Return semantics on missing/invalid inputs:**
 * - `signature` is `null` → returns `Response.json({ error: 'Missing webhook signature' }, { status: 401 })`
 * - `timestamp` provided but unparseable or outside `toleranceMs` → 401 Response
 * - Signature invalid or crypto failure → 401 Response (logged to console)
 * - All checks pass → `true`
 *
 * Primitives never throw. Callers can safely pass `headers.get(...)` (which
 * returns `string | null`) without pre-checking — the null case is a 401, not
 * an exception.
 */
export interface Ed25519VerifyOptions {
  signature: string | null
  publicKey: string
  signingString: string
  toleranceMs?: number
  timestamp?: string | null
}

// ---------------------------------------------------------------------------
// Comms Capability Discriminant
// ---------------------------------------------------------------------------

export type CommsCapability = 'sms' | 'voice' | 'numbers'

// ---------------------------------------------------------------------------
// SMS Contract (aligned with operator-api comms/types.ts)
// ---------------------------------------------------------------------------

export interface SendSMSParams {
  to: string
  body: string
  from?: string
  facilityId?: string
  mediaUrls?: string[]
}

export interface SendSMSResult {
  id: string
  status: 'queued' | 'sent' | 'delivered' | 'failed'
  provider: string
  providerMessageId?: string
  from: string
  to: string
  segments?: number
}

// ---------------------------------------------------------------------------
// Voice Contract (aligned with operator-api comms/voice-provider.ts)
// ---------------------------------------------------------------------------

export interface CreateCallParams {
  from: string
  to: string
  operatorId: string
  facilityId?: string
  contactId?: string
  conversationId?: string
  webhookUrl: string
  metadata?: Record<string, unknown>
  assistantId?: string
  firstMessage?: string
  voiceId?: string
}

export interface CallResult {
  callId: string
  providerCallId: string
  status: 'initiated' | 'queued' | 'failed'
  from: string
  to: string
  metadata?: Record<string, unknown>
}

export interface EndCallParams {
  providerCallId: string
  reason?: 'hangup' | 'timeout' | 'error'
}

export interface TransferCallParams {
  providerCallId: string
  transferTo: string
  announceMessage?: string
}

export interface NormalizedCallEvent {
  eventType: string
  providerCallId: string
  timestamp: string
  direction?: 'inbound' | 'outbound'
  from?: string
  to?: string
  durationSeconds?: number
  recordingUrl?: string
  status?: string
  payload: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Numbers Contract (aligned with operator-api comms/types.ts + voice-provider.ts)
// ---------------------------------------------------------------------------

export interface NumberSearchParams {
  country: string
  areaCode?: string
  type?: 'local' | 'toll_free' | 'mobile'
  limit?: number
}

export interface AvailableNumber {
  phoneNumber: string
  type: 'local' | 'toll_free' | 'mobile'
  region?: string
  monthlyPricePence?: number
}

export interface ProvisionNumberParams {
  country: string
  locality?: string
  areaCode?: string
  type?: 'local' | 'toll_free' | 'mobile'
  facilityId?: string
}

export interface ProvisionNumberResult {
  number: string
  type: 'local' | 'toll_free' | 'mobile'
  country: string
  provider: string
  providerNumberId: string
}

export interface ReleaseNumberResult {
  success: boolean
}

// ---------------------------------------------------------------------------
// Comms Route Map (capabilities-driven)
// ---------------------------------------------------------------------------

export interface AllCommsRoutes<E extends BaseEnv = BaseEnv> {
  'sms/send': RouteHandler<E>
  'sms/status': RouteHandler<E>
  'voice/call': RouteHandler<E>
  'voice/status': RouteHandler<E>
  'numbers/search': RouteHandler<E>
  'numbers/provision': RouteHandler<E>
  'numbers/release': RouteHandler<E>
  'webhooks/sms': RouteEntry<E>
  'webhooks/voice': RouteEntry<E>
}

type SmsRequired = 'sms/send'
type VoiceRequired = 'voice/call'
type NumbersRequired = 'numbers/search' | 'numbers/provision'

export type CommsRouteMap<
  E extends BaseEnv,
  C extends readonly CommsCapability[],
> = ('sms' extends C[number]
  ? Pick<AllCommsRoutes<E>, SmsRequired>
  : {}) &
  ('voice' extends C[number]
    ? Pick<AllCommsRoutes<E>, VoiceRequired>
    : {}) &
  ('numbers' extends C[number]
    ? Pick<AllCommsRoutes<E>, NumbersRequired>
    : {}) &
  Partial<AllCommsRoutes<E>>

// ---------------------------------------------------------------------------
// Worker Config
// ---------------------------------------------------------------------------

export interface BagdockWorkerConfig<E extends BaseEnv = BaseEnv> {
  version?: string
  onInstall?: (ctx: HandlerContext<E>) => Promise<InstallResult | void>
  onUninstall?: (ctx: HandlerContext<E>) => Promise<TeardownResult | void>
  healthCheck?: HealthCheckFn<E>
  routes: Record<string, RouteEntry<E>>
}

export interface CommsWorkerConfig<
  E extends BaseEnv = BaseEnv,
  C extends readonly CommsCapability[] = readonly ['sms'],
> {
  version?: string
  capabilities: C
  onInstall?: (ctx: HandlerContext<E>) => Promise<InstallResult | void>
  onUninstall?: (ctx: HandlerContext<E>) => Promise<TeardownResult | void>
  healthCheck?: HealthCheckFn<E>
  routes: CommsRouteMap<E, C>
}
