import { createHash, createPublicKey, createVerify, type KeyObject } from "node:crypto";
import { z } from "zod";

import type { VerifiedCarrierWebhookReceipt } from "./carrier-tracking.domain";

const DEFAULT_JWKS_URL = "https://api.shipengine.com/jwks";
const DEFAULT_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const DEFAULT_JWKS_CACHE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_JWKS_TIMEOUT_MS = 3_000;
const DEFAULT_UNKNOWN_KEY_REFRESH_INTERVAL_MS = 60 * 1_000;
const MAX_SIGNATURE_KEY_ID_LENGTH = 500;
const MAX_SIGNATURE_LENGTH = 4_096;
const MAX_SIGNATURE_TIMESTAMP_LENGTH = 100;

const jwkSchema = z.object({
  kid: z.string().trim().min(1).max(500),
  kty: z.literal("RSA"),
  n: z.string().trim().min(1),
  e: z.string().trim().min(1),
  alg: z.string().trim().min(1).optional(),
  use: z.string().trim().min(1).optional(),
}).passthrough();

const jwksSchema = z.object({
  keys: z.array(jwkSchema).min(1).max(100),
}).strict();

type ShipStationJwk = z.infer<typeof jwkSchema>;
type FetchFunction = (input: string, init?: RequestInit) => Promise<Response>;

export type ShipStationWebhookAuthErrorCode =
  | "SHIPSTATION_WEBHOOK_SIGNATURE_HEADERS_MISSING"
  | "SHIPSTATION_WEBHOOK_SIGNATURE_HEADERS_INVALID"
  | "SHIPSTATION_WEBHOOK_TIMESTAMP_INVALID"
  | "SHIPSTATION_WEBHOOK_TIMESTAMP_OUT_OF_RANGE"
  | "SHIPSTATION_WEBHOOK_RAW_BODY_MISSING"
  | "SHIPSTATION_WEBHOOK_SIGNING_KEY_UNAVAILABLE"
  | "SHIPSTATION_WEBHOOK_SIGNATURE_INVALID"
  | "SHIPSTATION_WEBHOOK_JWKS_UNAVAILABLE";

export class ShipStationWebhookAuthError extends Error {
  constructor(
    readonly code: ShipStationWebhookAuthErrorCode,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "ShipStationWebhookAuthError";
  }
}

export interface ShipStationWebhookSignatureHeaders {
  keyId: string | null;
  signature: string | null;
  timestamp: string | null;
}

export interface ShipStationJwksProvider {
  getPublicKey(keyId: string): Promise<KeyObject | null>;
}

export interface ShipStationWebhookSignatureVerifier {
  verify(input: {
    headers: ShipStationWebhookSignatureHeaders;
    rawBody: unknown;
  }): Promise<VerifiedCarrierWebhookReceipt>;
}

