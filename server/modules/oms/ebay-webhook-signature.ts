import crypto from "node:crypto";
import type { Request } from "express";
import { z } from "zod";
import { EbayApiRequestError } from "../channels/adapters/ebay/ebay-api-error";
import { logger } from "../../platform/observability/logger";

/**
 * eBay Commerce Notification API — Cryptographic Webhook Signature Verification
 *
 * Per eBay Commerce Notification API contract:
 * 1. `X-EBAY-SIGNATURE` header contains a Base64-encoded JSON object:
 *    `{ alg: "ecdsa", kid: "<public_key_id>", signature: "<base64_signature>", digest: "SHA1" | "SHA256" }`
 * 2. Public keys are retrieved by `kid` from `GET /commerce/notification/v1/public_key/{public_key_id}`:
 *    `{ key: "-----BEGIN PUBLIC KEY-----...-----END PUBLIC KEY-----", algorithm: "ECDSA", digest: "SHA1" | "SHA256" }`
 * 3. Signature is verified against the exact raw HTTP request body bytes (`req.rawBody`).
 */

const ebaySignatureHeaderSchema = z.object({
  alg: z.string().trim().min(1),
  kid: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  signature: z.string().trim().min(1),
  digest: z.string().trim().min(1).optional(),
});

const ebayPublicKeyResponseSchema = z.object({
  key: z.string().trim().min(1),
  algorithm: z.string().trim().min(1).optional(),
  digest: z.string().trim().min(1).optional(),
});

export interface EbayNotificationPublicKeyClient {
  getNotificationPublicKey(publicKeyId: string): Promise<{
    key: string;
    algorithm?: string;
    digest?: string;
  }>;
}

export interface EbayWebhookSignatureVerificationSuccess {
  readonly ok: true;
  readonly keyId: string;
  readonly algorithm: string;
  readonly digest: "sha1" | "sha256";
}

export interface EbayWebhookSignatureVerificationFailure {
  readonly ok: false;
  readonly statusCode: 400 | 401 | 412 | 503;
  readonly code:
    | "EBAY_SIGNATURE_MISSING"
    | "EBAY_SIGNATURE_HEADER_MALFORMED"
    | "EBAY_SIGNATURE_ALGORITHM_UNSUPPORTED"
    | "EBAY_RAW_BODY_MISSING"
    | "EBAY_PUBLIC_KEY_NOT_FOUND"
    | "EBAY_PUBLIC_KEY_INVALID"
    | "EBAY_PUBLIC_KEY_UNAVAILABLE"
    | "EBAY_SIGNATURE_INVALID";
  readonly message: string;
  readonly keyId: string | null;
}

export type EbayWebhookSignatureVerificationResult =
  | EbayWebhookSignatureVerificationSuccess
  | EbayWebhookSignatureVerificationFailure;

export interface EbayWebhookSignatureVerifierOptions {
  readonly cacheTtlMs?: number;
  readonly maxCachedKeys?: number;
  readonly now?: () => number;
}

interface CachedPublicKeyEntry {
  readonly publicKey: crypto.KeyObject;
  readonly digest: "sha1" | "sha256";
  readonly expiresAtMs: number;
}

const DEFAULT_PUBLIC_KEY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour per eBay SDK guidance
const DEFAULT_MAX_CACHED_KEYS = 64;

function normalizePemPublicKey(rawKey: string): string {
  const trimmed = rawKey.trim();
  if (trimmed.includes("-----BEGIN PUBLIC KEY-----")) {
    return trimmed
      .replace(/-----BEGIN PUBLIC KEY-----\s*/, "-----BEGIN PUBLIC KEY-----\n")
      .replace(/\s*-----END PUBLIC KEY-----/, "\n-----END PUBLIC KEY-----");
  }
  return `-----BEGIN PUBLIC KEY-----\n${trimmed}\n-----END PUBLIC KEY-----`;
}

function resolveDigestAlgorithm(
  headerDigest?: string,
  keyDigest?: string,
): "sha1" | "sha256" | null {
  const candidate = (keyDigest || headerDigest || "SHA1").trim().toUpperCase().replace("-", "");
  if (candidate === "SHA1") return "sha1";
  if (candidate === "SHA256") return "sha256";
  return null;
}

function isSupportedSignatureAlgorithm(
  headerAlg: string,
  keyAlg?: string,
): boolean {
  const normalizedHeader = headerAlg.trim().toUpperCase();
  if (normalizedHeader !== "ECDSA") return false;
  if (!keyAlg) return true;
  return keyAlg.trim().toUpperCase() === "ECDSA";
}

