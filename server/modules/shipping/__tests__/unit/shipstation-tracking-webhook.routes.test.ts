import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SHIPSTATION_TRACKING_WEBHOOK_PATH,
  installShipStationTrackingRawBodyCapture,
  registerShipStationTrackingWebhook,
} from "../../shipstation-tracking-webhook.routes";
import { ShipStationWebhookAuthError } from "../../shipstation-webhook-auth";

const openServers: http.Server[] = [];
const receipt = {
  provider: "shipstation" as const,
  receiptHash: "a".repeat(64),
  signatureAlgorithm: "HMAC-SHA256" as const,
  signatureKeyId: "echelon-shipstation-v2-track-v1",
  signatureTimestampRaw: "2026-07-20T12:00:00.000Z",
  signatureTimestampAt: new Date("2026-07-20T12:00:00.000Z"),
  rawBodyBase64: Buffer.from("{}").toString("base64"),
  rawBodyHash: "b".repeat(64),
  signatureBase64: "signed-request",
  signatureHash: "c".repeat(64),
  verifiedAt: new Date("2026-07-20T12:00:00.000Z"),
};

async function listen(app: Express): Promise<string> {
  const server = http.createServer(app);
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function buildApp(input: { verify: ReturnType<typeof vi.fn>; ingest: ReturnType<typeof vi.fn> }) {
  const app = express();
  installShipStationTrackingRawBodyCapture(app);
  app.use(express.json({
    verify(request, _response, body) {
      request.rawBody = Buffer.from(body);
    },
  }));
  registerShipStationTrackingWebhook(app, {
    webhookVerifier: { verify: input.verify },
    service: { ingestShipStationWebhook: input.ingest },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return app;
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("ShipStation tracking webhook route", () => {
  it("authenticates exact request bytes before ingesting evidence", async () => {
    const order: string[] = [];
    const verify = vi.fn(async ({ headers, rawBody }) => {
      order.push("verify");
      expect(Buffer.isBuffer(rawBody)).toBe(true);
      expect(headers.sharedSecret).toBe("webhook-secret");
      return receipt;
    });
    const ingest = vi.fn(async (_payload, verifiedReceipt) => {
      order.push("ingest");
      expect(verifiedReceipt).toBe(receipt);
      return {
        ingestStatus: "normalized",
        eventId: 1,
        eventInserted: true,
        webhookReceiptId: 2,
        webhookReceiptInserted: true,
        parseAttemptId: 3,
        parseAttemptInserted: true,
        matchStatus: "pending",
        dispatchEvidence: "confirmed",
      };
    });
    const baseUrl = await listen(buildApp({ verify, ingest }));

    const response = await fetch(`${baseUrl}${SHIPSTATION_TRACKING_WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-echelon-shipstation-tracking-secret": "webhook-secret",
      },
      body: JSON.stringify({ resource_type: "API_TRACK" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "accepted",
      eventId: 1,
      duplicate: false,
      receiptDuplicate: false,
      matchStatus: "pending",
    });
    expect(order).toEqual(["verify", "ingest"]);
  });

  it("does not reveal the endpoint when authentication headers are absent", async () => {
    const verify = vi.fn(async () => {
      throw new ShipStationWebhookAuthError(
        "SHIPSTATION_WEBHOOK_SHARED_SECRET_MISSING",
        "missing",
        404,
      );
    });
    const ingest = vi.fn();
    const baseUrl = await listen(buildApp({ verify, ingest }));
    const response = await fetch(`${baseUrl}${SHIPSTATION_TRACKING_WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(404);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("retains validated but unrecognized tracking payloads for operator review", async () => {
    const verify = vi.fn().mockResolvedValue(receipt);
    const ingest = vi.fn().mockResolvedValue({
      ingestStatus: "rejected",
      eventId: null,
      eventInserted: false,
      webhookReceiptId: 2,
      webhookReceiptInserted: true,
      parseAttemptId: 3,
      parseAttemptInserted: true,
      reasonCode: "INVALID_CARRIER_TRACKING_PAYLOAD",
    });
    const baseUrl = await listen(buildApp({ verify, ingest }));
    const response = await fetch(`${baseUrl}${SHIPSTATION_TRACKING_WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: "accepted_for_review",
      receiptId: 2,
      receiptDuplicate: false,
      parseAttemptId: 3,
      parseAttemptDuplicate: false,
      reasonCode: "INVALID_CARRIER_TRACKING_PAYLOAD",
    });
  });

  it("retains exact authenticated bytes even when the provider body is not valid JSON", async () => {
    const invalidJson = Buffer.from('{"resource_type":"API_TRACK"', "utf8");
    const verify = vi.fn(async ({ rawBody }) => {
      expect(rawBody).toEqual(invalidJson);
      return receipt;
    });
    const ingest = vi.fn(async (payload) => {
      expect(payload).toBeNull();
      return {
        ingestStatus: "rejected",
        eventId: null,
        eventInserted: false,
        webhookReceiptId: 4,
        webhookReceiptInserted: true,
        parseAttemptId: 5,
        parseAttemptInserted: true,
        reasonCode: "INVALID_CARRIER_TRACKING_PAYLOAD",
      };
    });
    const baseUrl = await listen(buildApp({ verify, ingest }));

    const response = await fetch(`${baseUrl}${SHIPSTATION_TRACKING_WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: invalidJson,
    });

    expect(response.status).toBe(202);
    expect(verify).toHaveBeenCalledOnce();
    expect(ingest).toHaveBeenCalledOnce();
  });
});