export class CachedShipStationJwksProvider implements ShipStationJwksProvider {
  private cachedKeys = new Map<string, KeyObject>();
  private cachedEtag: string | null = null;
  private expiresAtMs = 0;
  private refreshPromise: Promise<void> | null = null;
  private lastUnknownKeyRefreshAtMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly dependencies: {
      fetch: FetchFunction;
      now: () => Date;
      jwksUrl?: string;
      cacheTtlMs?: number;
      requestTimeoutMs?: number;
      unknownKeyRefreshIntervalMs?: number;
    },
  ) {}

  async getPublicKey(keyId: string): Promise<KeyObject | null> {
    const nowMs = this.dependencies.now().getTime();
    const cached = this.cachedKeys.get(keyId);
    if (cached && nowMs < this.expiresAtMs) return cached;

    if (this.cachedKeys.size === 0 || nowMs >= this.expiresAtMs) {
      await this.refresh(false);
    }
    const refreshed = this.cachedKeys.get(keyId);
    if (refreshed) return refreshed;

    // A key rotation can occur while an ETag-backed cache is still current.
    // Retry without If-None-Match at a bounded cadence when the requested key
    // is absent. This preserves rotation recovery without letting changing,
    // unauthenticated key ids force a JWKS fetch for every request.
    const refreshIntervalMs = this.dependencies.unknownKeyRefreshIntervalMs
      ?? DEFAULT_UNKNOWN_KEY_REFRESH_INTERVAL_MS;
    const currentMs = this.dependencies.now().getTime();
    if (currentMs - this.lastUnknownKeyRefreshAtMs < refreshIntervalMs) return null;
    this.lastUnknownKeyRefreshAtMs = currentMs;
    await this.refresh(true);
    return this.cachedKeys.get(keyId) ?? null;
  }

  private async refresh(forceFullFetch: boolean): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.fetchAndCache(forceFullFetch).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async fetchAndCache(forceFullFetch: boolean): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.dependencies.requestTimeoutMs ?? DEFAULT_JWKS_TIMEOUT_MS,
    );
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (!forceFullFetch && this.cachedEtag) headers["if-none-match"] = this.cachedEtag;
      const response = await this.dependencies.fetch(
        this.dependencies.jwksUrl ?? DEFAULT_JWKS_URL,
        { method: "GET", headers, signal: controller.signal },
      );
      if (response.status === 304 && this.cachedKeys.size > 0) {
        this.expiresAtMs = this.dependencies.now().getTime()
          + (this.dependencies.cacheTtlMs ?? DEFAULT_JWKS_CACHE_MS);
        return;
      }
      if (!response.ok) {
        throw new Error(`JWKS endpoint returned HTTP ${response.status}`);
      }
      const parsed = jwksSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error("JWKS endpoint returned an invalid key set");
      }
      this.cachedKeys = new Map(parsed.data.keys.map((jwk) => [jwk.kid, publicKeyFromJwk(jwk)]));
      this.cachedEtag = response.headers.get("etag");
      this.expiresAtMs = this.dependencies.now().getTime()
        + (this.dependencies.cacheTtlMs ?? DEFAULT_JWKS_CACHE_MS);
    } catch (error) {
      throw new ShipStationWebhookAuthError(
        "SHIPSTATION_WEBHOOK_JWKS_UNAVAILABLE",
        error instanceof Error ? error.message : "ShipStation JWKS could not be retrieved",
        503,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createShipStationWebhookSignatureVerifier(input: {
  jwksProvider: ShipStationJwksProvider;
  now: () => Date;
  maxClockSkewMs?: number;
}): ShipStationWebhookSignatureVerifier {
  return {
    async verify({ headers, rawBody }) {
      const { keyId, signature, timestamp } = headers;
      if (!keyId || !signature || !timestamp) {
        throw new ShipStationWebhookAuthError(
          "SHIPSTATION_WEBHOOK_SIGNATURE_HEADERS_MISSING",
          "Required ShipStation webhook signature headers are missing",
          404,
        );
      }
      if (keyId.length > MAX_SIGNATURE_KEY_ID_LENGTH
          || signature.length > MAX_SIGNATURE_LENGTH
          || timestamp.length > MAX_SIGNATURE_TIMESTAMP_LENGTH
          || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
        throw new ShipStationWebhookAuthError(
          "SHIPSTATION_WEBHOOK_SIGNATURE_HEADERS_INVALID",
          "ShipStation webhook signature headers have an invalid shape",
          400,
        );
      }
      if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
        throw new ShipStationWebhookAuthError(
          "SHIPSTATION_WEBHOOK_RAW_BODY_MISSING",
          "The unmodified webhook request body is required",
          400,
        );
      }

      const verifiedAt = input.now();
      const webhookTime = new Date(timestamp);
      if (Number.isNaN(webhookTime.getTime())) {
        throw new ShipStationWebhookAuthError(
          "SHIPSTATION_WEBHOOK_TIMESTAMP_INVALID",
          "ShipStation webhook timestamp is invalid",
          400,
        );
      }
      const skew = Math.abs(verifiedAt.getTime() - webhookTime.getTime());
      if (skew > (input.maxClockSkewMs ?? DEFAULT_CLOCK_SKEW_MS)) {
        throw new ShipStationWebhookAuthError(
          "SHIPSTATION_WEBHOOK_TIMESTAMP_OUT_OF_RANGE",
          "ShipStation webhook timestamp is outside the accepted replay window",
          400,
        );
      }

      const publicKey = await input.jwksProvider.getPublicKey(keyId);
      if (!publicKey) {
        throw new ShipStationWebhookAuthError(
          "SHIPSTATION_WEBHOOK_SIGNING_KEY_UNAVAILABLE",
          "ShipStation webhook signing key was not found",
          401,
        );
      }
      const verifier = createVerify("RSA-SHA256");
      verifier.update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), rawBody]));
      verifier.end();
      if (!verifier.verify(publicKey, signature, "base64")) {
        throw new ShipStationWebhookAuthError(
          "SHIPSTATION_WEBHOOK_SIGNATURE_INVALID",
          "ShipStation webhook signature is invalid",
          401,
        );
      }


      const rawBodyHash = sha256(rawBody);
      const signatureHash = sha256(Buffer.from(signature, "utf8"));
      const receiptHash = sha256(Buffer.from(JSON.stringify({
        provider: "shipstation",
        signatureAlgorithm: "RSA-SHA256",
        signatureKeyId: keyId,
        signatureTimestampRaw: timestamp,
        rawBodyHash,
        signatureHash,
      }), "utf8"));
      return {
        provider: "shipstation",
        receiptHash,
        signatureAlgorithm: "RSA-SHA256",
        signatureKeyId: keyId,
        signatureTimestampRaw: timestamp,
        signatureTimestampAt: webhookTime,
        rawBodyBase64: rawBody.toString("base64"),
        rawBodyHash,
        signatureBase64: signature,
        signatureHash,
        verifiedAt,
      };
    },
  };
}

export function createDefaultShipStationWebhookSignatureVerifier(
  now: () => Date = () => new Date(),
): ShipStationWebhookSignatureVerifier {
  const jwksProvider = new CachedShipStationJwksProvider({ fetch, now });
  return createShipStationWebhookSignatureVerifier({ jwksProvider, now });
}

function publicKeyFromJwk(jwk: ShipStationJwk): KeyObject {
  return createPublicKey({
    key: {
      kty: jwk.kty,
      n: jwk.n,
      e: jwk.e,
      ...(jwk.alg ? { alg: jwk.alg } : {}),
      ...(jwk.use ? { use: jwk.use } : {}),
    },
    format: "jwk",
  });
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
