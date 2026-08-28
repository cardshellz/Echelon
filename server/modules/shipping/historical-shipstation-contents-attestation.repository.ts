import type { Pool, PoolClient } from "pg";

import { canonicalJson } from "@shared/utils/canonical-json";

import {
  loadHistoricalShipStationExpectedContents,
  type HistoricalShipStationContentsCandidate,
} from "./historical-shipstation-contents-audit.repository";
import type {
  HistoricalShipStationContentsRecoveryEvidence,
} from "./historical-shipstation-contents-recovery.domain";

const POSTGRES_BIGINT_MAX = BigInt("9223372036854775807");
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_RESOLVED_EVENTS = 500;
const MAX_REVIEW_CONTEXT_REFERENCES = 100;

type QueryResult = Readonly<{ readonly rows: readonly Record<string, unknown>[] }>;
type QueryClient = Readonly<{
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}>;

export type HistoricalShipStationContentsAttestationRepositoryErrorCode =
  | "ATTESTATION_CONFLICT"
  | "CONCURRENT_WRITE"
  | "DATABASE_ERROR"
  | "INVALID_DATABASE_EVIDENCE"
  | "TRANSACTION_CLEANUP_FAILED";

export class HistoricalShipStationContentsAttestationRepositoryError extends Error {
  constructor(
    readonly code: HistoricalShipStationContentsAttestationRepositoryErrorCode,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = Object.freeze({}),
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HistoricalShipStationContentsAttestationRepositoryError";
  }
}

export interface AuthorizedHistoricalContentsAttestationActor {
  readonly userId: string;
  readonly role: "admin" | "lead";
}

export interface HistoricalShipStationContentsAttestationRecord {
  readonly shippingProviderLabelId: string;
  readonly recoveryEvidence: HistoricalShipStationContentsRecoveryEvidence;
  readonly previewEvidenceHash: string;
  readonly actor: AuthorizedHistoricalContentsAttestationActor;
  readonly reason: string;
  readonly attestationHash: string;
  readonly resolvedLabelEventIds: readonly string[];
}

export interface PersistedHistoricalShipStationContentsAttestation {
  readonly kind: "created" | "already_persisted";
  readonly attestationId: string;
  readonly shippingProviderLabelId: string;
  readonly previewEvidenceHash: string;
  readonly resolvedEventCount: number;
}

export interface HistoricalShipStationContentsAttestationReviewContext {
  readonly trackingNumber: string;
  readonly shipStationOrderId: string | null;
  readonly wmsOrders: readonly Readonly<{
    wmsOrderId: number;
    orderNumber: string;
  }>[];
  readonly linkedShipments: readonly Readonly<{
    source: "physical_shipment" | "legacy_wms_shipment";
    shipmentId: string;
  }>[];
  readonly linePresentations: readonly Readonly<{
    wmsShipmentItemId: number;
    itemName: string | null;
  }>[];
}

export interface HistoricalShipStationContentsAttestationReviewSnapshot {
  readonly candidate: HistoricalShipStationContentsCandidate;
  readonly reviewContext: HistoricalShipStationContentsAttestationReviewContext;
}

export interface HistoricalShipStationContentsAttestationTransaction {
  lockAuthorizedActor(userId: string): Promise<AuthorizedHistoricalContentsAttestationActor | null>;
  loadCandidateForUpdate(
    shippingProviderLabelId: string,
  ): Promise<HistoricalShipStationContentsCandidate | null>;
  loadResolvableLabelEventIds(shippingProviderLabelId: string): Promise<readonly string[]>;
  appendExactAttestation(
    record: HistoricalShipStationContentsAttestationRecord,
  ): Promise<PersistedHistoricalShipStationContentsAttestation>;
}

export interface HistoricalShipStationContentsAttestationRepository {
  loadReviewSnapshot(
    shippingProviderLabelId: string,
  ): Promise<HistoricalShipStationContentsAttestationReviewSnapshot | null>;
  withSerializableTransaction<T>(
    work: (transaction: HistoricalShipStationContentsAttestationTransaction) => Promise<T>,
  ): Promise<T>;
}

