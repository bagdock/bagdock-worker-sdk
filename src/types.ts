/**
 * @bagdock/worker-sdk — Core types.
 *
 * @compliance SOC 2 CC6.1 | ISO 27001 A.8.1
 */

import type { CredentialsProvider, PreparedCredential } from './credentials'

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
  /**
   * Platform credential surface. An adapter declares a per-operator secret to
   * store; the platform seals it server-side. The only sanctioned way to build
   * the credential-carrying `ConnectedAccountPayload`. Adapters never touch
   * crypto, a KMS, or `CREDENTIAL_ENCRYPTION_KEY` (BDOK-557).
   */
  credentials: CredentialsProvider
  /**
   * Operator-submitted install inputs for THIS installation, resolved and
   * delivered by the platform per-request (BDOK-561). The platform reads the
   * adapter's declared `inputs`, pulls `text` values from installation config
   * and UNSEALS `password` values server-side, then hands the merged plaintext
   * map over the trusted dispatch channel. Keys match the manifest `inputs[].key`.
   *
   * May contain unsealed secrets — treat as sensitive. Ephemeral: the SDK never
   * persists it. Empty `{}` when the adapter declares no inputs or none are set.
   * Unsealing stays entirely server-side; the SDK performs no crypto (BDOK-557).
   */
  inputs: Record<string, string>
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
 * - credential-carrying: `credential` MUST be a `PreparedCredential` produced by
 *   `ctx.credentials.store()`. The worker hands over the RAW payload (it holds no
 *   key); the platform seals it server-side on ingest before it touches the DB.
 *   There is deliberately no `encrypted_payload` field here — a worker cannot
 *   express a sealed value, so the only producer of ciphertext is the platform
 *   (BDOK-557 scope 4: sealing is a platform guarantee, not a vendor task).
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
      credential?: never
    })
  | (ConnectedAccountBase & {
      account_ref?: string
      /** Raw credential handed to the platform to seal (see `ctx.credentials.store`). */
      credential: PreparedCredential
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

/** The context of a vendor webhook forwarded by the platform: the dispatch
 *  context plus the vendor's exact body, for the vendor's signature check. */
export interface InstallationWebhookContext<E extends BaseEnv = BaseEnv> extends HandlerContext<E> {
  rawBody: string
}

/**
 * A vendor webhook that reaches the worker through the platform's
 * per-installation URL, `/webhooks/apps/{installation_id}/{path}` on the
 * operator API (BDOK-3195). The platform signs the forward and adds the
 * installation's dispatch headers and install inputs, so the route runs with
 * the installation's context and can check the vendor's signature with the
 * installation's own secret (`ctx.inputs`). A direct, unsigned delivery is
 * refused with 401.
 *
 * Declare the route's path in the manifest's `webhooks`; the platform forwards
 * only to declared paths. GET is forwarded too, for vendors that validate an
 * endpoint with one; the query string is on `ctx.request.url`.
 */
export interface InstallationWebhookRouteConfig<E extends BaseEnv = BaseEnv> {
  kind: 'installation_webhook'
  /** The vendor's signature check. Return `true` to accept, or the response to send. */
  verify?: (ctx: InstallationWebhookContext<E>) => Promise<true | Response>
  handler: (ctx: InstallationWebhookContext<E>) => Promise<Response>
}

export type RouteEntry<E extends BaseEnv = BaseEnv> =
  | RouteHandler<E>
  | VerifiedRouteConfig<E>
  | InstallationWebhookRouteConfig<E>

// ---------------------------------------------------------------------------
// Installation channels: Bagdock events and the scheduled tick (BDOK-3195)
// ---------------------------------------------------------------------------

/**
 * A Bagdock event, as operator webhook endpoints receive it. The platform
 * sends each event the manifest's `events` declares to its `eventsRoute`.
 * `event_id` is the same on every retry of one event, so a handler
 * deduplicates on it.
 */
export interface BagdockEventDelivery<T = Record<string, unknown>> {
  event_id: string
  event_type: string
  /** ISO 8601. */
  occurred_at: string
  data: T
}

/** Handles one event type. Return nothing for 200, or a response to send;
 *  a throw answers 500 and the platform retries. */
export type BagdockEventHandler<E extends BaseEnv = BaseEnv> = (
  event: BagdockEventDelivery,
  ctx: HandlerContext<E>,
) => Promise<void | Response>

/** The body of a scheduled tick. `id` is unique per installation and minute. */
export interface TickDelivery {
  object: 'tick'
  id: string
  /** ISO 8601, the start of the minute the tick was due. */
  scheduled_at: string
  interval_seconds: number
}

/** Runs on each tick. Ticks can overlap when a run is slower than the
 *  interval, so a handler is idempotent. A tick is not retried. */
export type TickHandler<E extends BaseEnv = BaseEnv> = (
  tick: TickDelivery,
  ctx: HandlerContext<E>,
) => Promise<void | Response>

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
 * - `timestamp` missing (`undefined`, `null` or empty) → 401 Response, unless `requireTimestamp: false`
 * - `timestamp` unparseable or outside `toleranceMs` → 401 Response
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
  /**
   * Defaults to `true`: a missing timestamp fails verification. Set `false`
   * only for a vendor that does not sign a timestamp; a timestamp that is
   * present is still checked against `toleranceMs`.
   */
  requireTimestamp?: boolean
}

/**
 * Options for the Ed25519 verification primitive.
 *
 * **Return semantics on missing/invalid inputs:**
 * - `signature` is `null` → returns `Response.json({ error: 'Missing webhook signature' }, { status: 401 })`
 * - `timestamp` missing (`undefined`, `null` or empty) → 401 Response, unless `requireTimestamp: false`
 * - `timestamp` unparseable or outside `toleranceMs` → 401 Response
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
  /**
   * Defaults to `true`: a missing timestamp fails verification. Set `false`
   * only for a vendor that does not sign a timestamp; a timestamp that is
   * present is still checked against `toleranceMs`.
   */
  requireTimestamp?: boolean
}

