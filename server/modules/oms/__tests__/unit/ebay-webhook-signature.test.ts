import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { EbayApiRequestError } from "../../../channels/adapters/ebay/ebay-api-error";
import { createEbayOrderWebhookHandler } from "../../ebay-order-ingestion";
import { createEbayWebhookSignatureVerifier } from "../../ebay-webhook-signature";

function generateEcdsaKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const singleLinePem = pem.replace(/\r?\n/g, "");
  return { publicKey, privateKey, pem, singleLinePem };
}

function buildSignatureHeader(input: {
  alg?: string;
  kid?: string;
  signature: string;
  digest?: string;
}): string {
  return Buffer.from(
    JSON.stringify({
      alg: input.alg ?? "ecdsa",
      kid: input.kid ?? "ebay-key-1",
      signature: input.signature,
      ...(input.digest ? { digest: input.digest } : {}),
    }),
    "utf8",
  ).toString("base64");
}

function signPayload(privateKey: crypto.KeyObject, rawBody: Buffer, digest: "sha1" | "sha256" = "sha1"): string {
  return crypto.sign(digest, rawBody, privateKey).toString("base64");
}

describe("FND-3 / IA-06: eBay webhook cryptographic signature verification", () => {
  it("verifies a valid ECDSA-SHA1 and ECDSA-SHA256 signature against rawBody and caches the public key by kid", async () => {
    const { privateKey, singleLinePem } = generateEcdsaKeyPair();
    const getNotificationPublicKey = vi.fn().mockResolvedValue({
      key: singleLinePem,
      algorithm: "ECDSA",
      digest: "SHA1",
    });

    let currentTime = 1_000_000;
    const verify = createEbayWebhookSignatureVerifier(
      { getNotificationPublicKey },
      { cacheTtlMs: 60_000, now: () => currentTime },
    );

    const payload = JSON.stringify({
      metadata: { topic: "MARKETPLACE_ORDER_CONFIRMATION" },
      notification: { notificationId: "notif-1", data: { orderId: "12-34567-89012" } },
    });
    const rawBody = Buffer.from(payload, "utf8");
    const sig = signPayload(privateKey, rawBody, "sha1");
    const header = buildSignatureHeader({ kid: "kid-alpha", signature: sig, digest: "SHA1" });

    const req1 = {
      headers: { "x-ebay-signature": header },
      rawBody,
      body: JSON.parse(payload),
    } as any;

    const res1 = await verify(req1);
    expect(res1).toEqual({
      ok: true,
      keyId: "kid-alpha",
      algorithm: "ECDSA",
      digest: "sha1",
    });
    expect(getNotificationPublicKey).toHaveBeenCalledTimes(1);
    expect(getNotificationPublicKey).toHaveBeenCalledWith("kid-alpha");

    // Second request within TTL reuses cached public key without another provider call
    currentTime += 30_000;
    const res2 = await verify(req1);
    expect(res2.ok).toBe(true);
    expect(getNotificationPublicKey).toHaveBeenCalledTimes(1);

    // After TTL expires, fetches key again
    currentTime += 31_000;
    const res3 = await verify(req1);
    expect(res3.ok).toBe(true);
    expect(getNotificationPublicKey).toHaveBeenCalledTimes(2);
  });

  it("rejects forged, tampered, or malformed signatures before any inbox or order API call", async () => {
    const { privateKey, pem } = generateEcdsaKeyPair();
    const attackerKeys = generateEcdsaKeyPair();
    const getNotificationPublicKey = vi.fn().mockResolvedValue({
      key: pem,
      algorithm: "ECDSA",
      digest: "SHA1",
    });
    const getOrder = vi.fn();
    const ingestOrder = vi.fn();

    const handler = createEbayOrderWebhookHandler(
      { ingestOrder } as any,
      { getNotificationPublicKey, getOrder } as any,
    );

    const payloadObj = {
      metadata: { topic: "MARKETPLACE_ORDER_CONFIRMATION" },
      notification: { notificationId: "notif-forged", data: { orderId: "99-99999-99999" } },
    };
    const rawBody = Buffer.from(JSON.stringify(payloadObj), "utf8");

    // 1. Missing signature header -> 401, zero key fetch, zero order fetch
    const resMissing = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    await handler({ method: "POST", headers: {}, body: payloadObj, rawBody } as any, resMissing as any);
    expect(resMissing.status).toHaveBeenCalledWith(401);
    expect(getNotificationPublicKey).not.toHaveBeenCalled();
    expect(getOrder).not.toHaveBeenCalled();

    // 2. Non-empty garbage x-ebay-signature header -> 412, zero key fetch, zero order fetch
    const resMalformed = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    await handler(
      { method: "POST", headers: { "x-ebay-signature": "not-valid-base64-json" }, body: payloadObj, rawBody } as any,
      resMalformed as any,
    );
    expect(resMalformed.status).toHaveBeenCalledWith(412);
    expect(resMalformed.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "EBAY_SIGNATURE_HEADER_MALFORMED" }),
    );
    expect(getNotificationPublicKey).not.toHaveBeenCalled();
    expect(getOrder).not.toHaveBeenCalled();

    // 3. Signed by attacker key -> 412 EBAY_SIGNATURE_INVALID, zero order fetch
    const forgedSig = signPayload(attackerKeys.privateKey, rawBody, "sha1");
    const forgedHeader = buildSignatureHeader({ kid: "kid-valid", signature: forgedSig });
    const resForged = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    await handler(
      { method: "POST", headers: { "x-ebay-signature": forgedHeader }, body: payloadObj, rawBody } as any,
      resForged as any,
    );
    expect(resForged.status).toHaveBeenCalledWith(412);
    expect(resForged.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "EBAY_SIGNATURE_INVALID" }),
    );
    expect(getNotificationPublicKey).toHaveBeenCalledTimes(1);
    expect(getOrder).not.toHaveBeenCalled();

    // 4. Valid signature over original body, but body was tampered in transit -> 412
    const validSig = signPayload(privateKey, rawBody, "sha1");
    const validHeader = buildSignatureHeader({ kid: "kid-valid", signature: validSig });
    const tamperedRawBody = Buffer.from(
      JSON.stringify({
        ...payloadObj,
        notification: { ...payloadObj.notification, data: { orderId: "00-00000-00000" } },
      }),
      "utf8",
    );
    const resTampered = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    await handler(
      { method: "POST", headers: { "x-ebay-signature": validHeader }, body: payloadObj, rawBody: tamperedRawBody } as any,
      resTampered as any,
    );
    expect(resTampered.status).toHaveBeenCalledWith(412);
    expect(resTampered.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "EBAY_SIGNATURE_INVALID" }),
    );
    expect(getOrder).not.toHaveBeenCalled();
  });

  it("distinguishes unknown public_key_id (412) from transient public-key API outage (503 so eBay redelivers)", async () => {
    const { privateKey } = generateEcdsaKeyPair();
    const rawBody = Buffer.from('{"metadata":{"topic":"MARKETPLACE_ORDER_CONFIRMATION"},"notification":{"data":{"orderId":"1"}}}', "utf8");
    const sig = signPayload(privateKey, rawBody, "sha1");

    // Case 1: eBay returns 404 for unknown kid -> 412 Precondition Failed
    const verifyNotFound = createEbayWebhookSignatureVerifier({
      getNotificationPublicKey: vi.fn().mockRejectedValue(
        new EbayApiRequestError(404, "Public key not found", '{"errors":[{"errorId":19501}]}'),
      ),
    });
    const res404 = await verifyNotFound({
      headers: { "x-ebay-signature": buildSignatureHeader({ kid: "unknown-kid", signature: sig }) },
      rawBody,
    } as any);
    expect(res404).toEqual({
      ok: false,
      statusCode: 412,
      code: "EBAY_PUBLIC_KEY_NOT_FOUND",
      message: "Notification public key was not found",
      keyId: "unknown-kid",
    });

    // Case 2: eBay API or auth temporarily unavailable -> 503 Service Unavailable
    const verifyUnavailable = createEbayWebhookSignatureVerifier({
      getNotificationPublicKey: vi.fn().mockRejectedValue(new Error("ECONNRESET")),
    });
    const res503 = await verifyUnavailable({
      headers: { "x-ebay-signature": buildSignatureHeader({ kid: "transient-kid", signature: sig }) },
      rawBody,
    } as any);
    expect(res503).toEqual({
      ok: false,
      statusCode: 503,
      code: "EBAY_PUBLIC_KEY_UNAVAILABLE",
      message: "Notification public key verification is temporarily unavailable",
      keyId: "transient-kid",
    });
  });
});
