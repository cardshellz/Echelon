import { createHash, createHmac } from "node:crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import type { CustomerReturnInspectionShop } from "./customer-return-local-inspection.ports";

export const RETURN_HANDOFF_ISSUER = "shellz-club-returns";
export const RETURN_HANDOFF_AUDIENCE = "echelon-customer-returns";
export const RETURN_HANDOFF_LIFETIME_SECONDS = 90;
export const RETURN_CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
export const RETURN_SESSION_LIFETIME_MS = 30 * 60 * 1000;
const stateSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const shopSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/).max(255);
const customerIdSchema = z.string().regex(/^[1-9][0-9]{0,29}$/);
const grantSchema = z.object({
  iss: z.literal(RETURN_HANDOFF_ISSUER), aud: z.literal(RETURN_HANDOFF_AUDIENCE),
  shop: shopSchema, customerId: customerIdSchema, state: stateSchema,
  jti: z.string().uuid(), iat: z.number().int().nonnegative(), exp: z.number().int().positive(),
}).strict();
export const customerReturnCustomerSessionSchema = z.object({
  channelId: z.number().int().positive().safe(), externalCustomerId: customerIdSchema,
  shopDomain: shopSchema, sessionKey: stateSchema,
  authenticatedAt: z.number().int().nonnegative().safe(), expiresAt: z.number().int().positive().safe(),
}).strict();
export type CustomerReturnCustomerSession = z.infer<typeof customerReturnCustomerSessionSchema>;
export interface ReturnLoginChallengeStore {
  create(input: { stateHash: string; browserHash: string; shopDomain: string; expiresAt: Date; now: Date }): Promise<void>;
  /** Atomic compare-and-consume: exactly one callback may redeem a browser-bound challenge. */
  consume(input: { stateHash: string; browserHash: string; shopDomain: string; now: Date }): Promise<Date | null>;
}
export interface ReturnCustomerAuthConfig {
  secret: string;
  publicOrigin: string;
  loginUrls: Readonly<Record<string, string>>;
}
export class CustomerReturnCustomerAccessError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); this.name = "CustomerReturnCustomerAccessError"; }
}
export function customerAuthenticationRequired() {
  return new CustomerReturnCustomerAccessError("RETURN_CUSTOMER_LOGIN_REQUIRED", "Sign in to your store account to view your returns.", 401);
}
export function readReturnCustomerAuthConfig(env: NodeJS.ProcessEnv): ReturnCustomerAuthConfig {
  try {
    const secret = z.string().min(32).max(1024).parse(env.CUSTOMER_RETURN_HANDOFF_SECRET);
    const origin = new URL(z.string().parse(env.CUSTOMER_RETURN_PUBLIC_ORIGIN));
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error();
    const raw: unknown = JSON.parse(env.CUSTOMER_RETURN_LOGIN_URLS ?? "null");
    const urls = z.record(shopSchema, z.string().url()).parse(raw);
    if (Object.keys(urls).length < 1 || Object.keys(urls).length > 20) throw new Error();
    for (const value of Object.values(urls)) {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || !url.pathname.endsWith("/returns")) throw new Error();
    }
    return { secret, publicOrigin: origin.origin, loginUrls: urls };
  } catch {
    throw new CustomerReturnCustomerAccessError("RETURN_CUSTOMER_CONFIGURATION_REQUIRED", "Customer sign-in is not configured yet.", 503);
  }
}
export class CustomerReturnCustomerAuthService {
  constructor(private readonly dependencies: {
    config: ReturnCustomerAuthConfig; challenges: ReturnLoginChallengeStore;
    shops: () => Promise<readonly CustomerReturnInspectionShop[]>; now: () => Date; randomState: () => string;
  }) {}

  async start(browserId: string, requestedShop?: string): Promise<string> {
    const shops = await this.dependencies.shops();
    const configured = shops.filter(shop => Object.hasOwn(this.dependencies.config.loginUrls, shop.shopDomain));
    // This optional hint selects a login destination only. It grants no identity;
    // the callback must carry fresh Shopify proof for that exact configured shop.
    const selected = requestedShop === undefined && configured.length === 1 ? configured[0]
      : configured.find(shop => shop.shopDomain === requestedShop);
    if (!selected || configured.filter(shop => shop.shopDomain === selected.shopDomain).length !== 1) {
      throw new CustomerReturnCustomerAccessError("RETURN_CUSTOMER_STORE_UNAVAILABLE", "Open returns from your store account.", 400);
    }
    const state = stateSchema.parse(this.dependencies.randomState());
    const now = this.now();
    await this.dependencies.challenges.create({ stateHash: hash(state), browserHash: hash(browserId),
      shopDomain: selected.shopDomain, now, expiresAt: new Date(now.getTime() + RETURN_CHALLENGE_LIFETIME_MS) });
    const redirect = new URL(this.dependencies.config.loginUrls[selected.shopDomain]);
    redirect.searchParams.set("state", state);
    return redirect.href;
  }