function postgresMetadata(error: unknown): Readonly<{
  code: string | null;
  constraint: string | null;
}> {
  if (error === null || typeof error !== "object") {
    return { code: null, constraint: null };
  }
  const candidate = error as { readonly code?: unknown; readonly constraint?: unknown };
  return {
    code: typeof candidate.code === "string" ? candidate.code : null,
    constraint: typeof candidate.constraint === "string" ? candidate.constraint : null,
  };
}

function classifyDatabaseError(error: unknown): HistoricalShipStationContentsAttestationRepositoryError {
  if (error instanceof HistoricalShipStationContentsAttestationRepositoryError) return error;
  const metadata = postgresMetadata(error);
  if (["40001", "40P01", "55P03"].includes(metadata.code ?? "")) {
    return new HistoricalShipStationContentsAttestationRepositoryError(
      "CONCURRENT_WRITE",
      "Historical contents attestation encountered a concurrent database write",
      Object.freeze({ postgresCode: metadata.code }),
      { cause: error },
    );
  }
  if (metadata.code === "23505") {
    return new HistoricalShipStationContentsAttestationRepositoryError(
      "ATTESTATION_CONFLICT",
      "Historical contents evidence was already resolved by a different attestation",
      Object.freeze({ constraint: metadata.constraint }),
      { cause: error },
    );
  }
  return new HistoricalShipStationContentsAttestationRepositoryError(
    "DATABASE_ERROR",
    "Historical contents attestation database operation failed",
    Object.freeze({ postgresCode: metadata.code, constraint: metadata.constraint }),
    { cause: error },
  );
}

function positiveBigintText(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || !/^[1-9][0-9]*$/.test(value)
    || BigInt(value) > POSTGRES_BIGINT_MAX
  ) {
    throw new HistoricalShipStationContentsAttestationRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Historical contents attestation received invalid ${field}`,
    );
  }
  return value;
}

function exactText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new HistoricalShipStationContentsAttestationRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Historical contents attestation received invalid ${field}`,
    );
  }
  return value;
}

function exactBoundedText(value: unknown, field: string, maximum: number): string {
  const parsed = exactText(value, field);
  if (parsed.length > maximum) {
    throw new HistoricalShipStationContentsAttestationRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Historical contents attestation received oversized ${field}`,
    );
  }
  return parsed;
}

function optionalExactBoundedText(value: unknown, field: string, maximum: number): string | null {
  return value === null || value === undefined
    ? null
    : exactBoundedText(value, field, maximum);
}

function positiveSafeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new HistoricalShipStationContentsAttestationRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Historical contents attestation received invalid ${field}`,
    );
  }
  return parsed;
}

