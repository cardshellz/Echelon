import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import {
  customerReturnCustomerIdSchema,
  customerReturnShopSchema,
  customerReturnStateSchema,
  verifyCustomerReturnShopifyProof,
  type CustomerReturnShopifyProof,
} from "../domain/customer-return-shopify-proof";
import type { CustomerReturnInspectionShop } from "./customer-return-local-inspection.ports";

export const RETURN_CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
export const RETURN_SESSION_LIFETIME_MS = 30 * 60 * 1000;
const MAX_PROXY_QUERY_BYTES = 8192;
// Unpadded base64url needs at most ceil(4n/3) characters for n bytes.
export const RETURN_CUSTOMER_ENCODED_PROOF_MAX_LENGTH = Math.ceil(MAX_PROXY_QUERY_BYTES * 4 / 3);
export const customerReturnCustomerSessionSchema = z.object({
  channelId: z.number().int().positive().safe(), externalCustomerId: customerReturnCustomerIdSchema,
  shopDomain: customerReturnShopSchema, sessionKey: customerReturnStateSchema,
  authenticatedAt: z.number().int().nonnegative().safe(), expiresAt: z.number().int().positive().safe(),
}).strict();
export type CustomerReturnCustomerSession = z.infer<typeof customerReturnCustomerSessionSchema>;
export interface ReturnLoginChallengeStore {
  create(input: { stateHash: string; browserHash: string; shopDomain: string; expiresAt: Date; now: Date }): Promise<void>;
  /** Atomic compare-and-consume: exactly one callback may redeem a browser-bound challenge. */
  consume(input: { stateHash: string; browserHash: string; shopDomain: string; now: Date }): Promise<Date | null>;
}
export interface ReturnCustomerShopifyApp {
  readonly proxyUrl: string;
  readonly shopifySecret: string;
}
export interface ReturnCustomerAuthConfig {
  readonly storageSecret: string;
  readonly publicOrigin: string;
  readonly shops: Readonly<Record<string, ReturnCustomerShopifyApp>>;
}
export type CustomerReturnProxyResult =
  | { kind: "redirect"; location: string }
  | { kind: "handoff"; proof: string; callbackUrl: string };
export class CustomerReturnCustomerAccessError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); this.name = "CustomerReturnCustomerAccessError"; }
}
export function customerAuthenticationRequired() {
  return new CustomerReturnCustomerAccessError("RETURN_CUSTOMER_LOGIN_REQUIRED", "Sign in to your store account to view your returns.", 401);
}