// ---------------------------------------------------------------------------
// Comms Capability Discriminant
// ---------------------------------------------------------------------------

/**
 * What a comms adapter supports. operator-api hides a control whose route the
 * adapter does not declare. `messaging_profile`, `alphanumeric_sender` and
 * `registration` added in 0.8.0 (BDOK-3142).
 */
export type CommsCapability =
  | 'sms'
  | 'voice'
  | 'numbers'
  | 'messaging_profile'
  | 'alphanumeric_sender'
  | 'registration'

// ---------------------------------------------------------------------------
// SMS Contract (aligned with operator-api comms/types.ts)
// ---------------------------------------------------------------------------

export interface SendSMSParams {
  to: string
  body: string
  /**
   * The sender: an E.164 number, or an alphanumeric sender ID (letters,
   * digits and spaces, at most 11 characters). operator-api passes it on
   * every send; adapters keep no default sender.
   */
  from?: string
  /**
   * Provider id of the messaging profile to send through. Required by Telnyx
   * when `from` is an alphanumeric sender.
   */
  messagingProfileId?: string
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

export type NumberType = 'local' | 'mobile' | 'toll_free' | 'national'
export type NumberFeature = 'sms' | 'mms' | 'voice'

/** A price as the provider quotes it, in the currency's minor units. */
export interface QuotedPrice {
  amountMinor: number
  /** ISO 4217, as quoted by the provider. Never converted. */
  currency: string
}

export interface NumberSearchParams {
  /** ISO 3166-1 alpha-2. */
  country: string
  numberType?: NumberType
  areaCode?: string
  locality?: string
  /** A US state or Canadian province. */
  administrativeArea?: string
  /** Every listed feature must be present on a result. */
  features?: NumberFeature[]
  /** Digits the number must contain. */
  contains?: string
  limit?: number
}

export interface AvailableNumber {
  phoneNumber: string
  numberType: NumberType
  country: string
  locality?: string
  administrativeArea?: string
  features: NumberFeature[]
  monthlyCost?: QuotedPrice
  upfrontCost?: QuotedPrice
  /** Names of what the provider needs before it sells this number. */
  requirements: string[]
  /** True when the adapter answered from a fixture because the provider's test environment has no such resource. */
  simulated?: boolean
}

export interface OrderNumberParams {
  /** One exact number from a search, E.164. */
  phoneNumber: string
  messagingProfileId?: string
  voiceConnectionId?: string
  /** A provider requirement group holding what `requirements` asked for. */
  requirementGroupId?: string
  /** A Bagdock id (`pnum_…`). Never personal data. */
  customerReference: string
}

export type OrderStatus = 'pending' | 'active' | 'requirements_needed' | 'failed'

export interface OrderNumberResult {
  providerOrderId?: string
  /** The provider's id for the number, once the order is complete. */
  providerNumberId?: string
  phoneNumber?: string
  status: OrderStatus
  statusReason?: string
  simulated?: boolean
}

export interface OrderStatusParams {
  providerOrderId: string
}

export interface ReleaseNumberParams {
  providerNumberId: string
}

export interface ReleaseNumberResult {
  success: boolean
  /** True when the provider no longer held the number. */
  alreadyReleased?: boolean
  providerStatus?: string
  simulated?: boolean
}

export interface AssignProfileParams {
  providerNumberId: string
  /** Null removes the number from its profile. */
  messagingProfileId: string | null
}

export interface AssignProfileResult {
  providerNumberId: string
  messagingProfileId: string | null
  simulated?: boolean
}

/**
 * Deprecated in 0.8.0: orders the first search result. Use
 * `numbers/search` then `numbers/order`. Kept for one release.
 */
export interface ProvisionNumberParams {
  country: string
  locality?: string
  areaCode?: string
  type?: 'local' | 'toll_free' | 'mobile'
  facilityId?: string
}

/** Deprecated in 0.8.0, with `ProvisionNumberParams`. */
export interface ProvisionNumberResult {
  number: string
  type: 'local' | 'toll_free' | 'mobile'
  country: string
  provider: string
  providerNumberId: string
}

// ---------------------------------------------------------------------------
// Messaging profile and alphanumeric sender (0.8.0, BDOK-3142)
// ---------------------------------------------------------------------------

export interface MessagingProfileParams {
  /** Update this profile. Omitted: the installation's profile, created when absent. */
  providerProfileId?: string
  /** ISO 3166-1 alpha-2 countries the profile may text. */
  allowedDestinations?: string[]
  /** Where the provider sends inbound texts and delivery reports. Null clears it. */
  webhookUrl?: string | null
}

export interface MessagingProfileResult {
  providerProfileId: string
  name: string
  allowedDestinations: string[]
  alphanumericSender: string | null
}

export interface AlphanumericSenderParams {
  providerProfileId: string
  /** Letters, digits and spaces. Null clears the sender. */
  sender: string | null
}

// ---------------------------------------------------------------------------
// US registration (0.8.0, BDOK-3142)
// ---------------------------------------------------------------------------

export type RegistrationKind = 'us_10dlc_brand' | 'us_10dlc_campaign' | 'us_10dlc_vetting'

export type RegistrationStatus = 'submitted' | 'vetting' | 'approved' | 'rejected' | 'suspended'

/** The business behind a US 10DLC brand. Business details only. */
export interface BrandRegistrationInput {
  entityType: 'PRIVATE_PROFIT' | 'PUBLIC_PROFIT' | 'NON_PROFIT' | 'GOVERNMENT' | 'SOLE_PROPRIETOR'
  /** Trading name. */
  displayName: string
  /** Legal name. */
  companyName?: string
  ein?: string
  phone?: string
  street?: string
  city?: string
  /** Two-letter state code. */
  state?: string
  postalCode?: string
  /** ISO 3166-1 alpha-2. */
  country: string
  email: string
  website?: string
  /** Industry. Storage operators register as `REAL_ESTATE`. */
  vertical?: string
}

export interface CampaignRegistrationInput {
  /** The provider's brand id. */
  brandId: string
  usecase: string
  description: string
  /** One to five sample messages. */
  samples: string[]
  messageFlow?: string
  helpMessage?: string
  optinMessage?: string
  optoutMessage?: string
  subscriberOptin?: boolean
  subscriberOptout?: boolean
  subscriberHelp?: boolean
  embeddedLink?: boolean
  numberPool?: boolean
  ageGated?: boolean
  directLending?: boolean
  privacyPolicyLink?: string
  termsAndConditionsLink?: string
}

/** Enhanced (third-party) vetting of a brand that scored low. */
export interface VettingRegistrationInput {
  brandId: string
  /** Vetting provider, e.g. `AEGIS`. */
  provider: string
  vettingClass: string
}

export interface RegistrationSubmitParams {
  kind: RegistrationKind
  brand?: BrandRegistrationInput
  campaign?: CampaignRegistrationInput
  vetting?: VettingRegistrationInput
  /** Where the provider sends status events. */
  webhookUrl: string
  /** A Bagdock id (`creg_…`). Never personal data. */
  referenceId: string
}

export interface RegistrationStatusParams {
  kind: RegistrationKind
  providerRegistrationId: string
}

export interface RegistrationResult {
  providerRegistrationId: string
  status: RegistrationStatus
  /** The provider's own status value, unchanged. */
  providerStatus: string
  statusReason?: string
  /** Brands only: the provider's identity verdict, e.g. `UNVERIFIED`. */
  identityStatus?: string
  simulated?: boolean
}

export interface RegistrationAssignNumberParams {
  /** E.164. */
  phoneNumber: string
  providerCampaignId: string
}

export interface RegistrationAssignNumberResult {
  phoneNumber: string
  providerCampaignId: string
  status: 'pending' | 'assigned' | 'failed' | 'unassigning'
  providerStatus: string
  statusReason?: string
  simulated?: boolean
}

export interface RegistrationUsecase {
  usecase: string
  monthlyCost?: QuotedPrice
  upfrontCost?: QuotedPrice
}

/** A provider registration event, normalised. */
export interface NormalizedRegistrationEvent {
  kind: RegistrationKind
  providerRegistrationId: string
  providerBrandId?: string
  providerEventType?: string
  providerStatus?: string
  /** Set only when the event alone decides the status. */
  status?: RegistrationStatus
  description?: string
  /** True when the caller should read `registrations/status` for the current state. */
  refresh: boolean
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
  'numbers/order': RouteHandler<E>
  'numbers/order-status': RouteHandler<E>
  /** Deprecated in 0.8.0; use `numbers/order`. */
  'numbers/provision': RouteHandler<E>
  'numbers/release': RouteHandler<E>
  'numbers/assign-profile': RouteHandler<E>
  'messaging/profile': RouteHandler<E>
  'senders/alphanumeric': RouteHandler<E>
  'registrations/submit': RouteHandler<E>
  'registrations/status': RouteHandler<E>
  'registrations/assign-number': RouteHandler<E>
  'registrations/usecases': RouteHandler<E>
  'webhooks/sms': RouteEntry<E>
  'webhooks/voice': RouteEntry<E>
  'webhooks/registration': RouteEntry<E>
}

type SmsRequired = 'sms/send'
type VoiceRequired = 'voice/call'
type NumbersRequired = 'numbers/search' | 'numbers/order' | 'numbers/release'
type MessagingProfileRequired = 'messaging/profile'
type AlphanumericSenderRequired = 'senders/alphanumeric'
type RegistrationRequired =
  | 'registrations/submit'
  | 'registrations/status'
  | 'registrations/assign-number'
  | 'webhooks/registration'

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
  ('messaging_profile' extends C[number]
    ? Pick<AllCommsRoutes<E>, MessagingProfileRequired>
    : {}) &
  ('alphanumeric_sender' extends C[number]
    ? Pick<AllCommsRoutes<E>, AlphanumericSenderRequired>
    : {}) &
  ('registration' extends C[number]
    ? Pick<AllCommsRoutes<E>, RegistrationRequired>
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
// Search Capability Discriminant
// ---------------------------------------------------------------------------

export type SearchCapability = 'web_search'

// ---------------------------------------------------------------------------
// Search Contract
//
// One platform route, `POST /search`. The platform calls it; a search worker
// never calls the platform back, so it holds no scope and no callback
// credential. The contract names no provider: a worker maps these fields onto
// its provider's search call, and the platform cannot tell which one answered.
// ---------------------------------------------------------------------------

/** Longest `query`, in characters after trimming. */
export const SEARCH_QUERY_MAX_LENGTH = 400

/** Largest `limit`. */
export const SEARCH_RESULT_LIMIT_MAX = 10

export interface SearchRequest {
  /** Place names and the kind of event sought. Nothing about a tenant. */
  query: string
  /** Earliest publication date wanted, `YYYY-MM-DD`. */
  since: string
  /** Most results wanted, 1 to `SEARCH_RESULT_LIMIT_MAX`. */
  limit: number
}

export interface SearchResult {
  /** The page title. Empty when the provider returns none. */
  title: string
  /** An absolute http(s) URL. A result without one is never returned. */
  url: string
  /** Publication date, `YYYY-MM-DD` in UTC. Null when the provider returns no date. */
  published_at: string | null
  /** The text the provider matched on the page. A result without one is never returned. */
  passage: string
}

export interface SearchResponse {
  results: SearchResult[]
}

/**
 * What a search handler hands back before the factory normalises it: fields a
 * provider may leave out, and the provider's own date string, as an ISO 8601
 * date or date-time or as a dated string that states its zone (RFC 1123).
 */
export interface SearchHit {
  title?: string | null
  url?: string | null
  published_at?: string | null
  passage?: string | null
}

export type SearchErrorCode =
  | 'invalid_query'
  | 'provider_key_rejected'
  | 'provider_rate_limited'
  | 'provider_unavailable'

export interface SearchErrorBody {
  error: {
    type: 'invalid_request_error' | 'authentication_error' | 'rate_limit_error' | 'api_error'
    code: SearchErrorCode
    message: string
    param?: keyof SearchRequest
  }
}

/**
 * A search route handler. It receives the validated request and returns the
 * provider's hits; the factory owns the wire shape. It throws
 * `SearchProviderError` for a refused key or a reached limit, and anything
 * else it throws is reported as `provider_unavailable`.
 */
export type SearchHandler<E extends BaseEnv = BaseEnv> = (
  ctx: HandlerContext<E>,
  request: SearchRequest,
) => Promise<SearchHit[]>

// ---------------------------------------------------------------------------
// Search Route Map
//
// One capability and one route, so the map is not capabilities-driven as the
// comms and payments maps are. A second capability brings its routes and the
// conditional map with it.
// ---------------------------------------------------------------------------

export interface SearchRouteMap<E extends BaseEnv = BaseEnv> {
  search: SearchHandler<E>
}

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

export interface SearchWorkerConfig<E extends BaseEnv = BaseEnv> {
  version?: string
  capabilities: readonly SearchCapability[]
  onInstall?: (ctx: HandlerContext<E>) => Promise<InstallResult | void>
  onUninstall?: (ctx: HandlerContext<E>) => Promise<TeardownResult | void>
  healthCheck?: HealthCheckFn<E>
  routes: SearchRouteMap<E>
}
