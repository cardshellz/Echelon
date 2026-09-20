import type { Pool } from "pg";

import { createHistoricalShipStationContentsClient } from "../shipping/historical-shipstation-contents-audit.client";
import { HistoricalShipStationContentsCorrectionDomainError } from "../shipping/historical-shipstation-contents-correction.domain";
import {
  HistoricalShipStationContentsCorrectionRepositoryError,
  PgHistoricalShipStationContentsCorrectionRepository,
} from "../shipping/historical-shipstation-contents-correction.repository";
import {
  HistoricalShipStationContentsCorrectionService,
  HistoricalShipStationContentsCorrectionServiceError,
} from "../shipping/historical-shipstation-contents-correction.service";
import {
  HistoricalShipStationContentsReviewRepositoryError,
  PgHistoricalShipStationContentsReviewRepository,
} from "../shipping/historical-shipstation-contents-review.repository";
import {
  HISTORICAL_SHIPSTATION_CONTENTS_REVIEW_RULE,
  HistoricalShipStationContentsReviewService,
  HistoricalShipStationContentsReviewServiceError,
} from "../shipping/historical-shipstation-contents-review.service";
import { ControlTowerRequestError } from "./control-tower-v2.request";

interface HistoricalContentsReviewService {
  preview(exceptionId: string): Promise<unknown>;
  decide(input: Readonly<{
    readonly exceptionId: string;
    readonly expectedPreviewEvidenceHash: string;
    readonly authenticatedActorUserId: string;
    readonly decision:
      | "wms_confirmed"
      | "provider_confirmed_pending_inventory_correction"
      | "cannot_prove";
    readonly reason: string;
  }>): Promise<unknown>;
}

interface HistoricalContentsCorrectionService {
  preview(exceptionId: string): Promise<unknown>;
}

function actionError(error: unknown): never {
  if (error instanceof ControlTowerRequestError) throw error;
  if (error instanceof HistoricalShipStationContentsReviewServiceError) {
    const statusCode = error.code === "INVALID_COMMAND"
      ? 400
      : ["CANDIDATE_NOT_FOUND", "REVIEW_NOT_FOUND"].includes(error.code)
        ? 404
        : 409;
    throw new ControlTowerRequestError(error.message, statusCode, error.code);
  }
  if (error instanceof HistoricalShipStationContentsReviewRepositoryError) {
    const statusCode = error.code === "LEAD_AUTHORIZATION_REQUIRED"
      ? 403
      : error.code === "REVIEW_NOT_FOUND"
        ? 404
        : 409;
    throw new ControlTowerRequestError(error.message, statusCode, error.code);
  }
  if (error instanceof HistoricalShipStationContentsCorrectionServiceError) {
    throw new ControlTowerRequestError(
      error.message,
      error.code === "INVALID_COMMAND" ? 400 : 409,
      error.code,
    );
  }
  if (error instanceof HistoricalShipStationContentsCorrectionRepositoryError) {
    const statusCode = error.code === "REVIEW_NOT_FOUND" ? 404 : 409;
    throw new ControlTowerRequestError(error.message, statusCode, error.code);
  }
  if (error instanceof HistoricalShipStationContentsCorrectionDomainError) {
    throw new ControlTowerRequestError(error.message, 409, error.code);
  }
  throw error;
}

function service(pool: Pool): HistoricalContentsReviewService {
  return new HistoricalShipStationContentsReviewService(
    new PgHistoricalShipStationContentsReviewRepository(pool),
    createHistoricalShipStationContentsClient(),
  );
}

function correctionService(pool: Pool): HistoricalContentsCorrectionService {
  const reviewService = new HistoricalShipStationContentsReviewService(
    new PgHistoricalShipStationContentsReviewRepository(pool),
    createHistoricalShipStationContentsClient(),
  );
  return new HistoricalShipStationContentsCorrectionService(
    new PgHistoricalShipStationContentsCorrectionRepository(pool),
    reviewService,
  );
}

