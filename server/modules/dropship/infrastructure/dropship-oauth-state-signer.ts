import { createHmac, timingSafeEqual } from "crypto";
import { DropshipError } from "../domain/errors";
import type { DropshipOAuthStatePayload, DropshipOAuthStateSigner } from "../application/dropship-store-connection-service";

export class HmacDropshipOAuthStateSigner implements DropshipOAuthStateSigner {
  constructor(private readonly secret: string) {
    if (!secret || secret.length < 32) {
      throw new DropshipError(
        "DROPSHIP_OAUTH_STATE_SECRET_REQUIRED",
        "Dropship OAuth state signing secret must be at least 32 characters.",
      );
    }
  }

  sign(payload: DropshipOAuthStatePayload): string {
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    return `${encodedPayload}.${this.signPayload(encodedPayload)}`;
  }

  verify(state: string, now: Date): DropshipOAuthStatePayload {
    const [encodedPayload, signature, extra] = state.split(".");
    if (!encodedPayload || !signature || extra !== undefined) {
      throw new DropshipError("DROPSHIP_INVALID_OAUTH_STATE", "Store authorization state is malformed.");
    }

    const expected = this.signPayload(encodedPayload);
    if (!safeEqual(signature, expected)) {
      throw new DropshipError("DROPSHIP_INVALID_OAUTH_STATE", "Store authorization state signature is invalid.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    } catch {
      throw new DropshipError("DROPSHIP_INVALID_OAUTH_STATE", "Store authorization state payload is invalid.");
    }
    if (!isRecord(parsed)) {
      throw new DropshipError("DROPSHIP_INVALID_OAUTH_STATE", "Store authorization state payload is invalid.");
    }
    const payload = parsed as unknown as DropshipOAuthStatePayload;
    const intent = payload.intent ?? "connect";
    if (
      payload.version !== 1
      || !Number.isInteger(payload.vendorId)
      || payload.vendorId <= 0
      || typeof payload.memberId !== "string"
      || payload.memberId.length === 0
      || (payload.platform !== "ebay" && payload.platform !== "shopify")
      || !["connect", "refresh_connection", "change_store"].includes(intent)
      || typeof payload.expiresAt !== "string"
      || Number.isNaN(new Date(payload.expiresAt).getTime())
      || !isValidOptionalTargetId(payload.targetStoreConnectionId)
      || !isValidOptionalFingerprint(payload.targetConnectionFingerprint)
      || !isValidOptionalDate(payload.targetConnectionUpdatedAt)
    ) {
      throw new DropshipError("DROPSHIP_INVALID_OAUTH_STATE", "Store authorization state payload is invalid.");
    }

    if (new Date(payload.expiresAt).getTime() <= now.getTime()) {
      throw new DropshipError("DROPSHIP_OAUTH_STATE_EXPIRED", "Store authorization state has expired.");
    }

    return payload;
  }

  private signPayload(encodedPayload: string): string {
    return createHmac("sha256", this.secret).update(encodedPayload).digest("base64url");
  }
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidOptionalTargetId(value: number | null | undefined): boolean {
  return value === undefined || value === null || (Number.isInteger(value) && value > 0);
}

function isValidOptionalFingerprint(value: string | null | undefined): boolean {
  return value === undefined || value === null || /^[0-9a-f]{32}$/.test(value);
}

function isValidOptionalDate(value: string | null | undefined): boolean {
  return value === undefined || value === null || (typeof value === "string" && !Number.isNaN(new Date(value).getTime()));
}
