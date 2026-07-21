import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { canonicalJson } from "@shared/utils/canonical-json";

import type { VerifiedCarrierWebhookReceipt } from "./carrier-tracking.domain";
import {
  assertValidShipStationTrackingWebhookSecret,
  resolveShipStationTrackingWebhookSecret,
  SHIPSTATION_TRACKING_WEBHOOK_SECRET_KEY_ID,
} from "./shipstation-tracking-api-config";

export type ShipStationWebhookAuthErrorCode =
  | "SHIPSTATION_WEBHOOK_RAW_BODY_MISSING"
  | "SHIPSTATION_WEBHOOK_SHARED_SECRET_MISSING"
  | "SHIPSTATION_WEBHOOK_SHARED_SECRET_INVALID"
  | "SHIPSTATION_WEBHOOK_SHARED_SECRET_NOT_CONFIGURED";

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

export interface ShipStationWebhookAuthenticationHeaders {
  sharedSecret: string | null;
}

export interface ShipStationWebhookVerifier {
  verify(input: {
    headers: ShipStationWebhookAuthenticationHeaders;
    rawBody: unknown;
  }): Promise<VerifiedCarrierWebhookReceipt>;
}

/**
 * Authenticate ShipStation V2's operator-defined webhook header. The HMAC is
 * an internal receipt attestation over the exact request bytes; ShipStation
 * does not send it and the configured shared secret is never persisted.
 */
export function createShipStationV2WebhookVerifier(input: {
  sharedSecret: string;
  now: () => Date;
}): ShipStationWebhookVerifier {
  const expectedSecret = input.sharedSecret.trim();
  assertValidShipStationTrackingWebhookSecret(expectedSecret);
  const expectedSecretDigest = createHash("sha256").update(expectedSecret, "utf8").digest();

  return {
    async verify({ headers, rawBody }) {
      const providedSecret = headers.sharedSecret;
      if (!providedSecret) {
        throw new ShipStationWebhookAuthError(
          "SHIPSTATION_WEBHOOK_SHARED_SECRET_MISSING",
          "Required ShipStation V2 webhook authentication header is missing",
          404,
        );
      }
      if (providedSecret.length > 512 || !/^[\x21-\x7E]+$/.test(providedSecret)) {
        throw new ShipStationWebhookAuthError(
          "SHIPSTATION_WEBHOOK_SHARED_SECRET_INVALID",
          "ShipStation V2 webhook authentication header has an invalid shape",
          400,
        );
      }
      const providedSecretDigest = createHash("sha256")
        .update(providedSecret, "utf8")
        .digest();
      if (!timingSafeEqual(providedSecretDigest, expectedSecretDigest)) {
        throw new ShipStationWebhookAuthError(
          "SHIPSTATION_WEBHOOK_SHARED_SECRET_INVALID",
          "ShipStation V2 webhook authentication failed",
          401,
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
      if (Number.isNaN(verifiedAt.getTime())) {
        throw new ShipStationWebhookAuthError(
          "SHIPSTATION_WEBHOOK_SHARED_SECRET_NOT_CONFIGURED",
          "ShipStation V2 webhook verification clock returned an invalid timestamp",
          503,
        );
      }
      const rawBodyHash = sha256(rawBody);
      const authenticationCode = createHmac("sha256", expectedSecret)
        .update(rawBody)
        .digest();
      const signatureHash = sha256(authenticationCode);
      const receiptHash = sha256(Buffer.from(canonicalJson({
        provider: "shipstation",
        authenticationScheme: "HMAC-SHA256",
        authenticationKeyId: SHIPSTATION_TRACKING_WEBHOOK_SECRET_KEY_ID,
        rawBodyHash,
        signatureHash,
      }), "utf8"));
      const verifiedAtText = verifiedAt.toISOString();

      return {
        provider: "shipstation",
        receiptHash,
        signatureAlgorithm: "HMAC-SHA256",
        signatureKeyId: SHIPSTATION_TRACKING_WEBHOOK_SECRET_KEY_ID,
        signatureTimestampRaw: verifiedAtText,
        signatureTimestampAt: verifiedAt,
        rawBodyBase64: rawBody.toString("base64"),
        rawBodyHash,
        signatureBase64: authenticationCode.toString("base64"),
        signatureHash,
        verifiedAt,
      };
    },
  };
}

/** Missing or malformed configuration hides the public route and fails closed. */
export function createDefaultShipStationV2WebhookVerifier(
  now: () => Date = () => new Date(),
): ShipStationWebhookVerifier {
  const sharedSecret = resolveShipStationTrackingWebhookSecret();
  if (!sharedSecret) return unavailableShipStationV2WebhookVerifier();
  try {
    return createShipStationV2WebhookVerifier({ sharedSecret, now });
  } catch {
    return unavailableShipStationV2WebhookVerifier();
  }
}

function unavailableShipStationV2WebhookVerifier(): ShipStationWebhookVerifier {
  return {
    async verify() {
      throw new ShipStationWebhookAuthError(
        "SHIPSTATION_WEBHOOK_SHARED_SECRET_NOT_CONFIGURED",
        "SHIPSTATION_TRACKING_WEBHOOK_SECRET is not configured with a valid value",
        404,
      );
    },
  };
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
