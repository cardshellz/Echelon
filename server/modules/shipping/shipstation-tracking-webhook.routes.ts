import express, { type Express, type NextFunction, type Request, type Response } from "express";

import type { CarrierTrackingLogger, CarrierTrackingService } from "./carrier-tracking.service";
import {
  ShipStationWebhookAuthError,
  type ShipStationWebhookSignatureHeaders,
  type ShipStationWebhookSignatureVerifier,
} from "./shipstation-webhook-auth";

export const SHIPSTATION_TRACKING_WEBHOOK_PATH = "/api/shipping/webhooks/shipstation/track";
export const SHIPSTATION_TRACKING_WEBHOOK_BODY_LIMIT = "1mb";

/**
 * Install before the application's general JSON parser. Signature verification
 * requires the exact bytes received from ShipStation, and a signed payload must
 * still reach the evidence ledger when its JSON cannot be normalized.
 */
export function installShipStationTrackingRawBodyCapture(app: Express): void {
  app.use(
    SHIPSTATION_TRACKING_WEBHOOK_PATH,
    express.raw({
      type: "application/json",
      limit: SHIPSTATION_TRACKING_WEBHOOK_BODY_LIMIT,
      inflate: false,
    }),
    (request: Request, _response: Response, next: NextFunction) => {
      if (!Buffer.isBuffer(request.body)) return next();

      const rawBody = Buffer.from(request.body);
      request.rawBody = rawBody;
      try {
        request.body = JSON.parse(rawBody.toString("utf8"));
      } catch {
        // Authentication and receipt persistence still run. The domain parser
        // records an immutable rejection after the signed bytes are retained.
        request.body = null;
      }
      return next();
    },
  );
}

export function registerShipStationTrackingWebhook(
  app: Express,
  dependencies: {
    service: Pick<CarrierTrackingService, "ingestShipStationWebhook">;
    signatureVerifier: ShipStationWebhookSignatureVerifier;
    logger: CarrierTrackingLogger;
  },
): void {
  app.post(SHIPSTATION_TRACKING_WEBHOOK_PATH, async (request, response) => {
    try {
      const receipt = await dependencies.signatureVerifier.verify({
        headers: signatureHeaders(request),
        rawBody: request.rawBody,
      });
      const result = await dependencies.service.ingestShipStationWebhook(request.body, receipt);
      if (result.ingestStatus === "rejected") {
        return response.status(202).json({
          status: "accepted_for_review",
          receiptId: result.webhookReceiptId,
          receiptDuplicate: !result.webhookReceiptInserted,
          parseAttemptId: result.parseAttemptId,
          parseAttemptDuplicate: !result.parseAttemptInserted,
          reasonCode: result.reasonCode,
        });
      }
      return response.status(200).json({
        status: "accepted",
        eventId: result.eventId,
        duplicate: !result.eventInserted,
        receiptDuplicate: !result.webhookReceiptInserted,
        matchStatus: result.matchStatus,
        dispatchEvidence: result.dispatchEvidence,
      });
    } catch (error) {
      if (error instanceof ShipStationWebhookAuthError) {
        dependencies.logger.warn({
          code: error.code,
          message: "ShipStation tracking webhook authentication failed.",
          context: { httpStatus: error.httpStatus },
        });
        if (error.httpStatus === 404) return response.status(404).end();
        return response.status(error.httpStatus).json({ error: error.code });
      }
      dependencies.logger.error({
        code: "CARRIER_TRACKING_WEBHOOK_INGEST_FAILED",
        message: "ShipStation tracking webhook could not be durably recorded.",
        context: { error: error instanceof Error ? error.message : String(error) },
      });
      return response.status(500).json({ error: "CARRIER_TRACKING_WEBHOOK_INGEST_FAILED" });
    }
  });
}

function signatureHeaders(request: Request): ShipStationWebhookSignatureHeaders {
  return {
    keyId: headerValue(request, "x-shipengine-rsa-sha256-key-id"),
    signature: headerValue(request, "x-shipengine-rsa-sha256-signature"),
    timestamp: headerValue(request, "x-shipengine-timestamp"),
  };
}

function headerValue(request: Request, name: string): string | null {
  const value = request.get(name)?.trim();
  return value || null;
}