function positivePostgresInteger(value: unknown, field: string): number {
  const parsed = positiveSafeInteger(value, field);
  if (parsed > POSTGRES_INTEGER_MAX) {
    throw new HistoricalShipStationContentsAttestationRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Historical contents attestation received out-of-range ${field}`,
    );
  }
  return parsed;
}

function canonicalEquals(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

class PgHistoricalShipStationContentsAttestationTransaction
implements HistoricalShipStationContentsAttestationTransaction {
  constructor(private readonly client: QueryClient) {}

  private async query(text: string, values: unknown[] = []): Promise<QueryResult> {
    try {
      return await this.client.query(text, values);
    } catch (error) {
      throw classifyDatabaseError(error);
    }
  }

  async lockAuthorizedActor(
    userId: string,
  ): Promise<AuthorizedHistoricalContentsAttestationActor | null> {
    const result = await this.query(
      `SELECT id, role, active
       FROM identity.users
       WHERE id = $1
       FOR UPDATE`,
      [userId],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) {
      throw new HistoricalShipStationContentsAttestationRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Historical contents attestation received duplicate actor identity",
      );
    }
    const row = result.rows[0];
    const id = exactText(row.id, "actor_user_id");
    const role = exactText(row.role, "actor_role");
    const active = Number(row.active);
    if (id !== userId || active !== 1 || (role !== "admin" && role !== "lead")) return null;
    return Object.freeze({ userId: id, role });
  }

  async loadCandidateForUpdate(
    shippingProviderLabelId: string,
  ): Promise<HistoricalShipStationContentsCandidate | null> {
    return loadCandidate(this.client, shippingProviderLabelId, true);
  }

  async loadResolvableLabelEventIds(
    shippingProviderLabelId: string,
  ): Promise<readonly string[]> {
    const result = await this.query(
      `SELECT event.id::text AS label_event_id
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
      [shippingProviderLabelId, MAX_RESOLVED_EVENTS + 1],
    );
    if (result.rows.length > MAX_RESOLVED_EVENTS) {
      throw new HistoricalShipStationContentsAttestationRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Historical contents attestation resolution set exceeds its safety bound",
        Object.freeze({ maxResolvedEvents: MAX_RESOLVED_EVENTS }),
      );
    }
    const ids = result.rows.map((row) => positiveBigintText(row.label_event_id, "label_event_id"));
    if (new Set(ids).size !== ids.length) {
      throw new HistoricalShipStationContentsAttestationRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Historical contents attestation received duplicate resolution evidence",
      );
    }
    return Object.freeze(ids);
  }

  async appendExactAttestation(
    record: HistoricalShipStationContentsAttestationRecord,
  ): Promise<PersistedHistoricalShipStationContentsAttestation> {
    const inserted = await this.query(
      `INSERT INTO wms.shipping_provider_label_content_attestations (
         shipping_provider_label_id,
         recovery_contract_version,
         recovery_status,
         preview_evidence_hash,
         provider_evidence_hash,
         attested_contents,
         actor_user_id,
         actor_role,
         reason,
         attestation_hash
       ) VALUES (
         $1::bigint, $2::integer, $3, $4, $5, $6::jsonb, $7, $8, $9, $10
       )
       ON CONFLICT (shipping_provider_label_id, preview_evidence_hash) DO NOTHING
       RETURNING id::text AS attestation_id`,
      [
        record.shippingProviderLabelId,
        record.recoveryEvidence.contractVersion,
        record.recoveryEvidence.recoveryStatus,
        record.previewEvidenceHash,
        record.recoveryEvidence.evidenceHash,
        JSON.stringify(record.recoveryEvidence.attestedContents),
        record.actor.userId,
        record.actor.role,
        record.reason,
        record.attestationHash,
      ],
    );

    if (inserted.rows.length === 1) {
      const attestationId = positiveBigintText(inserted.rows[0].attestation_id, "attestation_id");
      const resolutions = await this.query(
        `INSERT INTO wms.shipping_provider_label_content_attestation_resolutions (
           shipping_provider_label_content_attestation_id,
           shipping_provider_label_id,
           shipping_provider_label_event_id
         )
         SELECT $1::bigint, $2::bigint, source.event_id
         FROM UNNEST($3::bigint[]) AS source(event_id)
         ORDER BY source.event_id
         RETURNING shipping_provider_label_event_id::text AS label_event_id`,
        [attestationId, record.shippingProviderLabelId, [...record.resolvedLabelEventIds]],
      );
      if (resolutions.rows.length !== record.resolvedLabelEventIds.length) {
        throw new HistoricalShipStationContentsAttestationRepositoryError(
          "INVALID_DATABASE_EVIDENCE",
          "Historical contents attestation did not persist every resolution reference",
        );
      }
      return Object.freeze({
        kind: "created",
        attestationId,
        shippingProviderLabelId: record.shippingProviderLabelId,
        previewEvidenceHash: record.previewEvidenceHash,
        resolvedEventCount: record.resolvedLabelEventIds.length,
      });
    }
    if (inserted.rows.length !== 0) {
      throw new HistoricalShipStationContentsAttestationRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Historical contents attestation insert returned an invalid row count",
      );
    }

    const existing = await this.query(
      `SELECT
         attestation.id::text AS attestation_id,
         attestation.recovery_contract_version,
         attestation.recovery_status,
         attestation.provider_evidence_hash,
         attestation.attested_contents,
         attestation.actor_user_id,
         attestation.actor_role,
         attestation.reason,
         attestation.attestation_hash
       FROM wms.shipping_provider_label_content_attestations AS attestation
       WHERE attestation.shipping_provider_label_id = $1::bigint
         AND attestation.preview_evidence_hash = $2
       FOR KEY SHARE`,
      [record.shippingProviderLabelId, record.previewEvidenceHash],
    );
    if (existing.rows.length !== 1) {
      throw new HistoricalShipStationContentsAttestationRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Historical contents attestation replay row is missing or duplicated",
      );
    }
    const row = existing.rows[0];
    const attestationId = positiveBigintText(row.attestation_id, "attestation_id");
    const resolved = await this.query(
      `SELECT resolution.shipping_provider_label_event_id::text AS label_event_id
       FROM wms.shipping_provider_label_content_attestation_resolutions AS resolution
       WHERE resolution.shipping_provider_label_content_attestation_id = $1::bigint
       ORDER BY resolution.shipping_provider_label_event_id
       FOR KEY SHARE`,
      [attestationId],
    );
    const resolvedIds = resolved.rows.map((item) => (
      positiveBigintText(item.label_event_id, "label_event_id")
    ));
    const exact = Number(row.recovery_contract_version) === record.recoveryEvidence.contractVersion
      && row.recovery_status === record.recoveryEvidence.recoveryStatus
      && row.provider_evidence_hash === record.recoveryEvidence.evidenceHash
      && canonicalEquals(row.attested_contents, record.recoveryEvidence.attestedContents)
      && row.actor_user_id === record.actor.userId
      && row.actor_role === record.actor.role
      && row.reason === record.reason
      && row.attestation_hash === record.attestationHash
      && canonicalEquals(resolvedIds, record.resolvedLabelEventIds);
    if (!exact) {
      throw new HistoricalShipStationContentsAttestationRepositoryError(
        "ATTESTATION_CONFLICT",
        "Historical contents preview fingerprint is already attached to different audit evidence",
      );
    }
    return Object.freeze({
      kind: "already_persisted",
      attestationId,
      shippingProviderLabelId: record.shippingProviderLabelId,
      previewEvidenceHash: record.previewEvidenceHash,
      resolvedEventCount: resolvedIds.length,
    });
  }
}

