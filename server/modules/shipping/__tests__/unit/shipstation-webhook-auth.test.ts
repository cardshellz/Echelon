import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createDefaultShipStationV2WebhookVerifier,
  createShipStationV2WebhookVerifier,
} from "../../shipstation-webhook-auth";
import { SHIPSTATION_TRACKING_WEBHOOK_SECRET_KEY_ID } from "../../shipstation-tracking-api-config";

const now = new Date("2026-07-20T12:00:00.000Z");
const sharedSecret = "s".repeat(32);

function verifier() {
  return createShipStationV2WebhookVerifier({
    sharedSecret,
    now: () => new Date(now),
  });
}

describe("ShipStation V2 tracking webhook authentication", () => {
  it("authenticates the configured custom header without persisting the secret", async () => {
    const rawBody = Buffer.from('{"resource_type":"API_TRACK"}', "utf8");
    const authenticationCode = createHmac("sha256", sharedSecret).update(rawBody).digest();

    const receipt = await verifier().verify({
      headers: { sharedSecret },
      rawBody,
    });

    expect(receipt).toMatchObject({
      provider: "shipstation",
      signatureAlgorithm: "HMAC-SHA256",
      signatureKeyId: SHIPSTATION_TRACKING_WEBHOOK_SECRET_KEY_ID,
      signatureTimestampRaw: now.toISOString(),
      signatureTimestampAt: now,
      rawBodyBase64: rawBody.toString("base64"),
      signatureBase64: authenticationCode.toString("base64"),
      signatureHash: createHash("sha256").update(authenticationCode).digest("hex"),
      verifiedAt: now,
    });
    expect(JSON.stringify(receipt)).not.toContain(sharedSecret);
  });

  it("is idempotent across exact provider redelivery times", async () => {
    const rawBody = Buffer.from('{"resource_type":"API_TRACK"}', "utf8");
    const first = await verifier().verify({ headers: { sharedSecret }, rawBody });
    const later = await createShipStationV2WebhookVerifier({
      sharedSecret,
      now: () => new Date("2026-07-20T12:30:00.000Z"),
    }).verify({ headers: { sharedSecret }, rawBody });

    expect(later.receiptHash).toBe(first.receiptHash);
  });

  it("fails closed for missing, incorrect, or weak secrets", async () => {
    const rawBody = Buffer.from("{}", "utf8");
    await expect(verifier().verify({
      headers: { sharedSecret: null },
      rawBody,
    })).rejects.toMatchObject({
      code: "SHIPSTATION_WEBHOOK_SHARED_SECRET_MISSING",
      httpStatus: 404,
    });
    await expect(verifier().verify({
      headers: { sharedSecret: "x".repeat(32) },
      rawBody,
    })).rejects.toMatchObject({
      code: "SHIPSTATION_WEBHOOK_SHARED_SECRET_INVALID",
      httpStatus: 401,
    });
    expect(() => createShipStationV2WebhookVerifier({
      sharedSecret: "too-short",
      now: () => new Date(now),
    })).toThrow(/32/);
  });

  it("rejects authenticated requests when exact raw bytes are unavailable", async () => {
    await expect(verifier().verify({
      headers: { sharedSecret },
      rawBody: undefined,
    })).rejects.toMatchObject({
      code: "SHIPSTATION_WEBHOOK_RAW_BODY_MISSING",
      httpStatus: 400,
    });
  });

  it("hides the route when the webhook secret is not configured", async () => {
    const original = process.env.SHIPSTATION_TRACKING_WEBHOOK_SECRET;
    delete process.env.SHIPSTATION_TRACKING_WEBHOOK_SECRET;
    try {
      await expect(createDefaultShipStationV2WebhookVerifier(() => new Date(now)).verify({
        headers: { sharedSecret },
        rawBody: Buffer.from("{}"),
      })).rejects.toMatchObject({
        code: "SHIPSTATION_WEBHOOK_SHARED_SECRET_NOT_CONFIGURED",
        httpStatus: 404,
      });
    } finally {
      if (original === undefined) delete process.env.SHIPSTATION_TRACKING_WEBHOOK_SECRET;
      else process.env.SHIPSTATION_TRACKING_WEBHOOK_SECRET = original;
    }
  });
});
