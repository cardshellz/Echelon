import type { Pool, PoolClient } from "pg";
import type {
  DropshipListingHoldState,
  DropshipVendorStandingReason,
  DropshipVendorStatus,
} from "../../../../shared/schema/dropship.schema";
import { pool as defaultPool } from "../../../db";
import type {
  DropshipVendorStandingRecord,
  DropshipVendorStandingRepository,
} from "../application/dropship-vendor-standing-service";
import type { DropshipEntitlementStatus } from "../domain/auth";
import { DropshipError } from "../domain/errors";
import { resolveDropshipVendorProvisioningStatus } from "../domain/vendor-provisioning";

interface StandingRow {
  id: number;
  status: string;
  standing_reason: string | null;
  paused_at: Date | null;
  standing_revision: number;
  listing_hold_state: string;
  listing_hold_reconciled_at: Date | null;
  listing_hold_detail: string | null;
}

const STANDING_COLUMNS = `id, status, standing_reason, paused_at, standing_revision,
  listing_hold_state, listing_hold_reconciled_at, listing_hold_detail`;

const VENDOR_STATUSES: ReadonlySet<string> = new Set(["onboarding", "active", "paused", "lapsed", "suspended", "closed"]);
const ENTITLEMENT_STATUSES: ReadonlySet<string> = new Set(["active", "grace", "lapsed", "suspended", "not_entitled"]);
const STANDING_REASONS: ReadonlySet<string> = new Set(["card_declined", "funding_returned", "operator"]);
const LISTING_HOLD_STATES: ReadonlySet<string> = new Set(["released", "held"]);

export class PgDropshipVendorStandingRepository implements DropshipVendorStandingRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async getStanding(vendorId: number): Promise<DropshipVendorStandingRecord | null> {
    const result = await this.dbPool.query<StandingRow>(
      `SELECT ${STANDING_COLUMNS}
       FROM dropship.dropship_vendors
       WHERE id = $1
       LIMIT 1`,
      [vendorId],
    );
    return result.rows[0] ? mapStandingRow(result.rows[0]) : null;
  }

  async pauseVendor(input: PauseDropshipVendorWithClientInput): Promise<PauseDropshipVendorWithClientResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const result = await pauseDropshipVendorWithClient(client, input);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async resumeVendor(input: {
    vendorId: number;
    evidence: Record<string, unknown>;
    now: Date;
  }): Promise<{ changed: boolean; standing: DropshipVendorStandingRecord | null }> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const before = await client.query<StandingRow & { entitlement_status: string }>(
        `SELECT ${STANDING_COLUMNS}, entitlement_status
         FROM dropship.dropship_vendors
         WHERE id = $1
         LIMIT 1
         FOR UPDATE`,
        [input.vendorId],
      );
      const current = before.rows[0] ? mapStandingRow(before.rows[0]) : null;
      // The pause masked the entitlement while it lasted; the vendor comes
      // back as the membership says (active, or lapsed/suspended if it
      // changed meanwhile), never as active by default.
      const resumedStatus = resolveDropshipVendorProvisioningStatus({
        currentStatus: "active",
        entitlementStatus: entitlementStatusFor(before.rows[0]?.entitlement_status),
      });
      // Only a funding pause is cleared here; an operator pause stays until an operator lifts it.
      const updated = await client.query<StandingRow>(
        `UPDATE dropship.dropship_vendors
         SET status = $3,
             standing_reason = NULL,
             paused_at = NULL,
             standing_revision = standing_revision + 1,
             updated_at = $2
         WHERE id = $1
           AND status = 'paused'
           AND standing_reason IN ('card_declined', 'funding_returned')
         RETURNING ${STANDING_COLUMNS}`,
        [input.vendorId, input.now, resumedStatus],
      );
      const row = updated.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return { changed: false, standing: current };
      }
      const standing = mapStandingRow(row);
      await recordStandingAuditEvent(client, {
        vendorId: input.vendorId,
        eventType: "vendor_resumed",
        payload: {
          evidence: input.evidence,
          before: {
            status: "paused",
            standingReason: current?.standingReason ?? null,
            pausedAt: current?.pausedAt?.toISOString() ?? null,
          },
          after: { status: standing.status, standingRevision: standing.standingRevision },
        },
        occurredAt: input.now,
      });
      await client.query("COMMIT");
      return { changed: true, standing };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async listStoreConnectionIds(vendorId: number): Promise<number[]> {
    const result = await this.dbPool.query<{ id: number }>(
      `SELECT id
       FROM dropship.dropship_store_connections
       WHERE vendor_id = $1
         AND status <> 'disconnected'
       ORDER BY id ASC`,
      [vendorId],
    );
    return result.rows.map((row) => row.id);
  }

  async listPausedForFunding(input: { limit: number }): Promise<DropshipVendorStandingRecord[]> {
    const result = await this.dbPool.query<StandingRow>(
      `SELECT ${STANDING_COLUMNS}
       FROM dropship.dropship_vendors
       WHERE status = 'paused'
         AND standing_reason IN ('card_declined', 'funding_returned')
       ORDER BY paused_at ASC, id ASC
       LIMIT $1`,
      [input.limit],
    );
    return result.rows.map(mapStandingRow);
  }

  async listListingHoldMismatches(input: { limit: number }): Promise<DropshipVendorStandingRecord[]> {
    const result = await this.dbPool.query<StandingRow>(
      `SELECT ${STANDING_COLUMNS}
       FROM dropship.dropship_vendors
       WHERE (status = 'paused' AND listing_hold_state = 'released')
          OR (status <> 'paused' AND listing_hold_state = 'held')
       ORDER BY id ASC
       LIMIT $1`,
      [input.limit],
    );
    return result.rows.map(mapStandingRow);
  }

  async recordListingHoldState(input: {
    vendorId: number;
    state: DropshipListingHoldState;
    detail: string | null;
    now: Date;
  }): Promise<void> {
    const result = await this.dbPool.query(
      `UPDATE dropship.dropship_vendors
       SET listing_hold_state = $2,
           listing_hold_reconciled_at = $3,
           listing_hold_detail = $4,
           updated_at = $3
       WHERE id = $1`,
      [input.vendorId, input.state, input.now, input.detail],
    );
    if (result.rowCount !== 1) {
      throw new DropshipError(
        "DROPSHIP_VENDOR_STANDING_NOT_FOUND",
        "Dropship vendor listing hold state update did not find the vendor.",
        { vendorId: input.vendorId },
      );
    }
  }
}

