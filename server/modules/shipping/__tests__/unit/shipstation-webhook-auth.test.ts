import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  CachedShipStationJwksProvider,
  ShipStationWebhookAuthError,
  createShipStationWebhookSignatureVerifier,
} from "../../shipstation-webhook-auth";

const now = new Date("2026-07-20T12:00:00.000Z");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function signature(timestamp: string, rawBody: Buffer): string {
  const signer = createSign("RSA-SHA256");
  signer.update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), rawBody]));
  signer.end();
  return signer.sign(privateKey, "base64");
}

function verifier() {
  return createShipStationWebhookSignatureVerifier({
    now: () => new Date(now),
    jwksProvider: {
      getPublicKey: async (keyId) => keyId === "test-key" ? publicKey : null,
    },
  });
}

describe("ShipStation tracking webhook authentication", () => {
  it("verifies the exact timestamp and raw request bytes", async () => {
    const rawBody = Buffer.from('{"resource_type":"API_TRACK"}', "utf8");
    const timestamp = now.toISOString();
    const signed = signature(timestamp, rawBody);
    await expect(verifier().verify({
      headers: { keyId: "test-key", timestamp, signature: signed },
      rawBody,
    })).resolves.toMatchObject({
      provider: "shipstation",
      signatureAlgorithm: "RSA-SHA256",
      signatureKeyId: "test-key",
      signatureTimestampRaw: timestamp,
      signatureTimestampAt: now,
      rawBodyBase64: rawBody.toString("base64"),
      rawBodyHash: createHash("sha256").update(rawBody).digest("hex"),
      signatureBase64: signed,
      signatureHash: createHash("sha256").update(signed, "utf8").digest("hex"),
      verifiedAt: now,
    });
  });

  it("rejects a body changed after signing", async () => {
    const signedBody = Buffer.from('{"resource_type":"API_TRACK"}', "utf8");
    const receivedBody = Buffer.from('{"resource_type":"API_TRACK","changed":true}', "utf8");
    const timestamp = now.toISOString();
    await expect(verifier().verify({
      headers: { keyId: "test-key", timestamp, signature: signature(timestamp, signedBody) },
      rawBody: receivedBody,
    })).rejects.toMatchObject<Partial<ShipStationWebhookAuthError>>({
      code: "SHIPSTATION_WEBHOOK_SIGNATURE_INVALID",
      httpStatus: 401,
    });
  });

  it("rejects replayed timestamps outside the accepted window", async () => {
    const rawBody = Buffer.from("{}", "utf8");
    const timestamp = "2026-07-20T11:54:59.000Z";
    await expect(verifier().verify({
      headers: { keyId: "test-key", timestamp, signature: signature(timestamp, rawBody) },
      rawBody,
    })).rejects.toMatchObject<Partial<ShipStationWebhookAuthError>>({
      code: "SHIPSTATION_WEBHOOK_TIMESTAMP_OUT_OF_RANGE",
      httpStatus: 400,
    });
  });

  it("returns not-found semantics when signature headers are absent", async () => {
    await expect(verifier().verify({
      headers: { keyId: null, timestamp: null, signature: null },
      rawBody: Buffer.from("{}"),
    })).rejects.toMatchObject<Partial<ShipStationWebhookAuthError>>({
      code: "SHIPSTATION_WEBHOOK_SIGNATURE_HEADERS_MISSING",
      httpStatus: 404,
    });
  });

  it("rejects oversized or malformed signature headers before key lookup", async () => {
    const rawBody = Buffer.from("{}", "utf8");
    const timestamp = now.toISOString();
    await expect(verifier().verify({
      headers: { keyId: "test-key", timestamp, signature: "not base64!" },
      rawBody,
    })).rejects.toMatchObject<Partial<ShipStationWebhookAuthError>>({
      code: "SHIPSTATION_WEBHOOK_SIGNATURE_HEADERS_INVALID",
      httpStatus: 400,
    });
    await expect(verifier().verify({
      headers: { keyId: "x".repeat(501), timestamp, signature: "AAAA" },
      rawBody,
    })).rejects.toMatchObject<Partial<ShipStationWebhookAuthError>>({
      code: "SHIPSTATION_WEBHOOK_SIGNATURE_HEADERS_INVALID",
      httpStatus: 400,
    });
  });

  it("rejects verification when the exact raw body is unavailable", async () => {
    const timestamp = now.toISOString();
    await expect(verifier().verify({
      headers: { keyId: "test-key", timestamp, signature: "unused" },
      rawBody: undefined,
    })).rejects.toMatchObject<Partial<ShipStationWebhookAuthError>>({
      code: "SHIPSTATION_WEBHOOK_RAW_BODY_MISSING",
      httpStatus: 400,
    });
  });
});

describe("ShipStation JWKS caching", () => {
  it("bounds forced refreshes for changing unknown key ids", async () => {
    const publicJwk = publicKey.export({ format: "jwk" });
    let fetchCount = 0;
    const provider = new CachedShipStationJwksProvider({
      now: () => new Date(now),
      unknownKeyRefreshIntervalMs: 60_000,
      fetch: async () => {
        fetchCount += 1;
        return new Response(JSON.stringify({
          keys: [{ ...publicJwk, kid: "known-key", alg: "RS256", use: "sig" }],
        }), {
          status: 200,
          headers: { "content-type": "application/json", etag: `\"keys-${fetchCount}\"` },
        });
      },
    });

    await expect(provider.getPublicKey("known-key")).resolves.not.toBeNull();
    await expect(provider.getPublicKey("unknown-one")).resolves.toBeNull();
    await expect(provider.getPublicKey("unknown-two")).resolves.toBeNull();

    expect(fetchCount).toBe(2);
  });
});
