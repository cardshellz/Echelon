import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { canonicalJson } from "@shared/utils/canonical-json";

import { PgHistoricalShipStationContentsAttestationRepository } from "./historical-shipstation-contents-attestation.repository";
import {
  buildHistoricalShipStationContentsSystemRecoveryEvent,
  type HistoricalShipStationContentsRecoveryLabelStatus,
} from "./historical-shipstation-contents-recovery.domain";
import {
  loadHistoricalShipStationContentsSystemRecoveryCandidate,
  PgHistoricalShipStationContentsSystemRecoveryRepository,
} from "./historical-shipstation-contents-system-recovery.repository";
import {
  HISTORICAL_SHIPSTATION_CONTENTS_REVIEW_RULE,
  type HistoricalShipStationContentsReviewCandidate,
  type HistoricalShipStationContentsReviewRecord,
  type HistoricalShipStationContentsReviewRepository,
  type HistoricalShipStationContentsReviewSnapshot,
  type PersistedHistoricalShipStationContentsReview,
  type PersistedHistoricalShipStationContentsWmsResolution,
} from "./historical-shipstation-contents-review.service";

const MAX_RESOLVED_EVENTS = 500;
const MAX_REVIEW_CONTEXT_REFERENCES = 100;
const MAX_DECISION_HISTORY = 100;
const REVIEW_DETAILS_CONTRACT = "historical_shipstation_contents_review_v1";
const REVIEW_REASONS = new Set([
  "provider_empty",
  "provider_evidence_unavailable",
  "wms_lineage_unavailable",
  "ambiguous_wms_match",
  "provider_wms_conflict",
]);
const EXPECTED_CONTENTS_UNAVAILABLE_REASONS = new Set([
  "no_linked_package",
  "ambiguous_linked_package",
  "linked_package_contents_unavailable",
]);

export type HistoricalShipStationContentsReviewRepositoryErrorCode =
  | "CONCURRENT_WRITE"
  | "DATABASE_ERROR"
  | "INVALID_DATABASE_EVIDENCE"
  | "LEAD_AUTHORIZATION_REQUIRED"
  | "REVIEW_CONFLICT"
  | "REVIEW_NOT_FOUND";

export class HistoricalShipStationContentsReviewRepositoryError extends Error {
  constructor(
    readonly code: HistoricalShipStationContentsReviewRepositoryErrorCode,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = Object.freeze({}),
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HistoricalShipStationContentsReviewRepositoryError";
  }
}

function metadata(error: unknown): { code: string | null; constraint: string | null } {
  if (error === null || typeof error !== "object") return { code: null, constraint: null };
  const candidate = error as { code?: unknown; constraint?: unknown };
  return {
    code: typeof candidate.code === "string" ? candidate.code : null,
    constraint: typeof candidate.constraint === "string" ? candidate.constraint : null,
  };
}

function classify(error: unknown): HistoricalShipStationContentsReviewRepositoryError {
  if (error instanceof HistoricalShipStationContentsReviewRepositoryError) return error;
  const postgres = metadata(error);
  if (["40001", "40P01", "55P03"].includes(postgres.code ?? "")) {
    return new HistoricalShipStationContentsReviewRepositoryError(
      "CONCURRENT_WRITE",
      "Historical contents review encountered a concurrent database write",
      Object.freeze({ postgresCode: postgres.code }),
      { cause: error },
    );
  }
  if (postgres.code === "23505") {
    return new HistoricalShipStationContentsReviewRepositoryError(
      "REVIEW_CONFLICT",
      "Historical contents review conflicts with already-persisted evidence",
      Object.freeze({ constraint: postgres.constraint }),
      { cause: error },
    );
  }
  return new HistoricalShipStationContentsReviewRepositoryError(
    "DATABASE_ERROR",
    "Historical contents review database operation failed",
    Object.freeze({ postgresCode: postgres.code, constraint: postgres.constraint }),
    { cause: error },
  );
}

function positiveBigintText(value: unknown, field: string): string {
  const text = String(value ?? "");
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new HistoricalShipStationContentsReviewRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Historical contents review received invalid ${field}`,
    );
  }
  return text;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new HistoricalShipStationContentsReviewRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Historical contents review received invalid ${field}`,
    );
  }
  return parsed;
}