export interface PauseDropshipVendorWithClientInput {
  vendorId: number;
  reason: DropshipVendorStandingReason;
  evidence: Record<string, unknown>;
  now: Date;
}

export interface PauseDropshipVendorWithClientResult {
  changed: boolean;
  standing: DropshipVendorStandingRecord | null;
}

/**
 * active → paused inside the caller's transaction, with its audit row. Shared
 * with the wallet repository so a voided funding credit and the pause it
 * causes commit together: a vendor is never left selling on money that the
 * bank has already refused.
 */
export async function pauseDropshipVendorWithClient(
  client: PoolClient,
  input: PauseDropshipVendorWithClientInput,
): Promise<PauseDropshipVendorWithClientResult> {
  const updated = await client.query<StandingRow>(
    `UPDATE dropship.dropship_vendors
     SET status = 'paused',
         standing_reason = $2,
         paused_at = $3,
         standing_revision = standing_revision + 1,
         updated_at = $3
     WHERE id = $1
       AND status = 'active'
     RETURNING ${STANDING_COLUMNS}`,
    [input.vendorId, input.reason, input.now],
  );
  const row = updated.rows[0];
  if (!row) {
    const current = await client.query<StandingRow>(
      `SELECT ${STANDING_COLUMNS}
       FROM dropship.dropship_vendors
       WHERE id = $1
       LIMIT 1`,
      [input.vendorId],
    );
    return { changed: false, standing: current.rows[0] ? mapStandingRow(current.rows[0]) : null };
  }
  const standing = mapStandingRow(row);
  await recordStandingAuditEvent(client, {
    vendorId: input.vendorId,
    eventType: "vendor_paused",
    payload: {
      reason: input.reason,
      evidence: input.evidence,
      before: { status: "active" },
      after: { status: "paused", standingReason: input.reason, pausedAt: input.now.toISOString(), standingRevision: standing.standingRevision },
    },
    occurredAt: input.now,
  });
  return { changed: true, standing };
}

async function recordStandingAuditEvent(
  client: PoolClient,
  input: {
    vendorId: number;
    eventType: "vendor_paused" | "vendor_resumed";
    payload: Record<string, unknown>;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, 'dropship_vendor', $2, $3, 'system', 'dropship-vendor-standing', 'info', $4::jsonb, $5)`,
    [
      input.vendorId,
      String(input.vendorId),
      input.eventType,
      JSON.stringify(input.payload),
      input.occurredAt,
    ],
  );
}

function mapStandingRow(row: StandingRow): DropshipVendorStandingRecord {
  return {
    vendorId: row.id,
    status: requireMember(VENDOR_STATUSES, row.status, "status", row.id) as DropshipVendorStatus,
    standingReason: row.standing_reason === null
      ? null
      : requireMember(STANDING_REASONS, row.standing_reason, "standing_reason", row.id) as DropshipVendorStandingReason,
    pausedAt: row.paused_at,
    standingRevision: row.standing_revision,
    listingHoldState: requireMember(LISTING_HOLD_STATES, row.listing_hold_state, "listing_hold_state", row.id) as DropshipListingHoldState,
    listingHoldReconciledAt: row.listing_hold_reconciled_at,
    listingHoldDetail: row.listing_hold_detail,
  };
}

/** An entitlement value the row should never carry is treated as not entitled: fail closed. */
function entitlementStatusFor(value: string | undefined): DropshipEntitlementStatus {
  return value !== undefined && ENTITLEMENT_STATUSES.has(value) ? (value as DropshipEntitlementStatus) : "not_entitled";
}

function requireMember(allowed: ReadonlySet<string>, value: string, field: string, vendorId: number): string {
  if (!allowed.has(value)) {
    throw new DropshipError(
      "DROPSHIP_VENDOR_STANDING_ROW_INVALID",
      "Dropship vendor row carries a value outside its allowed set.",
      { vendorId, field, value },
    );
  }
  return value;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The transaction is already gone; the original error is what matters.
  }
}
