import { createCipheriv, randomBytes, randomUUID } from "crypto";
import { DropshipError } from "../domain/errors";
import type {
  DropshipStoreConnectionTokenRecord,
  DropshipStoreTokenCipher,
} from "../application/dropship-store-connection-service";
import type { DropshipSupportedStorePlatform } from "../domain/store-connection";

export class AesGcmDropshipStoreTokenCipher implements DropshipStoreTokenCipher {
  constructor(
    private readonly key: Buffer,
    private readonly keyId: string,
  ) {
    if (key.length !== 32) {
      throw new DropshipError("DROPSHIP_TOKEN_KEY_INVALID", "Dropship token encryption key must be 32 bytes.");
    }
  }

  static fromEnv(): AesGcmDropshipStoreTokenCipher {
    const rawKey = process.env.DROPSHIP_TOKEN_ENCRYPTION_KEY;
    if (!rawKey) {
      throw new DropshipError(
        "DROPSHIP_TOKEN_VAULT_NOT_CONFIGURED",
        "DROPSHIP_TOKEN_ENCRYPTION_KEY is required for dropship store OAuth.",
      );
    }

    const key = parseEncryptionKey(rawKey);
    const keyId = process.env.DROPSHIP_TOKEN_KEY_ID || "dropship-token-key-v1";
    return new AesGcmDropshipStoreTokenCipher(key, keyId);
  }

  seal(input: {
    tokenKind: "access" | "refresh";
    token: string;
    vendorId: number;
    platform: DropshipSupportedStorePlatform;
    expiresAt: Date | null;
  }): DropshipStoreConnectionTokenRecord {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`${input.vendorId}:${input.platform}:${input.tokenKind}`, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(input.token, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return {
      tokenKind: input.tokenKind,
      tokenRef: `dst_${input.platform}_${input.tokenKind}_${randomUUID().replace(/-/g, "")}`,
      keyId: this.keyId,
      ciphertext: ciphertext.toString("base64url"),
      iv: iv.toString("base64url"),
      authTag: authTag.toString("base64url"),
      expiresAt: input.expiresAt,
    };
  }
}

function parseEncryptionKey(rawKey: string): Buffer {
  const trimmed = rawKey.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  const key = Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new DropshipError(
      "DROPSHIP_TOKEN_KEY_INVALID",
      "DROPSHIP_TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as base64 or hex.",
    );
  }
  return key;
}