async function loadCandidate(
  client: QueryClient,
  shippingProviderLabelId: string,
  lockRow: boolean,
): Promise<HistoricalShipStationContentsCandidate | null> {
  let result: QueryResult;
  try {
    result = await client.query(
      `SELECT
         label.id::text AS shipping_provider_label_id,
         label.provider_label_id,
         label.tracking_number
       FROM wms.shipping_provider_labels AS label
       WHERE label.id = $1::bigint
         AND label.provider = 'shipstation'
         AND label.label_direction = 'outbound'
         AND label.provider_label_id ~ '^[1-9][0-9]*$'
         AND EXISTS (
           SELECT 1
           FROM wms.shipping_provider_label_events AS historical_event
           WHERE historical_event.shipping_provider_label_id = label.id
             AND (
               NOT (historical_event.sanitized_payload ? 'payloadSchemaVersion')
               OR historical_event.sanitized_payload->>'payloadSchemaVersion' = '1'
             )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM wms.shipping_provider_label_events AS current_event
           WHERE current_event.shipping_provider_label_id = label.id
             AND current_event.sanitized_payload->>'payloadSchemaVersion' = '2'
             AND current_event.sanitized_payload->'declaredContentsEvidence'->>'status'
               = 'authoritative'
         )
       ${lockRow ? "FOR UPDATE" : ""}`,
      [shippingProviderLabelId],
    );
  } catch (error) {
    throw classifyDatabaseError(error);
  }
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) {
    throw new HistoricalShipStationContentsAttestationRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Historical contents attestation candidate identity is duplicated",
    );
  }
  const row = result.rows[0];
  const labelId = positiveBigintText(row.shipping_provider_label_id, "shipping_provider_label_id");
  const providerLabelId = exactText(row.provider_label_id, "provider_label_id");
  if (!/^[1-9][0-9]*$/.test(providerLabelId)) {
    throw new HistoricalShipStationContentsAttestationRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Historical contents attestation provider shipment identity is invalid",
    );
  }
  const providerShipmentId = positiveSafeInteger(providerLabelId, "provider_shipment_id");
  let expectedContents;
  try {
    expectedContents = await loadHistoricalShipStationExpectedContents(
      client as unknown as Pick<PoolClient, "query">,
      labelId,
    );
  } catch (error) {
    throw classifyDatabaseError(error);
  }
  return Object.freeze({
    shippingProviderLabelId: labelId,
    providerShipmentId,
    expectedContents,
  });
}