function exactText(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value.trim() !== value
  ) {
    throw new HistoricalShipStationContentsReviewRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Historical contents review received invalid ${field}`,
    );
  }
  return value;
}

function exactEvidenceHash(value: unknown, field: string): string {
  const text = exactText(value, field, 64);
  if (!/^[0-9a-f]{64}$/.test(text)) {
    throw new HistoricalShipStationContentsReviewRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Historical contents review received invalid ${field}`,
    );
  }
  return text;
}

function objectArray(value: unknown, field: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > MAX_REVIEW_CONTEXT_REFERENCES) {
    throw new HistoricalShipStationContentsReviewRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Historical contents review received invalid ${field}`,
    );
  }
  return value.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new HistoricalShipStationContentsReviewRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        `Historical contents review received invalid ${field}`,
      );
    }
    return entry as Record<string, unknown>;
  });
}

function labelStatus(value: string): HistoricalShipStationContentsRecoveryLabelStatus {
  if (!["active", "voided", "superseded", "unknown"].includes(value)) {
    throw new HistoricalShipStationContentsReviewRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Historical contents review received invalid label status",
    );
  }
  return value as HistoricalShipStationContentsRecoveryLabelStatus;
}

function reviewDetails(record: HistoricalShipStationContentsReviewRecord): Record<string, unknown> {
  const nameByLineId = new Map(record.candidate.linePresentations.map(
    (line) => [line.wmsShipmentItemId, line.itemName] as const,
  ));
  return {
    contract: REVIEW_DETAILS_CONTRACT,
    shippingProviderLabelId: record.candidate.shippingProviderLabelId,
    providerShipmentId: record.candidate.providerShipmentId,
    trackingNumber: record.candidate.trackingNumber,
    shipStationOrderId: record.candidate.shipStationOrderId,
    wmsOrders: record.candidate.wmsOrders,
    linkedShipments: record.candidate.linkedShipments,
    providerEvidence: {
      contentsStatus: record.providerContentsStatus,
      recoveryStatus: record.providerRecoveryStatus,
      evidenceHash: record.providerObservation.evidenceHash,
      lines: record.providerObservation.lines,
    },
    wmsEvidence: record.candidate.expectedContents.kind === "available"
      ? {
          kind: "available",
          source: record.candidate.expectedContents.source,
          lines: record.candidate.expectedContents.lines.map((line) => ({
            ...line,
            itemName: nameByLineId.get(line.wmsShipmentItemId) ?? null,
          })),
        }
      : record.candidate.expectedContents,
    decision: null,
  };
}

const DECISION_DETAIL_FIELDS = Object.freeze([
  "decision",
  "decisionPreviewEvidenceHash",
  "decisionActorUserId",
  "decisionActorRole",
  "decisionReason",
  "decisionRecordedAt",
  "decisionHash",
  "decisionHistory",
  "inventoryCorrectionRequired",
  "resolutionLabelEventId",
  "resolutionEventHash",
] as const);

function reviewEvidenceDetails(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HistoricalShipStationContentsReviewRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Historical contents review persisted details are not an object",
    );
  }
  const result = { ...(value as Record<string, unknown>) };
  for (const field of DECISION_DETAIL_FIELDS) delete result[field];
  return result;
}

function decisionHash(value: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function snapshotFromRow(row: Record<string, unknown>): HistoricalShipStationContentsReviewSnapshot {
  const details = row.details;
  if (details === null || typeof details !== "object" || Array.isArray(details)) {
    throw new HistoricalShipStationContentsReviewRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Historical contents review details are not an object",
    );
  }
  const value = details as Record<string, unknown>;
  if (value.contract !== REVIEW_DETAILS_CONTRACT) {
    throw new HistoricalShipStationContentsReviewRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Historical contents review contract is unsupported",
    );
  }
  const wmsEvidence = value.wmsEvidence;
  if (wmsEvidence === null || typeof wmsEvidence !== "object" || Array.isArray(wmsEvidence)) {
    throw new HistoricalShipStationContentsReviewRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Historical contents review WMS evidence is not an object",
    );
  }
  const wmsValue = wmsEvidence as Record<string, unknown>;
  const expectedContents = wmsValue.kind === "available"
    ? Object.freeze({
        kind: "available" as const,
        source: (() => {
          const source = exactText(wmsValue.source, "wmsEvidence.source", 30);
          if (source !== "physical_shipment" && source !== "legacy_wms_shipment") {
            throw new HistoricalShipStationContentsReviewRepositoryError(
              "INVALID_DATABASE_EVIDENCE",
              "Historical contents review received invalid WMS evidence source",
            );
          }
          return source;
        })(),
        lines: Object.freeze(objectArray(wmsValue.lines, "wmsEvidence.lines").map((line) => Object.freeze({
          wmsShipmentItemId: positiveInteger(line.wmsShipmentItemId, "wmsShipmentItemId"),
          sku: exactText(line.sku, "sku", 100),
          quantity: positiveInteger(line.quantity, "quantity"),
        }))),
      })
    : wmsValue.kind === "unavailable"
      ? Object.freeze({
        kind: "unavailable" as const,
        reason: (() => {
          const reason = exactText(wmsValue.reason, "wmsEvidence.reason", 80);
          if (!EXPECTED_CONTENTS_UNAVAILABLE_REASONS.has(reason)) {
            throw new HistoricalShipStationContentsReviewRepositoryError(
              "INVALID_DATABASE_EVIDENCE",
              "Historical contents review received invalid unavailable WMS evidence reason",
            );
          }
          return reason as Extract<HistoricalShipStationContentsReviewCandidate["expectedContents"], { kind: "unavailable" }>["reason"];
        })(),
      })
      : (() => {
        throw new HistoricalShipStationContentsReviewRepositoryError(
          "INVALID_DATABASE_EVIDENCE",
          "Historical contents review received invalid WMS evidence kind",
        );
      })();
  const wmsOrders = objectArray(value.wmsOrders, "wmsOrders");
  const linkedShipments = objectArray(value.linkedShipments, "linkedShipments");
  const wmsLines = wmsValue.kind === "available"
    ? objectArray(wmsValue.lines, "wmsEvidence.lines")
    : [];
  const candidate: HistoricalShipStationContentsReviewCandidate = Object.freeze({
    shippingProviderLabelId: positiveBigintText(value.shippingProviderLabelId, "shippingProviderLabelId"),
    providerShipmentId: positiveInteger(value.providerShipmentId, "providerShipmentId"),
    trackingNumber: exactText(value.trackingNumber, "trackingNumber", 200),
    labelStatus: labelStatus(exactText(row.label_status, "labelStatus", 30)),
    expectedContents,
    shipStationOrderId: value.shipStationOrderId == null
      ? null
      : exactText(value.shipStationOrderId, "shipStationOrderId", 200),
    wmsOrders: Object.freeze(wmsOrders.map((order) => Object.freeze({
      wmsOrderId: positiveInteger(order.wmsOrderId, "wmsOrderId"),
      orderNumber: exactText(order.orderNumber, "orderNumber", 50),
    }))),
    linkedShipments: Object.freeze(linkedShipments.map((shipment) => Object.freeze({
      source: (() => {
        const source = exactText(shipment.source, "linkedShipment.source", 30);
        if (source !== "physical_shipment" && source !== "legacy_wms_shipment") {
          throw new HistoricalShipStationContentsReviewRepositoryError(
            "INVALID_DATABASE_EVIDENCE",
            "Historical contents review received invalid linked shipment source",
          );
        }
        return source;
      })(),
      shipmentId: positiveBigintText(shipment.shipmentId, "shipmentId"),
    }))),
    linePresentations: Object.freeze(wmsLines.map((line) => Object.freeze({
      wmsShipmentItemId: positiveInteger(line.wmsShipmentItemId, "wmsShipmentItemId"),
      itemName: line.itemName == null ? null : exactText(line.itemName, "itemName", 500),
    }))),
  });
  const reviewReason = exactText(row.review_reason, "reviewReason", 80);
  if (!REVIEW_REASONS.has(reviewReason)) {
    throw new HistoricalShipStationContentsReviewRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Historical contents review received invalid review reason",
    );
  }
  const providerEvidence = value.providerEvidence;
  if (providerEvidence === null || typeof providerEvidence !== "object" || Array.isArray(providerEvidence)) {
    throw new HistoricalShipStationContentsReviewRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Historical contents review provider evidence is not an object",
    );
  }
  const providerValue = providerEvidence as Record<string, unknown>;
  const recordedDecision = value.decision == null
    ? null
    : exactText(value.decision, "decision", 80);
  if (
    recordedDecision !== null
    && recordedDecision !== "provider_confirmed_pending_inventory_correction"
    && recordedDecision !== "cannot_prove"
  ) {
    throw new HistoricalShipStationContentsReviewRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Historical contents review received an unsupported recorded decision",
    );
  }
  return Object.freeze({
    exceptionId: positiveBigintText(row.id, "exceptionId"),
    candidate,
    reason: reviewReason as HistoricalShipStationContentsReviewSnapshot["reason"],
    providerObservationHash: exactEvidenceHash(providerValue.evidenceHash, "providerEvidenceHash"),
    providerRecoveryStatus: exactText(providerValue.recoveryStatus, "providerRecoveryStatus", 80),
    recordedDecision,
  });
}

async function authorizedActor(client: PoolClient, actorUserId: string): Promise<"admin" | "lead"> {
  const result = await client.query(
    "SELECT role, active FROM identity.users WHERE id = $1 FOR UPDATE",
    [actorUserId],
  );
  const role = result.rows[0]?.role;
  if (result.rows.length !== 1 || Number(result.rows[0]?.active) !== 1 || !["admin", "lead"].includes(role)) {
    throw new HistoricalShipStationContentsReviewRepositoryError(
      "LEAD_AUTHORIZATION_REQUIRED",
      "Historical contents decisions require an active lead or administrator",
    );
  }
  return role;
}

async function withSerializable<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw classify(error);
  } finally {
    client.release();
  }
}

export class PgHistoricalShipStationContentsReviewRepository
implements HistoricalShipStationContentsReviewRepository {
  private readonly attestationRepository: PgHistoricalShipStationContentsAttestationRepository;
  private readonly recoveryRepository: PgHistoricalShipStationContentsSystemRecoveryRepository;

  constructor(private readonly pool: Pool) {
    this.attestationRepository = new PgHistoricalShipStationContentsAttestationRepository(pool);
    this.recoveryRepository = new PgHistoricalShipStationContentsSystemRecoveryRepository(pool);
  }

  async loadCandidate(
    shippingProviderLabelId: string,
  ): Promise<HistoricalShipStationContentsReviewCandidate | null> {
    const [review, recovery] = await Promise.all([
      this.attestationRepository.loadReviewSnapshot(shippingProviderLabelId),
      this.recoveryRepository.loadSnapshot(shippingProviderLabelId),
    ]);
    if (review === null || recovery === null) return null;
    if (canonicalJson(review.candidate) !== canonicalJson({
      shippingProviderLabelId: recovery.candidate.shippingProviderLabelId,
      providerShipmentId: recovery.candidate.providerShipmentId,
      expectedContents: recovery.candidate.expectedContents,
    })) {
      throw new HistoricalShipStationContentsReviewRepositoryError(
        "CONCURRENT_WRITE",
        "Historical contents candidate changed between review snapshots",
      );
    }
    return Object.freeze({
      ...recovery.candidate,
      shipStationOrderId: review.reviewContext.shipStationOrderId,
      wmsOrders: review.reviewContext.wmsOrders,
      linkedShipments: review.reviewContext.linkedShipments,
      linePresentations: review.reviewContext.linePresentations,
    });
  }

  async loadOpenReview(exceptionId: string): Promise<HistoricalShipStationContentsReviewSnapshot | null> {
    const result = await this.pool.query(
      `SELECT exception.id::text AS id,
              exception.details,
              exception.details->'providerEvidence'->>'recoveryStatus' AS review_reason,
              label.label_status
       FROM wms.reconciliation_exceptions AS exception
       JOIN wms.shipping_provider_labels AS label
         ON label.id = NULLIF(exception.details->>'shippingProviderLabelId', '')::bigint
       WHERE exception.id = $1::bigint
         AND exception.rule = $2
         AND exception.status IN ('open', 'acknowledged')
       LIMIT 1`,
      [exceptionId, HISTORICAL_SHIPSTATION_CONTENTS_REVIEW_RULE],
    );
    return result.rows.length === 0 ? null : snapshotFromRow(result.rows[0]);
  }

  async upsertReview(
    record: HistoricalShipStationContentsReviewRecord,
  ): Promise<PersistedHistoricalShipStationContentsReview> {
    return withSerializable(this.pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock($1, hashtext($2))",
        [918409, record.candidate.shippingProviderLabelId],
      );
      const lockedCandidate = await loadHistoricalShipStationContentsSystemRecoveryCandidate(
        client,
        record.candidate.shippingProviderLabelId,
        true,
      );
      if (lockedCandidate === null || canonicalJson(lockedCandidate) !== canonicalJson({
        shippingProviderLabelId: record.candidate.shippingProviderLabelId,
        providerShipmentId: record.candidate.providerShipmentId,
        trackingNumber: record.candidate.trackingNumber,
        labelStatus: record.candidate.labelStatus,
        expectedContents: record.candidate.expectedContents,
      })) {
        throw new HistoricalShipStationContentsReviewRepositoryError(
          "CONCURRENT_WRITE",
          "Historical contents candidate changed while its review was being persisted",
        );
      }
      const details = reviewDetails(record);
      const wmsOrderId = record.candidate.wmsOrders.length === 1
        ? record.candidate.wmsOrders[0].wmsOrderId
        : null;
      const legacyShipments = record.candidate.linkedShipments.filter(
        (shipment) => shipment.source === "legacy_wms_shipment",
      );
      const wmsShipmentId = legacyShipments.length === 1
        ? Number(legacyShipments[0].shipmentId)
        : null;
      const orderRef = record.candidate.wmsOrders.length === 1
        ? record.candidate.wmsOrders[0].orderNumber
        : record.candidate.shipStationOrderId;
      const summary = [
        orderRef ? `Order ${orderRef}` : "Historical shipment",
        `tracking ${record.candidate.trackingNumber}`,
        `has conflicting ShipStation and WMS package contents (${record.providerRecoveryStatus}).`,
      ].join(" ");
      const existing = await client.query(
        `SELECT id::text AS id, details
         FROM wms.reconciliation_exceptions
         WHERE idempotency_key = $1
           AND status IN ('open', 'acknowledged')
         FOR UPDATE`,
        [`historical_shipstation_contents_review:label:${record.candidate.shippingProviderLabelId}`],
      );
      if (existing.rows.length > 1) {
        throw new HistoricalShipStationContentsReviewRepositoryError(
          "INVALID_DATABASE_EVIDENCE",
          "Historical contents review identity is duplicated",
        );
      }
      if (existing.rows.length === 1) {
        const exact = canonicalJson(reviewEvidenceDetails(existing.rows[0].details))
          === canonicalJson(reviewEvidenceDetails(details));
        if (exact) {
          await client.query(
            `UPDATE wms.reconciliation_exceptions
             SET last_seen_at = transaction_timestamp(),
                 occurrence_count = occurrence_count + 1,
                 summary = $2,
                 updated_at = transaction_timestamp()
             WHERE id = $1::bigint`,
            [existing.rows[0].id, summary],
          );
        } else {
          const prior = existing.rows[0].details as Record<string, unknown>;
          const refreshedDetails = {
            ...details,
            decisionHistory: Array.isArray(prior.decisionHistory)
              ? prior.decisionHistory
              : [],
          };
          await client.query(
            `UPDATE wms.reconciliation_exceptions
             SET classification = 'manual_review',
                 status = 'open',
                 severity = 'review',
                 last_seen_at = transaction_timestamp(),
                 occurrence_count = occurrence_count + 1,
                 details = $2::jsonb,
                 summary = $3,
                 resolved_at = NULL,
                 resolved_by = NULL,
                 resolution = NULL,
                 updated_at = transaction_timestamp()
             WHERE id = $1::bigint`,
            [existing.rows[0].id, JSON.stringify(refreshedDetails), summary],
          );
        }
        return Object.freeze({
          kind: exact ? "already_persisted" as const : "updated" as const,
          exceptionId: positiveBigintText(existing.rows[0].id, "exceptionId"),
          shippingProviderLabelId: record.candidate.shippingProviderLabelId,
        });
      }
      const inserted = await client.query(
        `INSERT INTO wms.reconciliation_exceptions (
           source, classification, rule, status, severity,
           wms_order_id, wms_shipment_id,
           external_system, external_order_ref, external_shipment_ref,
           idempotency_key, summary, details
         ) VALUES (
           'historical_shipstation_contents_system_recovery',
           'manual_review', $1, 'open', 'review',
           $2, $3, 'shipstation', $4, $5, $6, $7, $8::jsonb
         )
         RETURNING id::text AS id`,
        [
          HISTORICAL_SHIPSTATION_CONTENTS_REVIEW_RULE,
          wmsOrderId,
          wmsShipmentId,
          record.candidate.shipStationOrderId,
          String(record.candidate.providerShipmentId),
          `historical_shipstation_contents_review:label:${record.candidate.shippingProviderLabelId}`,
          summary,
          JSON.stringify(details),
        ],
      );
      return Object.freeze({
        kind: "created" as const,
        exceptionId: positiveBigintText(inserted.rows[0]?.id, "exceptionId"),
        shippingProviderLabelId: record.candidate.shippingProviderLabelId,
      });
    });
  }

  async loadWmsResolutionReplay(
    input: Parameters<HistoricalShipStationContentsReviewRepository["loadWmsResolutionReplay"]>[0],
  ): Promise<PersistedHistoricalShipStationContentsWmsResolution | null> {
    const result = await this.pool.query(
      `SELECT id::text AS id,
              details->>'shippingProviderLabelId' AS shipping_provider_label_id,
              details->>'decisionPreviewEvidenceHash' AS decision_preview_evidence_hash,
              details->>'decisionActorUserId' AS decision_actor_user_id,
              details->>'decisionReason' AS decision_reason,
              details->>'resolutionLabelEventId' AS resolution_label_event_id,
              details->>'resolutionEventHash' AS resolution_event_hash
       FROM wms.reconciliation_exceptions
       WHERE id = $1::bigint
         AND rule = $2
         AND status = 'resolved'
         AND details->>'decision' = 'wms_confirmed'
       LIMIT 1`,
      [input.exceptionId, HISTORICAL_SHIPSTATION_CONTENTS_REVIEW_RULE],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (
      row.decision_preview_evidence_hash !== input.expectedPreviewHash
      || row.decision_actor_user_id !== input.actorUserId
      || row.decision_reason !== input.reason
    ) {
      return null;
    }
    return Object.freeze({
      kind: "already_persisted" as const,
      exceptionId: positiveBigintText(row.id, "exceptionId"),
      shippingProviderLabelId: positiveBigintText(
        row.shipping_provider_label_id,
        "shippingProviderLabelId",
      ),
      labelEventId: positiveBigintText(row.resolution_label_event_id, "resolutionLabelEventId"),
      eventHash: exactEvidenceHash(row.resolution_event_hash, "resolutionEventHash"),
    });
  }

  async confirmWmsContents(input: Parameters<HistoricalShipStationContentsReviewRepository["confirmWmsContents"]>[0]) {
    return withSerializable(this.pool, async (client): Promise<PersistedHistoricalShipStationContentsWmsResolution> => {
      const actorRole = await authorizedActor(client, input.actorUserId);
      const exceptionResult = await client.query(
        `SELECT exception.id::text AS id, exception.details,
                exception.details->'providerEvidence'->>'recoveryStatus' AS review_reason,
                label.label_status
         FROM wms.reconciliation_exceptions AS exception
         JOIN wms.shipping_provider_labels AS label
           ON label.id = NULLIF(exception.details->>'shippingProviderLabelId', '')::bigint
         WHERE exception.id = $1::bigint
           AND exception.rule = $2
           AND exception.status IN ('open', 'acknowledged')
         FOR UPDATE OF exception, label`,
        [input.snapshot.exceptionId, HISTORICAL_SHIPSTATION_CONTENTS_REVIEW_RULE],
      );
      if (exceptionResult.rows.length !== 1) {
        throw new HistoricalShipStationContentsReviewRepositoryError(
          "REVIEW_NOT_FOUND",
          "Historical contents review is no longer open",
        );
      }
      const lockedSnapshot = snapshotFromRow(exceptionResult.rows[0]);
      if (canonicalJson(lockedSnapshot) !== canonicalJson(input.snapshot)) {
        throw new HistoricalShipStationContentsReviewRepositoryError(
          "CONCURRENT_WRITE",
          "Historical contents review changed while it was being authorized",
        );
      }
      const lockedCandidate = await loadHistoricalShipStationContentsSystemRecoveryCandidate(
        client,
        input.snapshot.candidate.shippingProviderLabelId,
        true,
      );
      if (lockedCandidate === null || canonicalJson(lockedCandidate) !== canonicalJson({
        shippingProviderLabelId: input.snapshot.candidate.shippingProviderLabelId,
        providerShipmentId: input.snapshot.candidate.providerShipmentId,
        trackingNumber: input.snapshot.candidate.trackingNumber,
        labelStatus: input.snapshot.candidate.labelStatus,
        expectedContents: input.snapshot.candidate.expectedContents,
      })) {
        throw new HistoricalShipStationContentsReviewRepositoryError(
          "CONCURRENT_WRITE",
          "Historical contents candidate changed while it was being authorized",
        );
      }
      const resolved = await client.query(
        `SELECT event.id::text AS id
         FROM wms.shipping_provider_label_events AS event
         WHERE event.shipping_provider_label_id = $1::bigint
           AND event.event_type IN ('label_observed', 'label_voided')
           AND (
             NOT (event.sanitized_payload ? 'payloadSchemaVersion')
             OR event.sanitized_payload->>'payloadSchemaVersion' = '1'
             OR (
               event.sanitized_payload->>'payloadSchemaVersion' = '2'
               AND event.sanitized_payload->'declaredContentsEvidence'->>'status'
                 IS DISTINCT FROM 'authoritative'
             )
           )
         ORDER BY event.id
         LIMIT $2::integer
         FOR KEY SHARE`,
        [input.snapshot.candidate.shippingProviderLabelId, MAX_RESOLVED_EVENTS + 1],
      );
      if (resolved.rows.length < 1 || resolved.rows.length > MAX_RESOLVED_EVENTS) {
        throw new HistoricalShipStationContentsReviewRepositoryError(
          "INVALID_DATABASE_EVIDENCE",
          "Historical contents review has no bounded non-authoritative evidence to resolve",
        );
      }
      const event = buildHistoricalShipStationContentsSystemRecoveryEvent({
        shippingProviderLabelId: input.snapshot.candidate.shippingProviderLabelId,
        providerShipmentId: input.snapshot.candidate.providerShipmentId,
        trackingNumber: input.snapshot.candidate.trackingNumber,
        labelStatus: input.snapshot.candidate.labelStatus,
        recoveryEvidence: input.recoveryEvidence,
        resolvedLabelEventIds: resolved.rows.map((row) => positiveInteger(row.id, "labelEventId")),
        authorization: {
          actorUserId: input.actorUserId,
          actorRole,
          reason: input.reason,
        },
      });
      const inserted = await client.query(
        `INSERT INTO wms.shipping_provider_label_events (
           shipping_provider_label_id, event_hash, event_type, label_status,
           tracking_number, provider_occurred_at, sanitized_payload, received_at
         ) VALUES ($1::bigint, $2, $3, $4, $5, NULL, $6::jsonb, transaction_timestamp())
         ON CONFLICT (shipping_provider_label_id, event_hash) DO NOTHING
         RETURNING id::text AS id`,
        [
          input.snapshot.candidate.shippingProviderLabelId,
          event.eventHash,
          event.eventType,
          event.labelStatus,
          event.trackingNumber,
          JSON.stringify(event.sanitizedPayload),
        ],
      );
      let kind: "created" | "already_persisted" = "created";
      let labelEventId: string;
      if (inserted.rows.length === 1) {
        labelEventId = positiveBigintText(inserted.rows[0].id, "labelEventId");
      } else {
        const prior = await client.query(
          `SELECT id::text AS id, sanitized_payload
           FROM wms.shipping_provider_label_events
           WHERE shipping_provider_label_id = $1::bigint
             AND event_hash = $2
           FOR KEY SHARE`,
          [input.snapshot.candidate.shippingProviderLabelId, event.eventHash],
        );
        if (prior.rows.length !== 1 || canonicalJson(prior.rows[0].sanitized_payload) !== canonicalJson(event.sanitizedPayload)) {
          throw new HistoricalShipStationContentsReviewRepositoryError(
            "REVIEW_CONFLICT",
            "Historical contents resolution replay differs from persisted evidence",
          );
        }
        kind = "already_persisted";
        labelEventId = positiveBigintText(prior.rows[0].id, "labelEventId");
      }
      await client.query(
        `UPDATE wms.reconciliation_exceptions
         SET classification = 'safe_auto_repair',
             status = 'resolved',
             severity = 'info',
             details = details || $2::jsonb,
             resolved_at = transaction_timestamp(),
             resolved_by = $3,
             resolution = $4,
             updated_at = transaction_timestamp()
         WHERE id = $1::bigint`,
        [
          input.snapshot.exceptionId,
           JSON.stringify({
             decision: "wms_confirmed",
             decisionPreviewEvidenceHash: input.expectedPreviewHash,
             decisionActorUserId: input.actorUserId,
             decisionReason: input.reason,
             resolutionLabelEventId: labelEventId,
            resolutionEventHash: event.eventHash,
          }),
          input.actorUserId,
          input.reason,
        ],
      );
      return Object.freeze({
        kind,
        exceptionId: input.snapshot.exceptionId!,
        shippingProviderLabelId: input.snapshot.candidate.shippingProviderLabelId,
        labelEventId,
        eventHash: event.eventHash,
      });
    });
  }

  async recordDecision(input: Parameters<HistoricalShipStationContentsReviewRepository["recordDecision"]>[0]) {
    return withSerializable(this.pool, async (client) => {
      const actorRole = await authorizedActor(client, input.actorUserId);
      const locked = await client.query(
        `SELECT exception.id::text AS id, exception.details,
                exception.details->'providerEvidence'->>'recoveryStatus' AS review_reason,
                label.label_status
         FROM wms.reconciliation_exceptions AS exception
         JOIN wms.shipping_provider_labels AS label
           ON label.id = NULLIF(exception.details->>'shippingProviderLabelId', '')::bigint
         WHERE exception.id = $1::bigint
           AND exception.rule = $2
           AND exception.status IN ('open', 'acknowledged')
         FOR UPDATE OF exception, label`,
        [input.exceptionId, HISTORICAL_SHIPSTATION_CONTENTS_REVIEW_RULE],
      );
      if (locked.rows.length !== 1) {
        throw new HistoricalShipStationContentsReviewRepositoryError(
          "REVIEW_NOT_FOUND",
          "Historical contents review is no longer open",
        );
      }
      const persistedDetails = locked.rows[0].details;
      if (
        persistedDetails === null
        || typeof persistedDetails !== "object"
        || Array.isArray(persistedDetails)
      ) {
        throw new HistoricalShipStationContentsReviewRepositoryError(
          "INVALID_DATABASE_EVIDENCE",
          "Historical contents review details are not an object",
        );
      }
      snapshotFromRow(locked.rows[0]);
      const persistedRecord = persistedDetails as Record<string, unknown>;
      const auditEvidence = Object.freeze({
        contract: "historical_shipstation_contents_review_decision_v1",
        exceptionId: input.exceptionId,
        previewEvidenceHash: input.expectedPreviewHash,
        actorUserId: input.actorUserId,
        actorRole,
        decision: input.decision,
        reason: input.reason,
        providerEvidence: persistedRecord.providerEvidence,
        wmsEvidence: persistedRecord.wmsEvidence,
      });
      const evidenceHash = decisionHash(auditEvidence);
      if (persistedRecord.decisionHash === evidenceHash) {
        return Object.freeze({
          exceptionId: positiveBigintText(locked.rows[0].id, "exceptionId"),
          status: "acknowledged" as const,
        });
      }
      const history = persistedRecord.decisionHistory ?? [];
      if (!Array.isArray(history) || history.length >= MAX_DECISION_HISTORY) {
        throw new HistoricalShipStationContentsReviewRepositoryError(
          "INVALID_DATABASE_EVIDENCE",
          "Historical contents review decision history is invalid or exceeds its safety bound",
          Object.freeze({ maxDecisionHistory: MAX_DECISION_HISTORY }),
        );
      }
      const result = await client.query(
        `UPDATE wms.reconciliation_exceptions
         SET classification = $2,
             status = 'acknowledged',
             severity = $3,
             details = details
               || $4::jsonb
               || jsonb_build_object(
                    'decisionRecordedAt', transaction_timestamp(),
                    'decisionHistory',
                    COALESCE(details->'decisionHistory', '[]'::jsonb)
                      || jsonb_build_array(
                           $5::jsonb || jsonb_build_object(
                             'decisionHash', $6::text,
                             'recordedAt', transaction_timestamp()
                           )
                         )
                  ),
             resolved_by = NULL,
             resolution = NULL,
             updated_at = transaction_timestamp()
         WHERE id = $1::bigint
           AND rule = $7
           AND status IN ('open', 'acknowledged')
         RETURNING id::text AS id, status`,
        [
          input.exceptionId,
          input.decision === "provider_confirmed_pending_inventory_correction"
            ? "hard_block"
            : "manual_review",
          input.decision === "provider_confirmed_pending_inventory_correction"
            ? "blocker"
            : "review",
          JSON.stringify({
             decision: input.decision,
             decisionPreviewEvidenceHash: input.expectedPreviewHash,
             decisionActorUserId: input.actorUserId,
             decisionActorRole: actorRole,
             decisionReason: input.reason,
             decisionHash: evidenceHash,
             inventoryCorrectionRequired:
               input.decision === "provider_confirmed_pending_inventory_correction",
           }),
           JSON.stringify(auditEvidence),
           evidenceHash,
           HISTORICAL_SHIPSTATION_CONTENTS_REVIEW_RULE,
        ],
      );
      if (result.rows.length !== 1) {
        throw new HistoricalShipStationContentsReviewRepositoryError(
          "REVIEW_NOT_FOUND",
          "Historical contents review is no longer open",
        );
      }
      return Object.freeze({
        exceptionId: positiveBigintText(result.rows[0].id, "exceptionId"),
        status: "acknowledged" as const,
      });
    });
  }
}