export function readReturnCustomerAuthConfig(env: NodeJS.ProcessEnv): ReturnCustomerAuthConfig {
  try {
    // The legacy value is retained ONLY for browser recovery-key continuity.
    // Neither value can authenticate a customer or sign an identity grant.
    const storageSecret = z.string().min(32).max(1024).parse(env.CUSTOMER_RETURN_STORAGE_SECRET ?? env.CUSTOMER_RETURN_HANDOFF_SECRET);
    const origin = new URL(z.string().parse(env.CUSTOMER_RETURN_PUBLIC_ORIGIN));
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error();
    const raw: unknown = JSON.parse(env.CUSTOMER_RETURN_SHOPIFY_APPS ?? "null");
    const entries = z.record(customerReturnShopSchema, z.object({
      proxyUrl: z.string().url().max(2048), secretEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
    }).strict()).parse(raw);
    if (Object.keys(entries).length < 1 || Object.keys(entries).length > 20) throw new Error();
    const shops: Record<string, ReturnCustomerShopifyApp> = {};
    for (const [shop, entry] of Object.entries(entries)) {
      const url = new URL(entry.proxyUrl);
      const path = /^\/(apps|a|community|tools)\/([a-z0-9][a-z0-9-]*)$/.exec(url.pathname);
      if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
        || !path || path[2] === "member-portal" || entry.proxyUrl !== `${url.origin}${url.pathname}`) throw new Error();
      // A shop names its own app credential explicitly. Never try other shops'
      // keys or treat an Admin API token/webhook key as an implicit fallback.
      if (!Object.hasOwn(env, entry.secretEnv)) throw new Error();
      const shopifySecret = z.string().min(1).max(4096).refine(value => value.trim().length > 0).parse(env[entry.secretEnv]);
      if (shopifySecret === storageSecret || shopifySecret === env.CUSTOMER_RETURN_HANDOFF_SECRET) throw new Error();
      shops[shop] = Object.freeze({ proxyUrl: url.href, shopifySecret });
    }
    return { storageSecret, publicOrigin: origin.origin, shops: Object.freeze(shops) };
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
    const configured = shops.filter(shop => Object.hasOwn(this.dependencies.config.shops, shop.shopDomain));
    // The navigation hint selects a login destination, never an identity.
    const selected = requestedShop === undefined && configured.length === 1 ? configured[0]
      : configured.find(shop => shop.shopDomain === requestedShop);
    if (!selected || configured.filter(shop => shop.shopDomain === selected.shopDomain).length !== 1) {
      throw new CustomerReturnCustomerAccessError("RETURN_CUSTOMER_STORE_UNAVAILABLE", "Open returns from your store account.", 400);
    }
    const state = customerReturnStateSchema.parse(this.dependencies.randomState());
    const now = this.now();
    await this.dependencies.challenges.create({ stateHash: hash(state), browserHash: hash(browserId),
      shopDomain: selected.shopDomain, now, expiresAt: new Date(now.getTime() + RETURN_CHALLENGE_LIFETIME_MS) });
    const redirect = new URL(this.dependencies.config.shops[selected.shopDomain].proxyUrl);
    redirect.searchParams.set("state", state);
    return redirect.href;
  }

  async proxy(rawQuery: string): Promise<CustomerReturnProxyResult> {
    const proof = this.verifyProof(rawQuery, this.now());
    await this.requireShop(proof.shop);
    this.verifyProof(rawQuery, this.now());
    if (!proof.state) {
      const destination = new URL("/customer-returns/start", this.dependencies.config.publicOrigin);
      destination.searchParams.set("shop", proof.shop);
      return { kind: "redirect", location: destination.href };
    }
    if (!proof.customerId) {
      const proxy = new URL(this.dependencies.config.shops[proof.shop].proxyUrl);
      const login = new URL("/account/login", proxy.origin);
      login.searchParams.set("return_url", `${proxy.pathname}?state=${proof.state}`);
      return { kind: "redirect", location: login.href };
    }
    // This is transport encoding, not an identity grant. The same-origin
    // redemption independently verifies Shopify's original signed bytes.
    return { kind: "handoff", proof: Buffer.from(rawQuery, "utf8").toString("base64url"),
      callbackUrl: `${this.dependencies.config.publicOrigin}/customer-returns/callback` };
  }

  async authenticate(browserId: string, encodedProof: unknown): Promise<CustomerReturnCustomerSession> {
    const rawQuery = decodeProof(encodedProof);
    const proof = this.verifyProof(rawQuery, this.now());
    if (!proof.state || !proof.customerId) throw customerAuthenticationRequired();
    const shop = await this.requireShop(proof.shop);
    const consumeAt = this.now();
    this.verifyProof(rawQuery, consumeAt);
    const challengeExpiresAt = await this.dependencies.challenges.consume({ stateHash: hash(proof.state), browserHash: hash(browserId),
      shopDomain: proof.shop, now: consumeAt });
    const acceptedAt = this.now();
    // Mapping reads and a contended database lock may outlive the signed proof
    // or browser challenge. Late redemption remains consumed but grants nothing.
    this.verifyProof(rawQuery, acceptedAt);
    if (!(challengeExpiresAt instanceof Date) || !Number.isFinite(challengeExpiresAt.getTime())
      || acceptedAt.getTime() >= challengeExpiresAt.getTime() || acceptedAt.getTime() < consumeAt.getTime()) {
      throw customerAuthenticationRequired();
    }
    return customerReturnCustomerSessionSchema.parse({ channelId: shop.channelId, externalCustomerId: proof.customerId,
      shopDomain: proof.shop, sessionKey: this.storageKey(proof.shop, proof.customerId), authenticatedAt: acceptedAt.getTime(),
      expiresAt: acceptedAt.getTime() + RETURN_SESSION_LIFETIME_MS });
  }

  async principal(raw: unknown): Promise<CustomerReturnCustomerSession> {
    const result = customerReturnCustomerSessionSchema.safeParse(raw);
    const now = this.now().getTime();
    if (!result.success || result.data.authenticatedAt > now || result.data.expiresAt <= now
      || result.data.expiresAt - result.data.authenticatedAt !== RETURN_SESSION_LIFETIME_MS) throw customerAuthenticationRequired();
    const shop = await this.requireShop(result.data.shopDomain);
    if (shop.channelId !== result.data.channelId || this.now().getTime() >= result.data.expiresAt
      || result.data.sessionKey !== this.storageKey(result.data.shopDomain, result.data.externalCustomerId)) throw customerAuthenticationRequired();
    return result.data;
  }

  private verifyProof(rawQuery: string, now: Date): CustomerReturnShopifyProof {
    if (typeof rawQuery !== "string" || Buffer.byteLength(rawQuery, "utf8") > MAX_PROXY_QUERY_BYTES) throw customerAuthenticationRequired();
    // The unverified shop is solely a credential lookup hint. The verifier
    // checks the signature, duplicates, exact shop, timestamp and signed path.
    const candidates = new URLSearchParams(rawQuery).getAll("shop");
    if (candidates.length !== 1 || !customerReturnShopSchema.safeParse(candidates[0]).success
      || !Object.hasOwn(this.dependencies.config.shops, candidates[0])) throw customerAuthenticationRequired();
    const config = this.dependencies.config.shops[candidates[0]];
    const proof = verifyCustomerReturnShopifyProof({ rawQuery, shopifySecret: config.shopifySecret, expectedShop: candidates[0], now });
    if (proof.pathPrefix !== new URL(config.proxyUrl).pathname) throw customerAuthenticationRequired();
    return proof;
  }

  private async requireShop(domain: string): Promise<CustomerReturnInspectionShop> {
    if (!Object.hasOwn(this.dependencies.config.shops, domain)) throw customerAuthenticationRequired();
    const matches = (await this.dependencies.shops()).filter(shop => shop.shopDomain === domain);
    if (matches.length !== 1) throw customerAuthenticationRequired();
    return matches[0];
  }

  private now(): Date {
    const instant = this.dependencies.now();
    if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) {
      throw new CustomerReturnCustomerAccessError("RETURN_CUSTOMER_UNAVAILABLE", "Customer sign-in is temporarily unavailable.", 503);
    }
    return instant;
  }
  private storageKey(shop: string, customerId: string): string {
    // Preserve the original partition across authentication migrations so an
    // uncertain submission keeps its UUID. This is never a login credential.
    return createHmac("sha256", this.dependencies.config.storageSecret).update(`returns-storage:v1:${shop}:${customerId}`).digest("base64url");
  }
}

function decodeProof(raw: unknown): string {
  const parsed = z.string().min(1).max(RETURN_CUSTOMER_ENCODED_PROOF_MAX_LENGTH).regex(/^[A-Za-z0-9_-]+$/).safeParse(raw);
  if (!parsed.success) throw customerAuthenticationRequired();
  const bytes = Buffer.from(parsed.data, "base64url");
  const query = bytes.toString("utf8");
  if (bytes.length > MAX_PROXY_QUERY_BYTES || bytes.toString("base64url") !== parsed.data
    || !Buffer.from(query, "utf8").equals(bytes)) throw customerAuthenticationRequired();
  return query;
}
function hash(value: string): string {
  if (!value || value.length > 1024) throw customerAuthenticationRequired();
  return createHash("sha256").update(value).digest("hex");
}