async function loadReviewContext(
  client: QueryClient,
  candidate: HistoricalShipStationContentsCandidate,
): Promise<HistoricalShipStationContentsAttestationReviewContext> {
  const identityResult = await client.query(
    `SELECT
       label.tracking_number,
       NULLIF(BTRIM(label.provider_order_id), '') AS provider_order_id
     FROM wms.shipping_provider_labels AS label
     WHERE label.id = $1::bigint
       AND label.provider = 'shipstation'
       AND label.label_direction = 'outbound'`,
    [candidate.shippingProviderLabelId],
  );
  if (identityResult.rows.length !== 1) {
    throw new HistoricalShipStationContentsAttestationRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Historical contents review identity is missing or duplicated",
    );
  }
  const identity = identityResult.rows[0];
  const trackingNumber = exactBoundedText(identity.tracking_number, "tracking_number", 200);
  const shipStationOrderId = optionalExactBoundedText(
    identity.provider_order_id,
    "provider_order_id",
    200,
  );

  const linksResult = await client.query(
    `SELECT
       link.physical_shipment_id::text AS physical_shipment_id,
       link.legacy_wms_shipment_id::text AS legacy_wms_shipment_id
     FROM wms.shipping_provider_label_links AS link
     WHERE link.shipping_provider_label_id = $1::bigint
     ORDER BY link.id
     LIMIT $2::integer`,
    [candidate.shippingProviderLabelId, MAX_REVIEW_CONTEXT_REFERENCES + 1],
  );
  if (linksResult.rows.length > MAX_REVIEW_CONTEXT_REFERENCES) {
    throw new HistoricalShipStationContentsAttestationRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Historical contents review shipment references exceed the safety bound",
    );
  }
  const linkedShipmentKeys = new Set<string>();
  const linkedShipments: HistoricalShipStationContentsAttestationReviewContext[
    "linkedShipments"
  ][number][] = [];
  for (const row of linksResult.rows) {
    for (const [source, rawId] of [
      ["physical_shipment", row.physical_shipment_id],
      ["legacy_wms_shipment", row.legacy_wms_shipment_id],
    ] as const) {
      if (rawId === null || rawId === undefined) continue;
      const shipmentId = positiveBigintText(rawId, `${source}_id`);
      const key = `${source}:${shipmentId}`;
      if (linkedShipmentKeys.has(key)) {
        throw new HistoricalShipStationContentsAttestationRepositoryError(
          "INVALID_DATABASE_EVIDENCE",
          "Historical contents review received a duplicate linked shipment",
        );
      }
      linkedShipmentKeys.add(key);
      linkedShipments.push(Object.freeze({ source, shipmentId }));
    }
  }
  if (linkedShipments.length > MAX_REVIEW_CONTEXT_REFERENCES) {
    throw new HistoricalShipStationContentsAttestationRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Historical contents review shipment references exceed the safety bound",
    );
  }
  linkedShipments.sort((left, right) => {
    const sourceComparison = left.source < right.source
      ? -1
      : left.source > right.source
        ? 1
        : 0;
    if (sourceComparison !== 0) return sourceComparison;
    const leftId = BigInt(left.shipmentId);
    const rightId = BigInt(right.shipmentId);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });

  const expectedLineIds = candidate.expectedContents.kind === "available"
    ? candidate.expectedContents.lines.map((line) => line.wmsShipmentItemId)
    : [];
  const ordersResult = await client.query(
    `WITH links AS MATERIALIZED (
       SELECT link.*
       FROM wms.shipping_provider_label_links AS link
       WHERE link.shipping_provider_label_id = $1::bigint
     ), order_ids(order_id) AS (
       SELECT legacy.order_id
       FROM links
       JOIN wms.outbound_shipments AS legacy
         ON legacy.id = links.legacy_wms_shipment_id
       WHERE legacy.order_id IS NOT NULL

       UNION

       SELECT request.wms_order_id
       FROM links
       JOIN wms.shipment_requests AS request
         ON request.id = links.shipment_request_id

       UNION

       SELECT request.wms_order_id
       FROM links
       JOIN wms.shipping_engine_order_requests AS engine_request
         ON engine_request.shipping_engine_order_id = links.shipping_engine_order_id
       JOIN wms.shipment_requests AS request
         ON request.id = engine_request.shipment_request_id

       UNION

       SELECT request.wms_order_id
       FROM links
       JOIN wms.physical_shipments AS physical
         ON physical.id = links.physical_shipment_id
       JOIN wms.shipment_requests AS request
         ON request.id = physical.shipment_request_id

       UNION

       SELECT request.wms_order_id
       FROM links
       JOIN wms.physical_shipments AS physical
         ON physical.id = links.physical_shipment_id
       JOIN wms.shipping_engine_order_requests AS engine_request
         ON engine_request.shipping_engine_order_id = physical.shipping_engine_order_id
       JOIN wms.shipment_requests AS request
         ON request.id = engine_request.shipment_request_id

       UNION

       SELECT order_item.order_id
       FROM wms.outbound_shipment_items AS shipment_item
       JOIN wms.order_items AS order_item
         ON order_item.id = shipment_item.order_item_id
       WHERE shipment_item.id = ANY($2::integer[])

       UNION

       SELECT replacement_item.order_id
       FROM wms.outbound_shipment_items AS shipment_item
       JOIN wms.order_items AS replacement_item
         ON replacement_item.id = shipment_item.replacement_for_order_item_id
       WHERE shipment_item.id = ANY($2::integer[])
     )
     SELECT orders.id::text AS wms_order_id, orders.order_number
     FROM order_ids
     JOIN wms.orders AS orders ON orders.id = order_ids.order_id
     ORDER BY orders.id
     LIMIT $3::integer`,
    [candidate.shippingProviderLabelId, expectedLineIds, MAX_REVIEW_CONTEXT_REFERENCES + 1],
  );
  if (ordersResult.rows.length > MAX_REVIEW_CONTEXT_REFERENCES) {
    throw new HistoricalShipStationContentsAttestationRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Historical contents review order references exceed the safety bound",
    );
  }
  const wmsOrders = Object.freeze(ordersResult.rows.map((row) => Object.freeze({
    wmsOrderId: positivePostgresInteger(row.wms_order_id, "wms_order_id"),
    orderNumber: exactBoundedText(row.order_number, "order_number", 50),
  })));

  const lineNamesById = new Map<number, string | null>();
  if (expectedLineIds.length > 0) {
    const lineResult = await client.query(
      `SELECT
         shipment_item.id::text AS wms_shipment_item_id,
         LEFT(NULLIF(BTRIM(CASE shipment_item.shipment_item_purpose
           WHEN 'customer_fulfillment' THEN order_item.name
           WHEN 'replacement' THEN replacement_item.name
           WHEN 'concession' THEN variant.name
           WHEN 'omission_correction' THEN variant.name
           WHEN 'unclassified' THEN variant.name
           ELSE NULL
         END), ''), 500) AS item_name
       FROM wms.outbound_shipment_items AS shipment_item
       LEFT JOIN wms.order_items AS order_item
         ON order_item.id = shipment_item.order_item_id
       LEFT JOIN wms.order_items AS replacement_item
         ON replacement_item.id = shipment_item.replacement_for_order_item_id
       LEFT JOIN catalog.product_variants AS variant
         ON variant.id = shipment_item.product_variant_id
       WHERE shipment_item.id = ANY($1::integer[])
       ORDER BY shipment_item.id`,
      [expectedLineIds],
    );
    const expectedLineIdSet = new Set(expectedLineIds);
    for (const row of lineResult.rows) {
      const wmsShipmentItemId = positivePostgresInteger(
        row.wms_shipment_item_id,
        "wms_shipment_item_id",
      );
      if (!expectedLineIdSet.has(wmsShipmentItemId) || lineNamesById.has(wmsShipmentItemId)) {
        throw new HistoricalShipStationContentsAttestationRepositoryError(
          "INVALID_DATABASE_EVIDENCE",
          "Historical contents review received unexpected or duplicate line presentation",
        );
      }
      lineNamesById.set(
        wmsShipmentItemId,
        optionalExactBoundedText(row.item_name, "item_name", 500),
      );
    }
  }
  const linePresentations = Object.freeze(expectedLineIds.map((wmsShipmentItemId) => Object.freeze({
    wmsShipmentItemId,
    itemName: lineNamesById.get(wmsShipmentItemId) ?? null,
  })));

  return Object.freeze({
    trackingNumber,
    shipStationOrderId,
    wmsOrders,
    linkedShipments: Object.freeze(linkedShipments),
    linePresentations,
  });
}

