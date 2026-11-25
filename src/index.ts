/**
 * @bagdock/worker-sdk — Public API surface.
 *
 * Platform SDK for Bagdock adapter workers. Vendor-agnostic —
 * knows nothing about Telnyx, Stripe, Shopify, or any other vendor.
 */

export { createBagdockWorker } from './create-worker'
export { createCommsWorker } from './create-comms-worker'
export { createPaymentsWorker } from './create-payments-worker'
export { createSearchWorker, SearchProviderError } from './create-search-worker'
export { SEARCH_QUERY_MAX_LENGTH, SEARCH_RESULT_LIMIT_MAX } from './types'
export { createContext, KvInstallStore, parseDispatchHeaders } from './context'
export { hmacSha256Verify, ed25519Verify } from './verify'
export { createCredentialsProvider, isPreparedCredential } from './credentials'
export { pickFields, createReplayGuard } from './controls'
export type { ReplayStore, ReplayGuard, ReplayGuardOptions } from './controls'
export { bagdockEventsRoute, tickRoute, installationWebhookRoute } from './channels'

export type {
  BaseEnv,
  HandlerContext,
  InstallStore,
  Logger,
  InstallResult,
  ConnectedAccountPayload,
  TeardownResult,
  HealthResponse,
  HealthCheckFn,
  RouteHandler,
  RouteEntry,
  VerifiedRouteConfig,
  InstallationWebhookRouteConfig,
  InstallationWebhookContext,
  BagdockEventDelivery,
  BagdockEventHandler,
  TickDelivery,
  TickHandler,
  VerifyFunction,
  HmacSha256VerifyOptions,
  Ed25519VerifyOptions,
  CommsCapability,
  CommsRouteMap,
  AllCommsRoutes,
  PaymentsCapability,
  PaymentsRouteMap,
  AllPaymentsRoutes,
  SearchCapability,
  SearchRouteMap,
  BagdockWorkerConfig,
  CommsWorkerConfig,
  PaymentsWorkerConfig,
  SearchWorkerConfig,
  SearchHandler,
  SearchRequest,
  SearchHit,
  SearchResult,
  SearchResponse,
  SearchErrorCode,
  SearchErrorBody,
  SendSMSParams,
  SendSMSResult,
  CreateCallParams,
  CallResult,
  EndCallParams,
  TransferCallParams,
  NormalizedCallEvent,
  NumberSearchParams,
  AvailableNumber,
  NumberType,
  NumberFeature,
  QuotedPrice,
  OrderNumberParams,
  OrderNumberResult,
  OrderStatus,
  OrderStatusParams,
  ProvisionNumberParams,
  ProvisionNumberResult,
  ReleaseNumberParams,
  ReleaseNumberResult,
  AssignProfileParams,
  AssignProfileResult,
  MessagingProfileParams,
  MessagingProfileResult,
  AlphanumericSenderParams,
  RegistrationKind,
  RegistrationStatus,
  BrandRegistrationInput,
  CampaignRegistrationInput,
  VettingRegistrationInput,
  RegistrationSubmitParams,
  RegistrationStatusParams,
  RegistrationResult,
  RegistrationAssignNumberParams,
  RegistrationAssignNumberResult,
  RegistrationUsecase,
  NormalizedRegistrationEvent,
} from './types'

export type {
  PreparedCredential,
  CredentialsProvider,
  CredentialAadContext,
} from './credentials'
