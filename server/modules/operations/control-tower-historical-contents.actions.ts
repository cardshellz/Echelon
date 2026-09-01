import type { Pool } from "pg";

import { createHistoricalShipStationContentsClient } from "../shipping/historical-shipstation-contents-audit.client";
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
  throw error;
}

function service(pool: Pool): HistoricalContentsReviewService {
  return new HistoricalShipStationContentsReviewService(
    new PgHistoricalShipStationContentsReviewRepository(pool),
    createHistoricalShipStationContentsClient(),
  );
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
}>): Promise<unknown> {
  try {
    const exceptionId = await exceptionIdForWorkItem(input);
    return await (input.reviewService ?? service(input.pool)).decide({
      exceptionId,
      expectedPreviewEvidenceHash: input.expectedPreviewEvidenceHash,
      authenticatedActorUserId: input.actorUserId,
      decision: input.decision,
      reason: input.reason,
    });
  } catch (error) {
    return actionError(error);
  }
}
