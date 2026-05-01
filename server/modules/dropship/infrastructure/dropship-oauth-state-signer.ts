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

    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as DropshipOAuthStatePayload;
    if (payload.version !== 1 || !payload.vendorId || !payload.memberId || !payload.platform || !payload.expiresAt) {
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
