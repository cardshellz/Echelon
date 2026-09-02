import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type {
  FulfillmentProviderConnectionCatalogState,
  FulfillmentProviderCredentialCipher,
  FulfillmentProviderCredentialRecord,
} from "../application/connected-fulfillment-method-catalog.service";

export class FulfillmentProviderCredentialVaultError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FulfillmentProviderCredentialVaultError";
  }
}

export class AesGcmFulfillmentProviderCredentialCipher
implements FulfillmentProviderCredentialCipher {
  private readonly key: Buffer;
  private readonly keyId: string;

  constructor(
    key: Buffer,
    keyId: string,
    private readonly generateIv: () => Buffer = () => randomBytes(12),
  ) {
    if (key.length !== 32) {
      throw new FulfillmentProviderCredentialVaultError(
        "SHIPPING_FULFILLMENT_PROVIDER_CREDENTIAL_KEY_INVALID",
        "Fulfillment provider credential encryption key must be 32 bytes.",
      );
    }
    if (!keyId.trim() || keyId.length > 120) {
      throw new FulfillmentProviderCredentialVaultError(
        "SHIPPING_FULFILLMENT_PROVIDER_CREDENTIAL_KEY_ID_INVALID",
        "Fulfillment provider credential key id must contain between 1 and 120 characters.",
      );
    }
    this.key = Buffer.from(key);
    this.keyId = keyId.trim();
  }

  static fromEnvOrNull(
    environment: Readonly<Record<string, string | undefined>> = process.env,
  ): AesGcmFulfillmentProviderCredentialCipher | null {
    const rawKey = environment.SHIPPING_PROVIDER_CREDENTIAL_ENCRYPTION_KEY?.trim();
    if (!rawKey) return null;
    return new AesGcmFulfillmentProviderCredentialCipher(
      parseEncryptionKey(rawKey),
      environment.SHIPPING_PROVIDER_CREDENTIAL_KEY_ID?.trim()
        || "shipping-provider-credential-key-v1",
    );
  }

  seal(input: {
    connectionId: number;
    provider: string;
    credential: string;
  }): FulfillmentProviderCredentialRecord {
    validateIdentity(input.connectionId, input.provider);
    if (!input.credential.trim()) {
      throw new FulfillmentProviderCredentialVaultError(
        "SHIPPING_FULFILLMENT_PROVIDER_CREDENTIAL_INVALID",
        "Fulfillment provider credential cannot be empty.",
      );
    }
    const iv = Buffer.from(this.generateIv());
    if (iv.length !== 12) {
      throw new FulfillmentProviderCredentialVaultError(
        "SHIPPING_FULFILLMENT_PROVIDER_CREDENTIAL_IV_INVALID",
        "Fulfillment provider credential IV generator must return exactly 12 bytes.",
      );
    }
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(aad(input.connectionId, input.provider));
    const ciphertext = Buffer.concat([
      cipher.update(input.credential, "utf8"),
      cipher.final(),
    ]);
    return {
      connectionId: input.connectionId,
      keyId: this.keyId,
      ciphertext: ciphertext.toString("base64url"),
      iv: iv.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
    };
  }

  open(input: {
    connection: FulfillmentProviderConnectionCatalogState;
    credential: FulfillmentProviderCredentialRecord;
  }): string {
    validateIdentity(input.connection.id, input.connection.provider);
    if (input.credential.connectionId !== input.connection.id) {
      throw new FulfillmentProviderCredentialVaultError(
        "SHIPPING_FULFILLMENT_PROVIDER_CREDENTIAL_SCOPE_MISMATCH",
        "Encrypted fulfillment provider credential belongs to a different connection.",
      );
    }
    if (input.credential.keyId !== this.keyId) {
      throw new FulfillmentProviderCredentialVaultError(
        "SHIPPING_FULFILLMENT_PROVIDER_CREDENTIAL_KEY_MISMATCH",
        "Encrypted fulfillment provider credential key id does not match the active key.",
      );
    }
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(input.credential.iv, "base64url"),
      );
      decipher.setAAD(aad(input.connection.id, input.connection.provider));
      decipher.setAuthTag(Buffer.from(input.credential.authTag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(input.credential.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch (error) {
      if (error instanceof FulfillmentProviderCredentialVaultError) throw error;
      throw new FulfillmentProviderCredentialVaultError(
        "SHIPPING_FULFILLMENT_PROVIDER_CREDENTIAL_DECRYPTION_FAILED",
        "Encrypted fulfillment provider credential could not be decrypted.",
      );
    }
  }
}

function parseEncryptionKey(rawKey: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(rawKey)) return Buffer.from(rawKey, "hex");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(rawKey) || rawKey.length % 4 === 1) {
    throw invalidEncryptionKey();
  }
  const key = Buffer.from(rawKey, "base64");
  const normalizedInput = rawKey.replace(/=+$/, "");
  const normalizedDecoded = key.toString("base64").replace(/=+$/, "");
  if (key.length !== 32 || normalizedInput !== normalizedDecoded) throw invalidEncryptionKey();
  return key;
}

function invalidEncryptionKey(): FulfillmentProviderCredentialVaultError {
  return new FulfillmentProviderCredentialVaultError(
    "SHIPPING_FULFILLMENT_PROVIDER_CREDENTIAL_KEY_INVALID",
    "SHIPPING_PROVIDER_CREDENTIAL_ENCRYPTION_KEY must be 32 bytes encoded as base64 or hex.",
  );
}

function validateIdentity(connectionId: number, provider: string): void {
  if (!Number.isSafeInteger(connectionId) || connectionId <= 0 || !provider.trim()) {
    throw new FulfillmentProviderCredentialVaultError(
      "SHIPPING_FULFILLMENT_PROVIDER_CREDENTIAL_SCOPE_INVALID",
      "Fulfillment provider credential scope is invalid.",
    );
  }
}

function aad(connectionId: number, provider: string): Buffer {
  return Buffer.from(`shipping-provider:${connectionId}:${provider.trim()}:api-key`, "utf8");
}