  async authenticate(browserId: string, rawToken: unknown): Promise<CustomerReturnCustomerSession> {
    const now = this.now();
    const seconds = Math.floor(now.getTime() / 1000);
    let grant: z.infer<typeof grantSchema>;
    try {
      const token = z.string().min(1).max(4096).parse(rawToken);
      grant = grantSchema.parse(jwt.verify(token, this.dependencies.config.secret, {
        algorithms: ["HS256"], audience: RETURN_HANDOFF_AUDIENCE, issuer: RETURN_HANDOFF_ISSUER,
        clockTimestamp: seconds, clockTolerance: 0, maxAge: RETURN_HANDOFF_LIFETIME_SECONDS,
      }));
      if (grant.iat > seconds || grant.exp <= grant.iat || grant.exp - grant.iat > RETURN_HANDOFF_LIFETIME_SECONDS) throw new Error();
    } catch { throw customerAuthenticationRequired(); }
    const shops = (await this.dependencies.shops()).filter(shop => shop.shopDomain === grant.shop);
    if (shops.length !== 1 || !Object.hasOwn(this.dependencies.config.loginUrls, grant.shop)) throw customerAuthenticationRequired();
    const consumeAt = this.now();
    if (consumeAt.getTime() >= grant.exp * 1000 || consumeAt.getTime() < grant.iat * 1000) throw customerAuthenticationRequired();
    const challengeExpiresAt = await this.dependencies.challenges.consume({ stateHash: hash(grant.state), browserHash: hash(browserId), shopDomain: grant.shop, now: consumeAt });
    const acceptedAt = this.now();
    // Both mapping I/O and a contended database lock can outlive either proof.
    // A late redemption stays consumed but can never produce a customer session.
    if (!(challengeExpiresAt instanceof Date) || !Number.isFinite(challengeExpiresAt.getTime())
      || acceptedAt.getTime() >= challengeExpiresAt.getTime() || acceptedAt.getTime() >= grant.exp * 1000
      || acceptedAt.getTime() < consumeAt.getTime()) {
      throw customerAuthenticationRequired();
    }
    return customerReturnCustomerSessionSchema.parse({ channelId: shops[0].channelId, externalCustomerId: grant.customerId,
      shopDomain: grant.shop, sessionKey: this.storageKey(grant.shop, grant.customerId), authenticatedAt: acceptedAt.getTime(),
      expiresAt: acceptedAt.getTime() + RETURN_SESSION_LIFETIME_MS });
  }

  async principal(raw: unknown): Promise<CustomerReturnCustomerSession> {
    const result = customerReturnCustomerSessionSchema.safeParse(raw);
    const now = this.now().getTime();
    if (!result.success || result.data.authenticatedAt > now || result.data.expiresAt <= now
      || result.data.expiresAt - result.data.authenticatedAt !== RETURN_SESSION_LIFETIME_MS) throw customerAuthenticationRequired();
    const matches = (await this.dependencies.shops()).filter(shop => shop.shopDomain === result.data.shopDomain);
    if (matches.length !== 1 || matches[0].channelId !== result.data.channelId || this.now().getTime() >= result.data.expiresAt
      || result.data.sessionKey !== this.storageKey(result.data.shopDomain, result.data.externalCustomerId)) throw customerAuthenticationRequired();
    return result.data;
  }
  private now(): Date {
    const instant = this.dependencies.now();
    if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) {
      throw new CustomerReturnCustomerAccessError("RETURN_CUSTOMER_UNAVAILABLE", "Customer sign-in is temporarily unavailable.", 503);
    }
    return instant;
  }
  private storageKey(shop: string, customerId: string): string {
    // Opaque browser-storage partition, never an authentication credential. It
    // survives reauthentication so an uncertain submission retains its UUID.
    return createHmac("sha256", this.dependencies.config.secret).update(`returns-storage:v1:${shop}:${customerId}`).digest("base64url");
  }
}
function hash(value: string): string {
  if (!value || value.length > 1024) throw customerAuthenticationRequired();
  return createHash("sha256").update(value).digest("hex");
}
