import { sql } from "drizzle-orm";

import type {
  CanonicalCarrierTrackingStatus,
  CarrierDispatchEvidence,
} from "./carrier-tracking.domain";

export interface CarrierTrackingPackageProjection {
  providerLabelId: string;
  provider: string;
  providerLabelReference: string;
  providerOrderId: string | null;
  providerOrderKey: string | null;
  trackingNumber: string;
  normalizedTrackingNumber: string;
  carrier: string | null;
  canonicalStatus: CanonicalCarrierTrackingStatus;
  dispatchEvidence: CarrierDispatchEvidence;
  dispatchConfirmed: boolean;
  statusDescription: string | null;
  eventOccurredAt: Date | null;
  estimatedDeliveryAt: Date | null;
  actualDeliveryAt: Date | null;
  latestEventId: string;
  latestMatchId: string;
  stateChangedAt: Date;
}

export interface CarrierTrackingProjectionCursor {
  stateChangedAt: Date;
  providerLabelId: string;
}

export interface ListChangedCarrierTrackingPackagesInput {
  changedSince: Date | null;
  observedThrough: Date;
  after: CarrierTrackingProjectionCursor | null;
  limit: number;
}

export interface ListChangedCarrierTrackingPackagesResult {
  packages: CarrierTrackingPackageProjection[];
  nextCursor: CarrierTrackingProjectionCursor | null;
  hasMore: boolean;
}

export interface CarrierTrackingProjectionReader {
  listChangedPackages(
    input: ListChangedCarrierTrackingPackagesInput,
  ): Promise<ListChangedCarrierTrackingPackagesResult>;
}

interface ProjectionRow {
  provider_label_id: string | number;
  provider: string;
  provider_label_reference: string;
  provider_order_id: string | null;
  provider_order_key: string | null;
  tracking_number: string;
  normalized_tracking_number: string;
  carrier: string | null;
  canonical_status: CanonicalCarrierTrackingStatus;
  dispatch_evidence: CarrierDispatchEvidence;
  dispatch_confirmed: boolean;
  status_description: string | null;
  event_occurred_at: Date | string | null;
  estimated_delivery_at: Date | string | null;
  actual_delivery_at: Date | string | null;
  latest_event_id: string | number;
  latest_match_id: string | number;
  state_changed_at: Date | string;
}

