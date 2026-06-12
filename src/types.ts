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

/**
 * Connected-account material returned from onInstall.
 *
 * The control plane persists this as a `connected_account_tokens` row and
 * links it to the installation; the worker keeps the plaintext capability
 * (the data key exists only as a worker secret, so this payload is opaque
 * to the control plane). Revocation stays centralized in the uninstall path.
 *
 * Two valid shapes, enforced by the union:
 * - credential-carrying: `encrypted_payload` MUST be versioned via
 *   `key_version` — an unversioned ciphertext cannot be rotated.
 * - reference-only: nothing secret to store (e.g. a live Connect acct_…
 *   operated via the platform key); `account_ref` is then required so the
 *   row still anchors revocation.
 *
 * @compliance SOC 2 CC6.1 — key never co-located with ciphertext
 */
interface ConnectedAccountBase {
  provider: string
  environment: 'live' | 'test'
}

export type ConnectedAccountPayload =
  | (ConnectedAccountBase & {
      /** Non-secret account reference (e.g. Stripe acct_… / sandbox id). */
      account_ref: string
      encrypted_payload?: never
      key_version?: never
    })
  | (ConnectedAccountBase & {
      account_ref?: string
      /** AES-256-GCM ciphertext, base64. Key is a worker-side secret. */
      encrypted_payload: string
      key_version: number
    })

export interface InstallResult {
  installation_state?: Record<string, unknown>
  connected_account?: ConnectedAccountPayload
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
// Payments Capability Discriminant (RFC 0004)
// ---------------------------------------------------------------------------

export type PaymentsCapability =
  | 'connect-onboarding'
  | 'charges'
  | 'subscriptions'
  | 'direct-debit'
  | 'payouts'
  | 'webhooks'

// ---------------------------------------------------------------------------
// Payments Route Map (capabilities-driven)
//
// The route taxonomy is the PSP contract: a future PSP (Mangopay, Ryft,
// Adyen) ships as a sibling worker declaring the capabilities it supports,
// and the operator-api gates features off the installation's
// `config.capabilities` — exactly how comms capabilities surface today.
// No deeper PSP abstraction (normalized charge objects, cross-PSP webhook
// schemas) until a second PSP forces real requirements (RFC 0004 decision 5).
// ---------------------------------------------------------------------------

export interface AllPaymentsRoutes<E extends BaseEnv = BaseEnv> {
  'connect/account': RouteHandler<E>
  'connect/account-link': RouteHandler<E>
  'connect/status': RouteHandler<E>
  'charges/create': RouteHandler<E>
  'charges/refund': RouteHandler<E>
  'subscriptions/create': RouteHandler<E>
  'subscriptions/update': RouteHandler<E>
  'subscriptions/cancel': RouteHandler<E>
  'subscriptions/portal': RouteHandler<E>
  'subscriptions/sync-catalog': RouteHandler<E>
  'direct-debit/setup': RouteHandler<E>
  'payouts/list': RouteHandler<E>
  'payouts/schedule': RouteHandler<E>
  'webhooks/platform': VerifiedRouteConfig<E>
  'webhooks/connect': VerifiedRouteConfig<E>
}

type ConnectOnboardingRequired =
  | 'connect/account'
  | 'connect/account-link'
  | 'connect/status'
type ChargesRequired = 'charges/create' | 'charges/refund'
type SubscriptionsRequired =
  | 'subscriptions/create'
  | 'subscriptions/update'
  | 'subscriptions/cancel'
  | 'subscriptions/portal'
type DirectDebitRequired = 'direct-debit/setup'
type PayoutsRequired = 'payouts/list' | 'payouts/schedule'
// Webhook routes are typed VerifiedRouteConfig (not RouteHandler) — a bare
// handler without `verify` is a compile error, never an unverified endpoint.
type WebhooksRequired = 'webhooks/platform' | 'webhooks/connect'

export type PaymentsRouteMap<
  E extends BaseEnv,
  C extends readonly PaymentsCapability[],
> = ('connect-onboarding' extends C[number]
  ? Pick<AllPaymentsRoutes<E>, ConnectOnboardingRequired>
  : {}) &
  ('charges' extends C[number]
    ? Pick<AllPaymentsRoutes<E>, ChargesRequired>
    : {}) &
  ('subscriptions' extends C[number]
    ? Pick<AllPaymentsRoutes<E>, SubscriptionsRequired>
    : {}) &
  ('direct-debit' extends C[number]
    ? Pick<AllPaymentsRoutes<E>, DirectDebitRequired>
    : {}) &
  ('payouts' extends C[number]
    ? Pick<AllPaymentsRoutes<E>, PayoutsRequired>
    : {}) &
  ('webhooks' extends C[number]
    ? Pick<AllPaymentsRoutes<E>, WebhooksRequired>
    : {}) &
  Partial<AllPaymentsRoutes<E>>

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

export interface PaymentsWorkerConfig<
  E extends BaseEnv = BaseEnv,
  C extends readonly PaymentsCapability[] = readonly PaymentsCapability[],
> {
  version?: string
  capabilities: C
  onInstall?: (ctx: HandlerContext<E>) => Promise<InstallResult | void>
  onUninstall?: (ctx: HandlerContext<E>) => Promise<TeardownResult | void>
  healthCheck?: HealthCheckFn<E>
  routes: PaymentsRouteMap<E, C>
}