function extractRawBodyBuffer(req: Request): Buffer | null {
  const rawBody = (req as Request & { rawBody?: unknown }).rawBody;
  if (Buffer.isBuffer(rawBody) && rawBody.length > 0) {
    return rawBody;
  }
  if (typeof rawBody === "string" && rawBody.length > 0) {
    return Buffer.from(rawBody, "utf8");
  }
  return null;
}

export function createEbayWebhookSignatureVerifier(
  client: EbayNotificationPublicKeyClient,
  options: EbayWebhookSignatureVerifierOptions = {},
) {
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_PUBLIC_KEY_CACHE_TTL_MS;
  const maxCachedKeys = options.maxCachedKeys ?? DEFAULT_MAX_CACHED_KEYS;
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, CachedPublicKeyEntry>();
  const inflight = new Map<string, Promise<CachedPublicKeyEntry>>();

  function evictIfNeeded(currentTimeMs: number): void {
    for (const [kid, entry] of cache.entries()) {
      if (entry.expiresAtMs <= currentTimeMs) {
        cache.delete(kid);
      }
    }
    while (cache.size >= maxCachedKeys) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
  }

  async function resolvePublicKey(
    keyId: string,
    headerAlg: string,
    headerDigest?: string,
  ): Promise<
    | { ok: true; entry: CachedPublicKeyEntry }
    | { ok: false; failure: EbayWebhookSignatureVerificationFailure }
  > {
    const currentTimeMs = now();
    const cached = cache.get(keyId);
    if (cached && cached.expiresAtMs > currentTimeMs) {
      return { ok: true, entry: cached };
    }
    if (cached) {
      cache.delete(keyId);
    }

    let pending = inflight.get(keyId);
    if (!pending) {
      pending = (async () => {
        const response = await client.getNotificationPublicKey(keyId);
        const parsedKey = ebayPublicKeyResponseSchema.safeParse(response);
        if (!parsedKey.success) {
          throw new Error("EBAY_PUBLIC_KEY_RESPONSE_SCHEMA_INVALID");
        }
        if (!isSupportedSignatureAlgorithm(headerAlg, parsedKey.data.algorithm)) {
          const err = new Error("Unsupported eBay public key algorithm");
          (err as any).code = "EBAY_SIGNATURE_ALGORITHM_UNSUPPORTED";
          throw err;
        }
        const digest = resolveDigestAlgorithm(headerDigest, parsedKey.data.digest);
        if (!digest) {
          const err = new Error("Unsupported eBay public key digest");
          (err as any).code = "EBAY_SIGNATURE_ALGORITHM_UNSUPPORTED";
          throw err;
        }
        let publicKey: crypto.KeyObject;
        try {
          publicKey = crypto.createPublicKey(normalizePemPublicKey(parsedKey.data.key));
        } catch {
          const err = new Error("Malformed PEM public key returned by eBay");
          (err as any).code = "EBAY_PUBLIC_KEY_INVALID";
          throw err;
        }
        const entry: CachedPublicKeyEntry = {
          publicKey,
          digest,
          expiresAtMs: now() + cacheTtlMs,
        };
        evictIfNeeded(now());
        cache.set(keyId, entry);
        return entry;
      })().finally(() => {
        inflight.delete(keyId);
      });
      inflight.set(keyId, pending);
    }

    try {
      const entry = await pending;
      return { ok: true, entry };
    } catch (error: any) {
      if (error?.code === "EBAY_SIGNATURE_ALGORITHM_UNSUPPORTED") {
        return {
          ok: false,
          failure: {
            ok: false,
            statusCode: 412,
            code: "EBAY_SIGNATURE_ALGORITHM_UNSUPPORTED",
            message: "Unsupported notification signature algorithm or digest",
            keyId,
          },
        };
      }
      if (error?.code === "EBAY_PUBLIC_KEY_INVALID" || error?.message === "EBAY_PUBLIC_KEY_RESPONSE_SCHEMA_INVALID") {
        return {
          ok: false,
          failure: {
            ok: false,
            statusCode: 412,
            code: "EBAY_PUBLIC_KEY_INVALID",
            message: "Notification public key response was invalid",
            keyId,
          },
        };
      }
      if (error instanceof EbayApiRequestError && (error.statusCode === 400 || error.statusCode === 404)) {
        return {
          ok: false,
          failure: {
            ok: false,
            statusCode: 412,
            code: "EBAY_PUBLIC_KEY_NOT_FOUND",
            message: "Notification public key was not found",
            keyId,
          },
        };
      }
      return {
        ok: false,
        failure: {
          ok: false,
          statusCode: 503,
          code: "EBAY_PUBLIC_KEY_UNAVAILABLE",
          message: "Notification public key verification is temporarily unavailable",
          keyId,
        },
      };
    }
  }

  return async function verifyEbayWebhookSignature(
    req: Request,
  ): Promise<EbayWebhookSignatureVerificationResult> {
    const rawHeader = req.headers["x-ebay-signature"];
    const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (!headerValue || typeof headerValue !== "string" || !headerValue.trim()) {
      logger.warn("oms.ebay_webhook.signature_rejected", {
        module: "oms",
        outcome: "rejected",
        error_code: "EBAY_SIGNATURE_MISSING",
      });
      return {
        ok: false,
        statusCode: 401,
        code: "EBAY_SIGNATURE_MISSING",
        message: "Missing notification signature",
        keyId: null,
      };
    }

    let decodedJson: unknown;
    try {
      const decodedBytes = Buffer.from(headerValue.trim(), "base64");
      if (decodedBytes.length === 0) {
        throw new Error("Empty signature header");
      }
      decodedJson = JSON.parse(decodedBytes.toString("utf8"));
    } catch {
      logger.warn("oms.ebay_webhook.signature_rejected", {
        module: "oms",
        outcome: "rejected",
        error_code: "EBAY_SIGNATURE_HEADER_MALFORMED",
      });
      return {
        ok: false,
        statusCode: 412,
        code: "EBAY_SIGNATURE_HEADER_MALFORMED",
        message: "Malformed notification signature header",
        keyId: null,
      };
    }

    const parsedHeader = ebaySignatureHeaderSchema.safeParse(decodedJson);
    if (!parsedHeader.success) {
      logger.warn("oms.ebay_webhook.signature_rejected", {
        module: "oms",
        outcome: "rejected",
        error_code: "EBAY_SIGNATURE_HEADER_MALFORMED",
      });
      return {
        ok: false,
        statusCode: 412,
        code: "EBAY_SIGNATURE_HEADER_MALFORMED",
        message: "Malformed notification signature header",
        keyId: null,
      };
    }

    const { alg, kid, signature, digest: headerDigest } = parsedHeader.data;
    if (!isSupportedSignatureAlgorithm(alg)) {
      logger.warn("oms.ebay_webhook.signature_rejected", {
        module: "oms",
        outcome: "rejected",
        error_code: "EBAY_SIGNATURE_ALGORITHM_UNSUPPORTED",
        key_id: kid,
      });
      return {
        ok: false,
        statusCode: 412,
        code: "EBAY_SIGNATURE_ALGORITHM_UNSUPPORTED",
        message: "Unsupported notification signature algorithm",
        keyId: kid,
      };
    }

    const rawBody = extractRawBodyBuffer(req);
    if (!rawBody) {
      logger.warn("oms.ebay_webhook.signature_rejected", {
        module: "oms",
        outcome: "rejected",
        error_code: "EBAY_RAW_BODY_MISSING",
        key_id: kid,
      });
      return {
        ok: false,
        statusCode: 400,
        code: "EBAY_RAW_BODY_MISSING",
        message: "Missing raw notification payload for signature verification",
        keyId: kid,
      };
    }

    let signatureBytes: Buffer;
    try {
      signatureBytes = Buffer.from(signature, "base64");
      if (signatureBytes.length === 0) {
        throw new Error("Empty signature bytes");
      }
    } catch {
      logger.warn("oms.ebay_webhook.signature_rejected", {
        module: "oms",
        outcome: "rejected",
        error_code: "EBAY_SIGNATURE_HEADER_MALFORMED",
        key_id: kid,
      });
      return {
        ok: false,
        statusCode: 412,
        code: "EBAY_SIGNATURE_HEADER_MALFORMED",
        message: "Malformed notification signature bytes",
        keyId: kid,
      };
    }

    const keyResolution = await resolvePublicKey(kid, alg, headerDigest);
    if (!keyResolution.ok) {
      logger.warn("oms.ebay_webhook.signature_rejected", {
        module: "oms",
        outcome: "rejected",
        error_code: keyResolution.failure.code,
        key_id: kid,
      });
      return keyResolution.failure;
    }

    let verified = false;
    try {
      verified = crypto.verify(
        keyResolution.entry.digest,
        rawBody,
        keyResolution.entry.publicKey,
        signatureBytes,
      );
    } catch {
      verified = false;
    }

    if (!verified) {
      logger.warn("oms.ebay_webhook.signature_rejected", {
        module: "oms",
        outcome: "rejected",
        error_code: "EBAY_SIGNATURE_INVALID",
        key_id: kid,
      });
      return {
        ok: false,
        statusCode: 412,
        code: "EBAY_SIGNATURE_INVALID",
        message: "Invalid notification signature",
        keyId: kid,
      };
    }

    return {
      ok: true,
      keyId: kid,
      algorithm: "ECDSA",
      digest: keyResolution.entry.digest,
    };
  };
}
