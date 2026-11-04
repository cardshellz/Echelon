/**
 * Staff Shopify connection contract. Channels owns challenge/connection changes;
 * Identity supplies current authority. These are not vendor OAuth actions.
 */
export interface ShopifyStaffOAuthConfig {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: readonly string[];
  fingerprint: string;
}
export interface ShopifyStaffOAuthActor { actorId: string; sessionHash: string }
export interface ShopifyStaffOAuthBinding extends ShopifyStaffOAuthActor {
  operationId: string;
  stateHash: string;
  configFingerprint: string;
  shopDomain: string;
  channelId: number;
  connectionId: number;
  connectionFingerprint: string;
  createdAt: Date;
  expiresAt: Date;
}
export interface ShopifyStaffOAuthClaim extends ShopifyStaffOAuthBinding {
  attemptId: string;
}
export interface ShopifyStaffOAuthResult {
  operationId: string;
  channelId: number;
  connectionId: number;
  status: "connected" | "in_progress" | "exchange_unknown" | "failed" | "superseded";
  replayed: boolean;
  code?: string;
}
export interface ShopifyStaffOAuthToken {
  accessToken: string;
  scopes: string;
}
export interface ShopifyStaffOAuthCreate extends ShopifyStaffOAuthActor {
  operationId: string;
  stateHash: string;
  configFingerprint: string;
  shopDomain: string;
  requestedChannelId?: number;
  now: Date;
  expiresAt: Date;
}
export interface ShopifyStaffOAuthClaimInput extends ShopifyStaffOAuthActor {
  stateHash: string;
  configFingerprint: string;
  shopDomain: string;
  attemptId: string;
  now: Date;
}
export type ShopifyStaffOAuthClaimResult =
  | { kind: "claimed"; claim: ShopifyStaffOAuthClaim }
  | { kind: "result"; result: ShopifyStaffOAuthResult };
export interface ShopifyStaffOAuthRepository {
  create(input: ShopifyStaffOAuthCreate): Promise<ShopifyStaffOAuthBinding>;
  claim(input: ShopifyStaffOAuthClaimInput): Promise<ShopifyStaffOAuthClaimResult>;
  complete(claim: ShopifyStaffOAuthClaim, token: ShopifyStaffOAuthToken, now: Date): Promise<ShopifyStaffOAuthResult>;
  fail(claim: ShopifyStaffOAuthClaim, status: "exchange_unknown" | "failed", code: string, now: Date): Promise<void>;
  outcome(input: ShopifyStaffOAuthClaimInput): Promise<ShopifyStaffOAuthResult | null>;
}
export class ShopifyStaffOAuthError extends Error {
  readonly operationId?: string;
  constructor(readonly code: string, readonly httpStatus = 400,
    readonly outcome: "failed" | "exchange_unknown" = "failed", operationId?: string) {
    // No untrusted/provider/credential data belongs in messages or causes.
    super(code);
    this.name = "ShopifyStaffOAuthError";
    if (operationId && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(operationId)) {
      this.operationId = operationId;
    }
  }
}
