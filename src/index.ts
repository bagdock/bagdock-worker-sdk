/**
 * @bagdock/worker-sdk — Public API surface.
 *
 * Platform SDK for Bagdock adapter workers. Vendor-agnostic —
 * knows nothing about Telnyx, Stripe, Shopify, or any other vendor.
 */

export { createBagdockWorker } from './create-worker'
export { createCommsWorker } from './create-comms-worker'
export { createPaymentsWorker } from './create-payments-worker'
export { createContext, KvInstallStore, parseDispatchHeaders } from './context'
export { hmacSha256Verify, ed25519Verify } from './verify'
export { createCredentialsProvider, isPreparedCredential } from './credentials'

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
  VerifyFunction,
  HmacSha256VerifyOptions,
  Ed25519VerifyOptions,
  CommsCapability,
  CommsRouteMap,
  AllCommsRoutes,
  PaymentsCapability,
  PaymentsRouteMap,
  AllPaymentsRoutes,
  BagdockWorkerConfig,
  CommsWorkerConfig,
  PaymentsWorkerConfig,
  SendSMSParams,
  SendSMSResult,
  CreateCallParams,
  CallResult,
  EndCallParams,
  TransferCallParams,
  NormalizedCallEvent,
  NumberSearchParams,
  AvailableNumber,
  ProvisionNumberParams,
  ProvisionNumberResult,
  ReleaseNumberResult,
} from './types'

export type {
  PreparedCredential,
  CredentialsProvider,
  CredentialAadContext,
} from './credentials'