export class PgHistoricalShipStationContentsAttestationRepository
implements HistoricalShipStationContentsAttestationRepository {
  constructor(private readonly pool: Pool) {}

  async loadReviewSnapshot(
    shippingProviderLabelId: string,
  ): Promise<HistoricalShipStationContentsAttestationReviewSnapshot | null> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw classifyDatabaseError(error);
    }
    let primaryFailure: unknown;
    let rollbackFailure: unknown;
    let snapshot: HistoricalShipStationContentsAttestationReviewSnapshot | null = null;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const queryClient = client as unknown as QueryClient;
      const candidate = await loadCandidate(queryClient, shippingProviderLabelId, false);
      snapshot = candidate === null
        ? null
        : Object.freeze({
            candidate,
            reviewContext: await loadReviewContext(queryClient, candidate),
          });
      await client.query("COMMIT");
    } catch (error) {
      primaryFailure = error;
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        rollbackFailure = rollbackError;
      }
    }
    let releaseFailure: unknown;
    try {
      const discardCause = rollbackFailure ?? primaryFailure;
      client.release(discardCause instanceof Error ? discardCause : undefined);
    } catch (error) {
      releaseFailure = error;
    }
    const cleanupFailures = [rollbackFailure, releaseFailure]
      .filter((failure): failure is {} => failure !== undefined);
    if (cleanupFailures.length > 0) {
      const failures = [primaryFailure, ...cleanupFailures]
        .filter((failure): failure is {} => failure !== undefined);
      throw new HistoricalShipStationContentsAttestationRepositoryError(
        "TRANSACTION_CLEANUP_FAILED",
        "Historical contents snapshot cleanup failed",
        Object.freeze({}),
        {
          cause: failures.length === 1
            ? failures[0]
            : new AggregateError(failures),
        },
      );
    }
    if (primaryFailure !== undefined) {
      if (primaryFailure instanceof HistoricalShipStationContentsAttestationRepositoryError) {
        throw primaryFailure;
      }
      throw classifyDatabaseError(primaryFailure);
    }
    return snapshot;
  }

  async withSerializableTransaction<T>(
    work: (transaction: HistoricalShipStationContentsAttestationTransaction) => Promise<T>,
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw classifyDatabaseError(error);
    }
    let value: T | undefined;
    let primaryFailure: unknown;
    let rollbackFailure: unknown;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      value = await work(
        new PgHistoricalShipStationContentsAttestationTransaction(
          client as unknown as QueryClient,
        ),
      );
      await client.query("COMMIT");
    } catch (error) {
      primaryFailure = error;
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        rollbackFailure = rollbackError;
      }
    }
    let releaseFailure: unknown;
    try {
      const discardCause = rollbackFailure ?? primaryFailure;
      client.release(discardCause instanceof Error ? discardCause : undefined);
    } catch (error) {
      releaseFailure = error;
    }
    const cleanupFailures = [rollbackFailure, releaseFailure]
      .filter((failure): failure is {} => failure !== undefined);
    if (cleanupFailures.length > 0) {
      const failures = [primaryFailure, ...cleanupFailures]
        .filter((failure): failure is {} => failure !== undefined);
      throw new HistoricalShipStationContentsAttestationRepositoryError(
        "TRANSACTION_CLEANUP_FAILED",
        "Historical contents transaction cleanup failed",
        Object.freeze({}),
        {
          cause: failures.length === 1
            ? failures[0]
            : new AggregateError(failures),
        },
      );
    }
    if (primaryFailure !== undefined) throw primaryFailure;
    if (value === undefined) {
      throw new HistoricalShipStationContentsAttestationRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Historical contents transaction completed without a result",
      );
    }
    return value;
  }
}
