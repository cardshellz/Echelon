import { describe, expect, it } from "vitest";
import {
  AesGcmFulfillmentProviderCredentialCipher,
  FulfillmentProviderCredentialVaultError,
} from "../../infrastructure/fulfillment-provider-credential-cipher";

describe("AesGcmFulfillmentProviderCredentialCipher", () => {
  it("round-trips a credential only in its connection and provider scope", () => {
    const cipher = new AesGcmFulfillmentProviderCredentialCipher(
      Buffer.alloc(32, 7),
      "key-1",
      () => Buffer.alloc(12, 3),
    );
    const credential = cipher.seal({
      connectionId: 11,
      provider: "shipstation_v2",
      credential: "secret-api-key",
    });

    expect(credential.ciphertext).not.toContain("secret-api-key");
    expect(cipher.open({
      connection: connection(),
      credential,
    })).toBe("secret-api-key");
    expect(() => cipher.open({
      connection: { ...connection(), provider: "future_provider" },
      credential,
    })).toThrow(FulfillmentProviderCredentialVaultError);
  });

  it("returns null when the dedicated vault key is absent", () => {
    expect(AesGcmFulfillmentProviderCredentialCipher.fromEnvOrNull({})).toBeNull();
  });

  it("rejects an invalid configured key rather than silently weakening encryption", () => {
    expect(() => AesGcmFulfillmentProviderCredentialCipher.fromEnvOrNull({
      SHIPPING_PROVIDER_CREDENTIAL_ENCRYPTION_KEY: "too-short",
    })).toThrowError(expect.objectContaining({
      code: "SHIPPING_FULFILLMENT_PROVIDER_CREDENTIAL_KEY_INVALID",
    }));
    expect(() => AesGcmFulfillmentProviderCredentialCipher.fromEnvOrNull({
      SHIPPING_PROVIDER_CREDENTIAL_ENCRYPTION_KEY: `${Buffer.alloc(32, 7).toString("base64")}!`,
    })).toThrowError(expect.objectContaining({
      code: "SHIPPING_FULFILLMENT_PROVIDER_CREDENTIAL_KEY_INVALID",
    }));
  });

  it("rejects an invalid IV source before encrypting", () => {
    const cipher = new AesGcmFulfillmentProviderCredentialCipher(
      Buffer.alloc(32, 7),
      "key-1",
      () => Buffer.alloc(8),
    );

    expect(() => cipher.seal({
      connectionId: 11,
      provider: "shipstation_v2",
      credential: "secret-api-key",
    })).toThrowError(expect.objectContaining({
      code: "SHIPPING_FULFILLMENT_PROVIDER_CREDENTIAL_IV_INVALID",
    }));
  });
});

function connection() {
  return {
    id: 11,
    provider: "shipstation_v2",
    name: "Primary ShipStation",
    status: "active" as const,
    credentialSource: "vault" as const,
    credentialRef: null,
    revision: 1,
  };
}