async function enqueueConfirmedCurrentLabel(input: Readonly<{
  readonly pool: Pool;
  readonly result: unknown;
  readonly enqueueReprocess?: (providerOrderId: string) => Promise<void>;
}>): Promise<void> {
  if (!input.enqueueReprocess || input.result === null || typeof input.result !== "object"
    || !("shippingProviderLabelId" in input.result)
    || typeof input.result.shippingProviderLabelId !== "string") return;
  const label = await input.pool.query<{
    provider_order_id: string | null;
    current_authoritative: boolean;
  }>(
    `SELECT label.provider_order_id,
            EXISTS (
              SELECT 1 FROM wms.shipping_provider_label_events AS event
              WHERE event.shipping_provider_label_id = label.id
                AND event.event_type = 'label_observed'
                AND event.sanitized_payload->>'payloadSchemaVersion' = '2'
                AND event.sanitized_payload->'declaredContentsEvidence'->>'status' = 'authoritative'
            ) AS current_authoritative
     FROM wms.shipping_provider_labels AS label
     WHERE label.id = $1::bigint AND label.provider = 'shipstation'
       AND label.label_direction = 'outbound'`,
    [input.result.shippingProviderLabelId],
  );
  if (label.rows.length !== 1) {
    throw new Error("Confirmed ShipStation contents lost their provider label identity");
  }
  if (!label.rows[0].current_authoritative) return;
  const providerOrderId = label.rows[0].provider_order_id;
  if (!providerOrderId || !/^[1-9][0-9]*$/.test(providerOrderId)) {
    throw new Error("Confirmed ShipStation contents cannot be reprocessed without exact provider order identity");
  }
  await input.enqueueReprocess(providerOrderId);
}

async function exceptionIdForWorkItem(input: Readonly<{
  readonly pool: Pool;
  readonly workItemId: number;
  readonly version?: number;
}>): Promise<string> {
  const result = await input.pool.query<{
    source_namespace: string;
    source_type: string;
    source_key: string;
    code: string;
    row_version: number;
    source_status: string;
  }>(
    `SELECT source_namespace, source_type, source_key, code, row_version, source_status
     FROM operations.control_tower_work_items
     WHERE id = $1`,
    [input.workItemId],
  );
  const item = result.rows[0];
  if (!item) {
    throw new ControlTowerRequestError(
      "Control Tower work item not found",
      404,
      "WORK_ITEM_NOT_FOUND",
    );
  }
  if (
    item.source_namespace !== "wms.reconciliation_exceptions"
    || item.source_type !== "reconciliation_exception"
    || item.code !== HISTORICAL_SHIPSTATION_CONTENTS_REVIEW_RULE
    || !/^[1-9][0-9]*$/.test(item.source_key)
  ) {
    throw new ControlTowerRequestError(
      "This work item is not a historical package-content review",
      409,
      "INVALID_WORK_ITEM_ACTION",
    );
  }
  if (input.version !== undefined && Number(item.row_version) !== input.version) {
    throw new ControlTowerRequestError(
      "This work item changed. Refresh and try again.",
      409,
      "STALE_WORK_ITEM_VERSION",
    );
  }
  if (item.source_status === "resolved" || item.source_status === "ignored") {
    throw new ControlTowerRequestError(
      "This historical package-content review is already resolved",
      409,
      "WORK_ITEM_RESOLVED",
    );
  }
  return item.source_key;
}

export async function getHistoricalContentsReviewPreview(input: Readonly<{
  readonly pool: Pool;
  readonly workItemId: number;
  readonly reviewService?: HistoricalContentsReviewService;
}>): Promise<unknown> {
  try {
    const exceptionId = await exceptionIdForWorkItem(input);
    return await (input.reviewService ?? service(input.pool)).preview(exceptionId);
  } catch (error) {
    return actionError(error);
  }
}

export async function getHistoricalContentsCorrectionPreview(input: Readonly<{
  readonly pool: Pool;
  readonly workItemId: number;
  readonly correctionPreviewService?: HistoricalContentsCorrectionService;
}>): Promise<unknown> {
  try {
    const exceptionId = await exceptionIdForWorkItem(input);
    return await (input.correctionPreviewService ?? correctionService(input.pool))
      .preview(exceptionId);
  } catch (error) {
    return actionError(error);
  }
}

export async function decideHistoricalContentsReview(input: Readonly<{
  readonly pool: Pool;
  readonly workItemId: number;
  readonly version: number;
  readonly actorUserId: string;
  readonly expectedPreviewEvidenceHash: string;
  readonly decision:
    | "wms_confirmed"
    | "provider_confirmed_pending_inventory_correction"
    | "cannot_prove";
  readonly reason: string;
  readonly reviewService?: HistoricalContentsReviewService;
  readonly enqueueReprocess?: (providerOrderId: string) => Promise<void>;
}>): Promise<unknown> {
  try {
    const exceptionId = await exceptionIdForWorkItem(input);
    const result = await (input.reviewService ?? service(input.pool)).decide({
      exceptionId,
      expectedPreviewEvidenceHash: input.expectedPreviewEvidenceHash,
      authenticatedActorUserId: input.actorUserId,
      decision: input.decision,
      reason: input.reason,
    });
    if (input.decision === "wms_confirmed") {
      await enqueueConfirmedCurrentLabel({
        pool: input.pool,
        result,
        enqueueReprocess: input.enqueueReprocess,
      });
    }
    return result;
  } catch (error) {
    return actionError(error);
  }
}