function requiredDate(value: Date | string, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Carrier tracking projection returned invalid ${field}`);
  }
  return parsed;
}

function optionalDate(value: Date | string | null, field: string): Date | null {
  return value === null ? null : requiredDate(value, field);
}

function mapProjectionRow(row: ProjectionRow): CarrierTrackingPackageProjection {
  return {
    providerLabelId: String(row.provider_label_id),
    provider: row.provider,
    providerLabelReference: row.provider_label_reference,
    providerOrderId: row.provider_order_id,
    providerOrderKey: row.provider_order_key,
    trackingNumber: row.tracking_number,
    normalizedTrackingNumber: row.normalized_tracking_number,
    carrier: row.carrier,
    canonicalStatus: row.canonical_status,
    dispatchEvidence: row.dispatch_evidence,
    dispatchConfirmed: row.dispatch_confirmed,
    statusDescription: row.status_description,
    eventOccurredAt: optionalDate(row.event_occurred_at, "event_occurred_at"),
    estimatedDeliveryAt: optionalDate(row.estimated_delivery_at, "estimated_delivery_at"),
    actualDeliveryAt: optionalDate(row.actual_delivery_at, "actual_delivery_at"),
    latestEventId: String(row.latest_event_id),
    latestMatchId: String(row.latest_match_id),
    stateChangedAt: requiredDate(row.state_changed_at, "state_changed_at"),
  };
}

export function createCarrierTrackingProjectionReader(
  db: { execute(query: unknown): Promise<{ rows: unknown[] }> },
): CarrierTrackingProjectionReader {
  return {
    async listChangedPackages(input) {
      const queryLimit = input.limit + 1;
      const rows = await db.execute(sql`
        WITH authoritative_matches AS (
          SELECT
            match.id AS match_id,
            match.shipping_provider_label_id,
            match.created_at AS match_created_at,
            event.id AS event_id,
            event.canonical_status,
            event.dispatch_evidence,
            event.status_description,
            event.carrier,
            event.event_occurred_at,
            event.estimated_delivery_at,
            event.actual_delivery_at,
            event.received_at
          FROM wms.carrier_tracking_reconciliation_state AS state
          JOIN wms.carrier_tracking_event_matches AS match
            ON match.id = state.last_match_attempt_id
          JOIN wms.carrier_tracking_events AS event
            ON event.id = state.carrier_tracking_event_id
          WHERE state.last_match_status = 'matched'
            AND match.match_status = 'matched'
            AND match.shipping_provider_label_id IS NOT NULL
        ),
        changed_labels AS (
          SELECT
            shipping_provider_label_id,
            MAX(match_created_at) AS state_changed_at
          FROM authoritative_matches
          GROUP BY shipping_provider_label_id
          HAVING (${input.changedSince?.toISOString() ?? null}::timestamptz IS NULL
              OR MAX(match_created_at) >= ${input.changedSince?.toISOString() ?? null}::timestamptz)
            AND MAX(match_created_at) <= ${input.observedThrough.toISOString()}::timestamptz
        ),
        candidate_labels AS (
          SELECT shipping_provider_label_id, state_changed_at
          FROM changed_labels
          WHERE (${input.after?.stateChangedAt.toISOString() ?? null}::timestamptz IS NULL
              OR (state_changed_at, shipping_provider_label_id) > (
                ${input.after?.stateChangedAt.toISOString() ?? null}::timestamptz,
                ${input.after?.providerLabelId ?? null}::bigint
              ))
          ORDER BY state_changed_at ASC, shipping_provider_label_id ASC
          LIMIT ${queryLimit}
        ),
        ranked_events AS (
          SELECT
            candidate.shipping_provider_label_id,
            candidate.state_changed_at,
            authoritative.match_id,
            authoritative.event_id,
            authoritative.canonical_status,
            authoritative.dispatch_evidence,
            authoritative.status_description,
            authoritative.carrier,
            authoritative.event_occurred_at,
            authoritative.estimated_delivery_at,
            authoritative.actual_delivery_at,
            BOOL_OR(authoritative.dispatch_evidence = 'confirmed') OVER (
              PARTITION BY candidate.shipping_provider_label_id
            ) AS dispatch_confirmed,
            ROW_NUMBER() OVER (
              PARTITION BY candidate.shipping_provider_label_id
              ORDER BY
                COALESCE(authoritative.event_occurred_at, authoritative.received_at) DESC,
                authoritative.received_at DESC,
                authoritative.event_id DESC
            ) AS event_rank
          FROM candidate_labels AS candidate
          JOIN authoritative_matches AS authoritative
            ON authoritative.shipping_provider_label_id = candidate.shipping_provider_label_id
        )
        SELECT
          label.id AS provider_label_id,
          label.provider,
          label.provider_label_id AS provider_label_reference,
          label.provider_order_id,
          label.provider_order_key,
          label.tracking_number,
          label.normalized_tracking_number,
          COALESCE(ranked.carrier, label.carrier) AS carrier,
          ranked.canonical_status,
          ranked.dispatch_evidence,
          ranked.dispatch_confirmed,
          ranked.status_description,
          ranked.event_occurred_at,
          ranked.estimated_delivery_at,
          ranked.actual_delivery_at,
          ranked.event_id AS latest_event_id,
          ranked.match_id AS latest_match_id,
          ranked.state_changed_at
        FROM ranked_events AS ranked
        JOIN wms.shipping_provider_labels AS label
          ON label.id = ranked.shipping_provider_label_id
        WHERE ranked.event_rank = 1
        ORDER BY ranked.state_changed_at ASC, label.id ASC
      `);

      const mapped = (rows.rows as ProjectionRow[]).map(mapProjectionRow);
      const hasMore = mapped.length > input.limit;
      const packages = hasMore ? mapped.slice(0, input.limit) : mapped;
      const last = packages.at(-1);
      return {
        packages,
        hasMore,
        nextCursor: last
          ? { stateChangedAt: last.stateChangedAt, providerLabelId: last.providerLabelId }
          : null,
      };
    },
  };
}
