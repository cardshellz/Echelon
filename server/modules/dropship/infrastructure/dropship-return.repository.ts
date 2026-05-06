import { createHash } from "crypto";
import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type {
  CreateDropshipRmaInput,
  DropshipReturnFaultCategory,
  DropshipReturnRepository,
  DropshipRmaDetail,
  DropshipRmaInspectionRecord,
  DropshipRmaInspectionResult,
  DropshipRmaItemRecord,
  DropshipRmaListItem,
  DropshipRmaListResult,
  DropshipRmaStatus,
  DropshipRmaStatusUpdateResult,
  ListDropshipRmasInput,
  ProcessDropshipRmaInspectionInput,
  UpdateDropshipRmaStatusInput,
} from "../application/dropship-return-service";
import type {
  DropshipWalletLedgerRecord,
  DropshipWalletLedgerType,
} from "../application/dropship-wallet-service";

interface RmaListRow {
  id: number;
  rma_number: string;
  vendor_id: number;
  vendor_name: string | null;
  vendor_email: string | null;
  store_connection_id: number | null;
  platform: string | null;
  intake_id: number | null;
  oms_order_id: string | number | null;
  status: DropshipRmaStatus;
  reason_code: string | null;
  fault_category: DropshipReturnFaultCategory | null;
  return_window_days: number;
  label_source?: string | null;
  return_tracking_number: string | null;
  vendor_notes?: string | null;
  requested_at: Date;
  received_at: Date | null;
  inspected_at: Date | null;
  credited_at: Date | null;
  idempotency_key?: string | null;
  request_hash?: string | null;
  updated_at: Date;
  item_count: string | number;
  total_quantity: string | number;
  total_count?: string | number;
}

interface RmaItemRow {
  id: number;
  rma_id: number;
  product_variant_id: number | null;
  quantity: number;
  status: string;
  requested_credit_cents: string | number | null;
  final_credit_cents: string | number | null;
  fee_cents: string | number | null;
  created_at: Date;
}

interface RmaInspectionRow {
  id: number;
  rma_id: number;
  outcome: DropshipRmaInspectionRecord["outcome"];
  fault_category: DropshipReturnFaultCategory | null;
  notes: string | null;
  photos: Record<string, unknown>[] | null;
  credit_cents: string | number;
  fee_cents: string | number;
  inspected_by: string | null;
  idempotency_key: string | null;
  request_hash: string | null;
  created_at: Date;
}

interface RmaStatusUpdateRow {
  id: number;
  rma_id: number;
  vendor_id: number;
  previous_status: DropshipRmaStatus;
  status: DropshipRmaStatus;
  notes: string | null;
  actor_type: "admin" | "system";
  actor_id: string | null;
  idempotency_key: string;
  request_hash: string;
  created_at: Date;
}

interface WalletAccountRow {
  id: number;
  vendor_id: number;
  available_balance_cents: string | number;
  pending_balance_cents: string | number;
  currency: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

interface WalletLedgerRow {
  id: number;
  wallet_account_id: number | null;
  vendor_id: number;
  type: DropshipWalletLedgerRecord["type"];
  status: DropshipWalletLedgerRecord["status"];
  amount_cents: string | number;
  currency: string;
  available_balance_after_cents: string | number | null;
  pending_balance_after_cents: string | number | null;
  reference_type: string | null;
  reference_id: string | null;
  idempotency_key: string | null;
  funding_method_id: number | null;
  external_transaction_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  settled_at: Date | null;
}

type CreateRepositoryInput = CreateDropshipRmaInput & { requestHash: string; now: Date };
type UpdateStatusRepositoryInput = UpdateDropshipRmaStatusInput & { requestHash: string; now: Date };
type ProcessInspectionRepositoryInput = ProcessDropshipRmaInspectionInput & { requestHash: string; now: Date };

export class PgDropshipReturnRepository implements DropshipReturnRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async listRmas(input: ListDropshipRmasInput): Promise<DropshipRmaListResult> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (input.vendorId) {
      params.push(input.vendorId);
      where.push(`r.vendor_id = $${params.length}`);
    }
    if (input.statuses?.length) {
      params.push(input.statuses);
      where.push(`r.status = ANY($${params.length}::varchar[])`);
    }
    if (input.search) {
      params.push(`%${input.search}%`);
      where.push(`(
        r.rma_number ILIKE $${params.length}
        OR r.return_tracking_number ILIKE $${params.length}
        OR oi.external_order_id ILIKE $${params.length}
        OR oi.external_order_number ILIKE $${params.length}
      )`);
    }
    params.push(input.limit, (input.page - 1) * input.limit);
    const limitParam = params.length - 1;
    const offsetParam = params.length;
    const result = await this.dbPool.query<RmaListRow>(
      `WITH filtered AS (
         SELECT r.id, r.rma_number, r.vendor_id,
                v.business_name AS vendor_name, v.email AS vendor_email,
                r.store_connection_id, sc.platform, r.intake_id, r.oms_order_id,
                r.status, r.reason_code, r.fault_category, r.return_window_days,
                r.return_tracking_number, r.requested_at, r.received_at,
                r.inspected_at, r.credited_at, r.updated_at,
                COUNT(ri.id) AS item_count,
                COALESCE(SUM(ri.quantity), 0) AS total_quantity
         FROM dropship.dropship_rmas r
         JOIN dropship.dropship_vendors v ON v.id = r.vendor_id
         LEFT JOIN dropship.dropship_store_connections sc ON sc.id = r.store_connection_id
         LEFT JOIN dropship.dropship_order_intake oi ON oi.id = r.intake_id
         LEFT JOIN dropship.dropship_rma_items ri ON ri.rma_id = r.id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         GROUP BY r.id, v.business_name, v.email, sc.platform
       )
       SELECT *, COUNT(*) OVER() AS total_count
       FROM filtered
       ORDER BY requested_at DESC, id DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      params,
    );
    return {
      items: result.rows.map(mapRmaListRow),
      total: Number(result.rows[0]?.total_count ?? 0),
      page: input.page,
      limit: input.limit,
    };
  }

  async getRma(input: { rmaId: number; vendorId?: number }): Promise<DropshipRmaDetail | null> {
    const client = await this.dbPool.connect();
    try {
      return getRmaDetailWithClient(client, input);
    } finally {
      client.release();
    }
  }

  async createRma(input: CreateRepositoryInput): Promise<{ rma: DropshipRmaDetail; idempotentReplay: boolean }> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const replay = await findRmaByIdempotencyKeyWithClient(client, input.vendorId, input.idempotencyKey, true);
      if (replay) {
        assertRequestHash(replay.request_hash, input.requestHash, "DROPSHIP_RMA_IDEMPOTENCY_CONFLICT");
        const detail = await getRmaDetailWithClient(client, { rmaId: replay.id, vendorId: input.vendorId });
        await client.query("COMMIT");
        return {
          rma: requiredRow(detail, "Dropship RMA idempotent replay detail was not found."),
          idempotentReplay: true,
        };
      }

      await assertVendorExists(client, input.vendorId);
      await assertStoreConnectionBelongsToVendor(client, input.vendorId, input.storeConnectionId ?? null);
      await assertIntakeBelongsToVendor(client, input.vendorId, input.intakeId ?? null);
      const insert = await client.query<{ id: number }>(
        `INSERT INTO dropship.dropship_rmas
          (rma_number, vendor_id, store_connection_id, intake_id, oms_order_id,
           status, reason_code, fault_category, return_window_days, label_source,
           return_tracking_number, vendor_notes, requested_at, updated_at,
           idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4, $5, 'requested', $6, $7, $8, $9, $10, $11, $12, $12, $13, $14)
         RETURNING id`,
        [
          input.rmaNumber,
          input.vendorId,
          input.storeConnectionId ?? null,
          input.intakeId ?? null,
          input.omsOrderId ?? null,
          input.reasonCode ?? null,
          input.faultCategory ?? null,
          input.returnWindowDays,
          input.labelSource ?? null,
          input.returnTrackingNumber ?? null,
          input.vendorNotes ?? null,
          input.now,
          input.idempotencyKey,
          input.requestHash,
        ],
      );
      const rmaId = requiredRow(insert.rows[0], "Dropship RMA insert returned no row.").id;
      for (const item of input.items) {
        await client.query(
          `INSERT INTO dropship.dropship_rma_items
            (rma_id, product_variant_id, quantity, status, requested_credit_cents, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            rmaId,
            item.productVariantId ?? null,
            item.quantity,
            item.status,
            item.requestedCreditCents ?? null,
            input.now,
          ],
        );
      }
      await recordReturnAuditEvent(client, {
        vendorId: input.vendorId,
        entityId: String(rmaId),
        eventType: "rma_created",
        actor: input.actor,
        severity: "info",
        payload: {
          rmaNumber: input.rmaNumber,
          idempotencyKey: input.idempotencyKey,
          itemCount: input.items.length,
        },
        createdAt: input.now,
      });
      const detail = await getRmaDetailWithClient(client, { rmaId, vendorId: input.vendorId });
      await client.query("COMMIT");
      return {
        rma: requiredRow(detail, "Dropship RMA detail was not found after create."),
        idempotentReplay: false,
      };
    } catch (error) {
      await rollbackQuietly(client);
      if (isUniqueViolation(error)) {
        const replay = await this.findCreateReplayAfterUniqueConflict(input);
        if (replay) return replay;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateStatus(input: UpdateStatusRepositoryInput): Promise<DropshipRmaStatusUpdateResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const existing = await loadRmaForUpdate(client, input.rmaId, input.vendorId);
      if (!existing) {
        throw new DropshipError("DROPSHIP_RMA_NOT_FOUND", "Dropship RMA was not found.", {
          rmaId: input.rmaId,
          vendorId: input.vendorId,
        });
      }
      const replay = await findRmaStatusUpdateByIdempotencyKeyWithClient(client, input.idempotencyKey, true);
      if (replay) {
        assertStatusUpdateReplay(replay, input);
        const detail = await getRmaDetailWithClient(client, { rmaId: replay.rma_id, vendorId: input.vendorId });
        await client.query("COMMIT");
        return {
          rma: requiredRow(detail, "Dropship RMA detail was not found for status update replay."),
          idempotentReplay: true,
        };
      }
      await client.query(
        `UPDATE dropship.dropship_rmas
         SET status = $2,
             received_at = CASE WHEN $2 = 'received' THEN COALESCE(received_at, $3) ELSE received_at END,
             updated_at = $3
         WHERE id = $1`,
        [input.rmaId, input.status, input.now],
      );
      const statusUpdate = await insertRmaStatusUpdate(client, {
        rmaId: input.rmaId,
        vendorId: existing.vendor_id,
        previousStatus: existing.status,
        status: input.status,
        notes: input.notes ?? null,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId ?? null,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        createdAt: input.now,
      });
      await recordReturnAuditEvent(client, {
        vendorId: existing.vendor_id,
        entityId: String(input.rmaId),
        eventType: "rma_status_updated",
        actor: input.actor,
        severity: "info",
        payload: {
          previousStatus: existing.status,
          status: input.status,
          notes: input.notes ?? null,
          idempotencyKey: input.idempotencyKey,
          statusUpdateId: statusUpdate.id,
        },
        createdAt: input.now,
      });
      const detail = await getRmaDetailWithClient(client, { rmaId: input.rmaId, vendorId: input.vendorId });
      await client.query("COMMIT");
      return {
        rma: requiredRow(detail, "Dropship RMA detail was not found after status update."),
        idempotentReplay: false,
      };
    } catch (error) {
      await rollbackQuietly(client);
      if (isUniqueViolation(error)) {
        const replay = await this.findStatusUpdateReplayAfterUniqueConflict(input);
        if (replay) return replay;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async processInspection(input: ProcessInspectionRepositoryInput): Promise<DropshipRmaInspectionResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const rma = await loadRmaForUpdate(client, input.rmaId);
      if (!rma) {
        throw new DropshipError("DROPSHIP_RMA_NOT_FOUND", "Dropship RMA was not found.", { rmaId: input.rmaId });
      }
      const existingInspection = await findExistingInspectionForRma(client, input.rmaId, input.idempotencyKey);
      if (existingInspection) {
        assertInspectionReplay(existingInspection, input.idempotencyKey, input.requestHash);
        const detail = await getRmaDetailWithClient(client, { rmaId: input.rmaId, vendorId: rma.vendor_id });
        await client.query("COMMIT");
        return {
          rma: requiredRow(detail, "Dropship RMA detail was not found for inspection replay."),
          inspection: existingInspection,
          walletLedger: detail?.walletLedger ?? [],
          idempotentReplay: true,
        };
      }

      const inspection = await insertInspection(client, {
        rmaId: input.rmaId,
        outcome: input.outcome,
        faultCategory: input.faultCategory,
        notes: input.notes ?? null,
        photos: input.photos,
        creditCents: input.creditCents,
        feeCents: input.feeCents,
        inspectedBy: input.actor.actorId ?? null,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        createdAt: input.now,
      });
      await updateInspectionItems(client, input.rmaId, input.items);
      const walletLedger = await recordWalletAdjustmentsForInspection(client, {
        vendorId: rma.vendor_id,
        rmaId: input.rmaId,
        faultCategory: input.faultCategory,
        creditCents: input.creditCents,
        feeCents: input.feeCents,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        now: input.now,
      });
      const nextStatus: DropshipRmaStatus = input.outcome === "rejected"
        ? "rejected"
        : walletLedger.length > 0
          ? "credited"
          : "approved";
      await client.query(
        `UPDATE dropship.dropship_rmas
         SET status = $2,
             fault_category = $3,
             inspected_at = $4,
             credited_at = CASE WHEN $2 = 'credited' THEN $4 ELSE credited_at END,
             updated_at = $4
         WHERE id = $1`,
        [input.rmaId, nextStatus, input.faultCategory, input.now],
      );
      await recordReturnAuditEvent(client, {
        vendorId: rma.vendor_id,
        entityId: String(input.rmaId),
        eventType: "rma_inspection_finalized",
        actor: input.actor,
        severity: "info",
        payload: {
          outcome: input.outcome,
          faultCategory: input.faultCategory,
          creditCents: input.creditCents,
          feeCents: input.feeCents,
          idempotencyKey: input.idempotencyKey,
          walletLedgerIds: walletLedger.map((entry) => entry.ledgerEntryId),
        },
        createdAt: input.now,
      });
      const detail = await getRmaDetailWithClient(client, { rmaId: input.rmaId, vendorId: rma.vendor_id });
      await client.query("COMMIT");
      return {
        rma: requiredRow(detail, "Dropship RMA detail was not found after inspection."),
        inspection,
        walletLedger,
        idempotentReplay: false,
      };
    } catch (error) {
      await rollbackQuietly(client);
      if (isUniqueViolation(error)) {
        const replay = await this.findInspectionReplayAfterUniqueConflict(input);
        if (replay) return replay;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async findCreateReplayAfterUniqueConflict(
    input: CreateRepositoryInput,
  ): Promise<{ rma: DropshipRmaDetail; idempotentReplay: boolean } | null> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const replay = await findRmaByIdempotencyKeyWithClient(client, input.vendorId, input.idempotencyKey, true);
      if (!replay) {
        await client.query("COMMIT");
        return null;
      }
      assertRequestHash(replay.request_hash, input.requestHash, "DROPSHIP_RMA_IDEMPOTENCY_CONFLICT");
      const detail = await getRmaDetailWithClient(client, { rmaId: replay.id, vendorId: input.vendorId });
      await client.query("COMMIT");
      return {
        rma: requiredRow(detail, "Dropship RMA detail was not found for create replay."),
        idempotentReplay: true,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async findInspectionReplayAfterUniqueConflict(
    input: ProcessInspectionRepositoryInput,
  ): Promise<DropshipRmaInspectionResult | null> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const inspection = await findExistingInspectionForRma(client, input.rmaId, input.idempotencyKey);
      if (!inspection) {
        await client.query("COMMIT");
        return null;
      }
      assertInspectionReplay(inspection, input.idempotencyKey, input.requestHash);
      const detail = await getRmaDetailWithClient(client, { rmaId: input.rmaId });
      await client.query("COMMIT");
      return {
        rma: requiredRow(detail, "Dropship RMA detail was not found for inspection replay."),
        inspection,
        walletLedger: detail?.walletLedger ?? [],
        idempotentReplay: true,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async findStatusUpdateReplayAfterUniqueConflict(
    input: UpdateStatusRepositoryInput,
  ): Promise<DropshipRmaStatusUpdateResult | null> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const replay = await findRmaStatusUpdateByIdempotencyKeyWithClient(client, input.idempotencyKey, true);
      if (!replay) {
        await client.query("COMMIT");
        return null;
      }
      assertStatusUpdateReplay(replay, input);
      const detail = await getRmaDetailWithClient(client, { rmaId: replay.rma_id, vendorId: input.vendorId });
      await client.query("COMMIT");
      return {
        rma: requiredRow(detail, "Dropship RMA detail was not found for status update replay."),
        idempotentReplay: true,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function getRmaDetailWithClient(
  client: PoolClient,
  input: { rmaId: number; vendorId?: number },
): Promise<DropshipRmaDetail | null> {
  const params: unknown[] = [input.rmaId];
  const vendorClause = input.vendorId ? "AND r.vendor_id = $2" : "";
  if (input.vendorId) params.push(input.vendorId);
  const result = await client.query<RmaListRow>(
    `SELECT r.id, r.rma_number, r.vendor_id,
            v.business_name AS vendor_name, v.email AS vendor_email,
            r.store_connection_id, sc.platform, r.intake_id, r.oms_order_id,
            r.status, r.reason_code, r.fault_category, r.return_window_days,
            r.label_source, r.return_tracking_number, r.vendor_notes,
            r.requested_at, r.received_at, r.inspected_at, r.credited_at,
            r.idempotency_key, r.request_hash, r.updated_at,
            COUNT(ri.id) AS item_count,
            COALESCE(SUM(ri.quantity), 0) AS total_quantity
     FROM dropship.dropship_rmas r
     JOIN dropship.dropship_vendors v ON v.id = r.vendor_id
     LEFT JOIN dropship.dropship_store_connections sc ON sc.id = r.store_connection_id
     LEFT JOIN dropship.dropship_rma_items ri ON ri.rma_id = r.id
     WHERE r.id = $1
       ${vendorClause}
     GROUP BY r.id, v.business_name, v.email, sc.platform
     LIMIT 1`,
    params,
  );
  const row = result.rows[0];
  if (!row) return null;
  const [items, inspections, walletLedger] = await Promise.all([
    listRmaItemsWithClient(client, input.rmaId),
    listRmaInspectionsWithClient(client, input.rmaId),
    listRmaWalletLedgerWithClient(client, row.vendor_id, input.rmaId),
  ]);
  return {
    ...mapRmaListRow(row),
    labelSource: row.label_source ?? null,
    vendorNotes: row.vendor_notes ?? null,
    idempotencyKey: row.idempotency_key ?? null,
    requestHash: row.request_hash ?? null,
    items,
    inspections,
    walletLedger,
  };
}

async function listRmaItemsWithClient(client: PoolClient, rmaId: number): Promise<DropshipRmaItemRecord[]> {
  const result = await client.query<RmaItemRow>(
    `SELECT id, rma_id, product_variant_id, quantity, status,
            requested_credit_cents, final_credit_cents, fee_cents, created_at
     FROM dropship.dropship_rma_items
     WHERE rma_id = $1
     ORDER BY id ASC`,
    [rmaId],
  );
  return result.rows.map(mapRmaItemRow);
}

async function listRmaInspectionsWithClient(client: PoolClient, rmaId: number): Promise<DropshipRmaInspectionRecord[]> {
  const result = await client.query<RmaInspectionRow>(
    `SELECT id, rma_id, outcome, fault_category, notes, photos,
            credit_cents, fee_cents, inspected_by, idempotency_key, request_hash, created_at
     FROM dropship.dropship_rma_inspections
     WHERE rma_id = $1
     ORDER BY created_at DESC, id DESC`,
    [rmaId],
  );
  return result.rows.map(mapRmaInspectionRow);
}

async function listRmaWalletLedgerWithClient(
  client: PoolClient,
  vendorId: number,
  rmaId: number,
): Promise<DropshipWalletLedgerRecord[]> {
  const result = await client.query<WalletLedgerRow>(
    `SELECT id, wallet_account_id, vendor_id, type, status, amount_cents, currency,
            available_balance_after_cents, pending_balance_after_cents,
            reference_type, reference_id, idempotency_key, funding_method_id,
            external_transaction_id, metadata, created_at, settled_at
     FROM dropship.dropship_wallet_ledger
     WHERE vendor_id = $1
       AND reference_type = 'dropship_rma'
       AND reference_id IN ($2, $3)
     ORDER BY created_at ASC, id ASC`,
    [vendorId, `${rmaId}:credit`, `${rmaId}:fee`],
  );
  return result.rows.map(mapWalletLedgerRow);
}

async function findRmaByIdempotencyKeyWithClient(
  client: PoolClient,
  vendorId: number,
  idempotencyKey: string,
  forUpdate: boolean,
): Promise<{ id: number; request_hash: string | null } | null> {
  const result = await client.query<{ id: number; request_hash: string | null }>(
    `SELECT id, request_hash
     FROM dropship.dropship_rmas
     WHERE vendor_id = $1
       AND idempotency_key = $2
     LIMIT 1
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [vendorId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

async function loadRmaForUpdate(
  client: PoolClient,
  rmaId: number,
  vendorId?: number,
): Promise<{ id: number; vendor_id: number; status: DropshipRmaStatus } | null> {
  const params: unknown[] = [rmaId];
  const vendorClause = vendorId ? "AND vendor_id = $2" : "";
  if (vendorId) params.push(vendorId);
  const result = await client.query<{ id: number; vendor_id: number; status: DropshipRmaStatus }>(
    `SELECT id, vendor_id, status
     FROM dropship.dropship_rmas
     WHERE id = $1
       ${vendorClause}
     LIMIT 1
     FOR UPDATE`,
    params,
  );
  return result.rows[0] ?? null;
}

async function findRmaStatusUpdateByIdempotencyKeyWithClient(
  client: PoolClient,
  idempotencyKey: string,
  forUpdate: boolean,
): Promise<RmaStatusUpdateRow | null> {
  const result = await client.query<RmaStatusUpdateRow>(
    `SELECT id, rma_id, vendor_id, previous_status, status, notes,
            actor_type, actor_id, idempotency_key, request_hash, created_at
     FROM dropship.dropship_rma_status_updates
     WHERE idempotency_key = $1
     LIMIT 1
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [idempotencyKey],
  );
  return result.rows[0] ?? null;
}

async function insertRmaStatusUpdate(
  client: PoolClient,
  input: {
    rmaId: number;
    vendorId: number;
    previousStatus: DropshipRmaStatus;
    status: DropshipRmaStatus;
    notes: string | null;
    actorType: "admin" | "system";
    actorId: string | null;
    idempotencyKey: string;
    requestHash: string;
    createdAt: Date;
  },
): Promise<RmaStatusUpdateRow> {
  const result = await client.query<RmaStatusUpdateRow>(
    `INSERT INTO dropship.dropship_rma_status_updates
      (rma_id, vendor_id, previous_status, status, notes, actor_type, actor_id,
       idempotency_key, request_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, rma_id, vendor_id, previous_status, status, notes,
               actor_type, actor_id, idempotency_key, request_hash, created_at`,
    [
      input.rmaId,
      input.vendorId,
      input.previousStatus,
      input.status,
      input.notes,
      input.actorType,
      input.actorId,
      input.idempotencyKey,
      input.requestHash,
      input.createdAt,
    ],
  );
  return requiredRow(result.rows[0], "Dropship RMA status update insert returned no row.");
}

async function findExistingInspectionForRma(
  client: PoolClient,
  rmaId: number,
  idempotencyKey: string,
): Promise<DropshipRmaInspectionRecord | null> {
  const result = await client.query<RmaInspectionRow>(
    `SELECT id, rma_id, outcome, fault_category, notes, photos,
            credit_cents, fee_cents, inspected_by, idempotency_key, request_hash, created_at
     FROM dropship.dropship_rma_inspections
     WHERE rma_id = $1
        OR idempotency_key = $2
     ORDER BY CASE WHEN idempotency_key = $2 THEN 0 ELSE 1 END, id ASC
     LIMIT 1
     FOR UPDATE`,
    [rmaId, idempotencyKey],
  );
  return result.rows[0] ? mapRmaInspectionRow(result.rows[0]) : null;
}

async function insertInspection(
  client: PoolClient,
  input: {
    rmaId: number;
    outcome: DropshipRmaInspectionRecord["outcome"];
    faultCategory: DropshipReturnFaultCategory;
    notes: string | null;
    photos: Record<string, unknown>[];
    creditCents: number;
    feeCents: number;
    inspectedBy: string | null;
    idempotencyKey: string;
    requestHash: string;
    createdAt: Date;
  },
): Promise<DropshipRmaInspectionRecord> {
  const result = await client.query<RmaInspectionRow>(
    `INSERT INTO dropship.dropship_rma_inspections
      (rma_id, outcome, fault_category, notes, photos, credit_cents, fee_cents,
       inspected_by, idempotency_key, request_hash, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)
     RETURNING id, rma_id, outcome, fault_category, notes, photos,
               credit_cents, fee_cents, inspected_by, idempotency_key, request_hash, created_at`,
    [
      input.rmaId,
      input.outcome,
      input.faultCategory,
      input.notes,
      JSON.stringify(input.photos),
      input.creditCents,
      input.feeCents,
      input.inspectedBy,
      input.idempotencyKey,
      input.requestHash,
      input.createdAt,
    ],
  );
  return mapRmaInspectionRow(requiredRow(result.rows[0], "Dropship RMA inspection insert returned no row."));
}

async function updateInspectionItems(
  client: PoolClient,
  rmaId: number,
  items: ProcessDropshipRmaInspectionInput["items"],
): Promise<void> {
  for (const item of items) {
    const result = await client.query(
      `UPDATE dropship.dropship_rma_items
       SET status = $3,
           final_credit_cents = $4,
           fee_cents = $5
       WHERE id = $1
         AND rma_id = $2`,
      [item.rmaItemId, rmaId, item.status, item.finalCreditCents, item.feeCents],
    );
    if (result.rowCount !== 1) {
      throw new DropshipError(
        "DROPSHIP_RMA_ITEM_NOT_FOUND",
        "Dropship RMA inspection referenced an item that was not found on the RMA.",
        { rmaId, rmaItemId: item.rmaItemId },
      );
    }
  }
}

async function recordWalletAdjustmentsForInspection(
  client: PoolClient,
  input: {
    vendorId: number;
    rmaId: number;
    faultCategory: DropshipReturnFaultCategory;
    creditCents: number;
    feeCents: number;
    idempotencyKey: string;
    requestHash: string;
    now: Date;
  },
): Promise<DropshipWalletLedgerRecord[]> {
  if (input.creditCents === 0 && input.feeCents === 0) return [];
  let account = await getOrCreateWalletAccountForUpdate(client, {
    vendorId: input.vendorId,
    currency: "USD",
    now: input.now,
  });
  const entries: DropshipWalletLedgerRecord[] = [];
  if (input.creditCents > 0) {
    const type: DropshipWalletLedgerType = input.faultCategory === "carrier"
      ? "insurance_pool_credit"
      : "return_credit";
    const nextAvailable = account.availableBalanceCents + input.creditCents;
    account = await updateWalletAccountBalance(client, {
      walletAccountId: account.walletAccountId,
      vendorId: input.vendorId,
      availableBalanceCents: nextAvailable,
      pendingBalanceCents: account.pendingBalanceCents,
      updatedAt: input.now,
    });
    entries.push(await insertWalletLedger(client, {
      walletAccountId: account.walletAccountId,
      vendorId: input.vendorId,
      type,
      amountCents: input.creditCents,
      availableBalanceAfterCents: account.availableBalanceCents,
      pendingBalanceAfterCents: account.pendingBalanceCents,
      referenceId: `${input.rmaId}:credit`,
      idempotencyKey: buildWalletReturnIdempotencyKey(input.idempotencyKey, "credit"),
      requestHash: input.requestHash,
      metadata: {
        rmaId: input.rmaId,
        faultCategory: input.faultCategory,
      },
      createdAt: input.now,
    }));
  }
  if (input.feeCents > 0) {
    if (account.availableBalanceCents < input.feeCents) {
      throw new DropshipError(
        "DROPSHIP_WALLET_INSUFFICIENT_FUNDS",
        "Dropship wallet has insufficient available funds for the return fee.",
        {
          vendorId: input.vendorId,
          rmaId: input.rmaId,
          availableBalanceCents: account.availableBalanceCents,
          requiredCents: input.feeCents,
        },
      );
    }
    const nextAvailable = account.availableBalanceCents - input.feeCents;
    account = await updateWalletAccountBalance(client, {
      walletAccountId: account.walletAccountId,
      vendorId: input.vendorId,
      availableBalanceCents: nextAvailable,
      pendingBalanceCents: account.pendingBalanceCents,
      updatedAt: input.now,
    });
    entries.push(await insertWalletLedger(client, {
      walletAccountId: account.walletAccountId,
      vendorId: input.vendorId,
      type: "return_fee",
      amountCents: -input.feeCents,
      availableBalanceAfterCents: account.availableBalanceCents,
      pendingBalanceAfterCents: account.pendingBalanceCents,
      referenceId: `${input.rmaId}:fee`,
      idempotencyKey: buildWalletReturnIdempotencyKey(input.idempotencyKey, "fee"),
      requestHash: input.requestHash,
      metadata: {
        rmaId: input.rmaId,
        faultCategory: input.faultCategory,
      },
      createdAt: input.now,
    }));
  }
  return entries;
}

async function getOrCreateWalletAccountForUpdate(
  client: PoolClient,
  input: { vendorId: number; currency: string; now: Date },
): Promise<{
  walletAccountId: number;
  vendorId: number;
  availableBalanceCents: number;
  pendingBalanceCents: number;
  currency: string;
  status: string;
}> {
  await client.query(
    `INSERT INTO dropship.dropship_wallet_accounts
      (vendor_id, available_balance_cents, pending_balance_cents, currency, status, created_at, updated_at)
     VALUES ($1, 0, 0, $2, 'active', $3, $3)
     ON CONFLICT (vendor_id) DO NOTHING`,
    [input.vendorId, input.currency, input.now],
  );
  const result = await client.query<WalletAccountRow>(
    `SELECT id, vendor_id, available_balance_cents, pending_balance_cents,
            currency, status, created_at, updated_at
     FROM dropship.dropship_wallet_accounts
     WHERE vendor_id = $1
     LIMIT 1
     FOR UPDATE`,
    [input.vendorId],
  );
  const row = requiredRow(result.rows[0], "Dropship wallet account was not found for RMA adjustment.");
  if (row.status !== "active") {
    throw new DropshipError(
      "DROPSHIP_WALLET_ACCOUNT_NOT_ACTIVE",
      "Dropship wallet account is not active.",
      { vendorId: input.vendorId, walletAccountId: row.id, status: row.status },
    );
  }
  if (row.currency !== input.currency) {
    throw new DropshipError(
      "DROPSHIP_WALLET_CURRENCY_MISMATCH",
      "Dropship wallet currency does not match the requested return adjustment currency.",
      { vendorId: input.vendorId, walletAccountId: row.id, walletCurrency: row.currency, currency: input.currency },
    );
  }
  return {
    walletAccountId: row.id,
    vendorId: row.vendor_id,
    availableBalanceCents: Number(row.available_balance_cents),
    pendingBalanceCents: Number(row.pending_balance_cents),
    currency: row.currency,
    status: row.status,
  };
}

async function updateWalletAccountBalance(
  client: PoolClient,
  input: {
    walletAccountId: number;
    vendorId: number;
    availableBalanceCents: number;
    pendingBalanceCents: number;
    updatedAt: Date;
  },
): Promise<{
  walletAccountId: number;
  vendorId: number;
  availableBalanceCents: number;
  pendingBalanceCents: number;
  currency: string;
  status: string;
}> {
  const result = await client.query<WalletAccountRow>(
    `UPDATE dropship.dropship_wallet_accounts
     SET available_balance_cents = $3,
         pending_balance_cents = $4,
         updated_at = $5
     WHERE id = $1
       AND vendor_id = $2
     RETURNING id, vendor_id, available_balance_cents, pending_balance_cents,
               currency, status, created_at, updated_at`,
    [
      input.walletAccountId,
      input.vendorId,
      input.availableBalanceCents,
      input.pendingBalanceCents,
      input.updatedAt,
    ],
  );
  const row = requiredRow(result.rows[0], "Dropship wallet account balance update returned no row.");
  return {
    walletAccountId: row.id,
    vendorId: row.vendor_id,
    availableBalanceCents: Number(row.available_balance_cents),
    pendingBalanceCents: Number(row.pending_balance_cents),
    currency: row.currency,
    status: row.status,
  };
}

async function insertWalletLedger(
  client: PoolClient,
  input: {
    walletAccountId: number;
    vendorId: number;
    type: DropshipWalletLedgerType;
    amountCents: number;
    availableBalanceAfterCents: number;
    pendingBalanceAfterCents: number;
    referenceId: string;
    idempotencyKey: string;
    requestHash: string;
    metadata: Record<string, unknown>;
    createdAt: Date;
  },
): Promise<DropshipWalletLedgerRecord> {
  const result = await client.query<WalletLedgerRow>(
    `INSERT INTO dropship.dropship_wallet_ledger
      (wallet_account_id, vendor_id, type, status, amount_cents, currency,
       available_balance_after_cents, pending_balance_after_cents,
       reference_type, reference_id, idempotency_key, metadata, created_at, settled_at)
     VALUES ($1, $2, $3, 'settled', $4, 'USD', $5, $6,
             'dropship_rma', $7, $8, $9::jsonb, $10, $10)
     RETURNING id, wallet_account_id, vendor_id, type, status, amount_cents, currency,
               available_balance_after_cents, pending_balance_after_cents,
               reference_type, reference_id, idempotency_key, funding_method_id,
               external_transaction_id, metadata, created_at, settled_at`,
    [
      input.walletAccountId,
      input.vendorId,
      input.type,
      input.amountCents,
      input.availableBalanceAfterCents,
      input.pendingBalanceAfterCents,
      input.referenceId,
      input.idempotencyKey,
      JSON.stringify({
        ...input.metadata,
        requestHash: input.requestHash,
      }),
      input.createdAt,
    ],
  );
  const ledger = mapWalletLedgerRow(requiredRow(result.rows[0], "Dropship wallet return ledger insert returned no row."));
  await recordReturnAuditEvent(client, {
    vendorId: input.vendorId,
    entityId: String(ledger.ledgerEntryId),
    eventType: input.type === "return_fee" ? "wallet_return_fee_recorded" : "wallet_return_credit_recorded",
    actor: { actorType: "system" },
    severity: "info",
    payload: {
      type: input.type,
      amountCents: input.amountCents,
      referenceId: input.referenceId,
      idempotencyKey: input.idempotencyKey,
    },
    createdAt: input.createdAt,
  });
  return ledger;
}

async function assertVendorExists(client: PoolClient, vendorId: number): Promise<void> {
  const result = await client.query("SELECT 1 FROM dropship.dropship_vendors WHERE id = $1 LIMIT 1", [vendorId]);
  if (result.rowCount !== 1) {
    throw new DropshipError("DROPSHIP_VENDOR_NOT_FOUND", "Dropship vendor was not found.", { vendorId });
  }
}

async function assertStoreConnectionBelongsToVendor(
  client: PoolClient,
  vendorId: number,
  storeConnectionId: number | null,
): Promise<void> {
  if (!storeConnectionId) return;
  const result = await client.query(
    `SELECT 1
     FROM dropship.dropship_store_connections
     WHERE id = $1
       AND vendor_id = $2
     LIMIT 1`,
    [storeConnectionId, vendorId],
  );
  if (result.rowCount !== 1) {
    throw new DropshipError(
      "DROPSHIP_STORE_CONNECTION_NOT_FOUND",
      "Dropship store connection was not found for the vendor.",
      { vendorId, storeConnectionId },
    );
  }
}

async function assertIntakeBelongsToVendor(client: PoolClient, vendorId: number, intakeId: number | null): Promise<void> {
  if (!intakeId) return;
  const result = await client.query(
    `SELECT 1
     FROM dropship.dropship_order_intake
     WHERE id = $1
       AND vendor_id = $2
     LIMIT 1`,
    [intakeId, vendorId],
  );
  if (result.rowCount !== 1) {
    throw new DropshipError(
      "DROPSHIP_ORDER_INTAKE_NOT_FOUND",
      "Dropship order intake was not found for the vendor.",
      { vendorId, intakeId },
    );
  }
}

async function recordReturnAuditEvent(
  client: PoolClient,
  input: {
    vendorId: number;
    entityId: string;
    eventType: string;
    actor: { actorType: "vendor" | "admin" | "system"; actorId?: string };
    severity: "info" | "warning" | "error";
    payload: Record<string, unknown>;
    createdAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, 'dropship_rma', $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      input.vendorId,
      input.entityId,
      input.eventType,
      input.actor.actorType,
      input.actor.actorId ?? null,
      input.severity,
      JSON.stringify(input.payload),
      input.createdAt,
    ],
  );
}

function assertInspectionReplay(
  inspection: DropshipRmaInspectionRecord,
  idempotencyKey: string,
  requestHash: string,
): void {
  if (inspection.idempotencyKey !== idempotencyKey || inspection.requestHash !== requestHash) {
    throw new DropshipError(
      "DROPSHIP_RMA_ALREADY_INSPECTED",
      "Dropship RMA already has a finalized inspection.",
      {
        rmaId: inspection.rmaId,
        rmaInspectionId: inspection.rmaInspectionId,
      },
    );
  }
}

function assertStatusUpdateReplay(
  statusUpdate: RmaStatusUpdateRow,
  input: UpdateStatusRepositoryInput,
): void {
  if (statusUpdate.request_hash !== input.requestHash || statusUpdate.rma_id !== input.rmaId) {
    throw new DropshipError(
      "DROPSHIP_RMA_STATUS_IDEMPOTENCY_CONFLICT",
      "Dropship RMA status idempotency key was reused with a different request.",
      {
        rmaId: input.rmaId,
        statusUpdateId: statusUpdate.id,
        requestHashMatches: statusUpdate.request_hash === input.requestHash,
      },
    );
  }
}

function assertRequestHash(actual: string | null, expected: string, code: string): void {
  if (actual !== expected) {
    throw new DropshipError(
      code,
      "Dropship return idempotency key was reused with a different request.",
      { requestHashMatches: false },
    );
  }
}

function mapRmaListRow(row: RmaListRow): DropshipRmaListItem {
  return {
    rmaId: row.id,
    rmaNumber: row.rma_number,
    vendorId: row.vendor_id,
    vendorName: row.vendor_name,
    vendorEmail: row.vendor_email,
    storeConnectionId: row.store_connection_id,
    platform: row.platform,
    intakeId: row.intake_id,
    omsOrderId: row.oms_order_id === null ? null : Number(row.oms_order_id),
    status: row.status,
    reasonCode: row.reason_code,
    faultCategory: row.fault_category,
    returnWindowDays: row.return_window_days,
    returnTrackingNumber: row.return_tracking_number,
    requestedAt: row.requested_at,
    receivedAt: row.received_at,
    inspectedAt: row.inspected_at,
    creditedAt: row.credited_at,
    updatedAt: row.updated_at,
    itemCount: Number(row.item_count),
    totalQuantity: Number(row.total_quantity),
  };
}

function mapRmaItemRow(row: RmaItemRow): DropshipRmaItemRecord {
  return {
    rmaItemId: row.id,
    rmaId: row.rma_id,
    productVariantId: row.product_variant_id,
    quantity: row.quantity,
    status: row.status,
    requestedCreditCents: row.requested_credit_cents === null ? null : Number(row.requested_credit_cents),
    finalCreditCents: row.final_credit_cents === null ? null : Number(row.final_credit_cents),
    feeCents: row.fee_cents === null ? null : Number(row.fee_cents),
    createdAt: row.created_at,
  };
}

function mapRmaInspectionRow(row: RmaInspectionRow): DropshipRmaInspectionRecord {
  return {
    rmaInspectionId: row.id,
    rmaId: row.rma_id,
    outcome: row.outcome,
    faultCategory: row.fault_category,
    notes: row.notes,
    photos: row.photos ?? [],
    creditCents: Number(row.credit_cents),
    feeCents: Number(row.fee_cents),
    inspectedBy: row.inspected_by,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    createdAt: row.created_at,
  };
}

function mapWalletLedgerRow(row: WalletLedgerRow): DropshipWalletLedgerRecord {
  return {
    ledgerEntryId: row.id,
    walletAccountId: row.wallet_account_id,
    vendorId: row.vendor_id,
    type: row.type,
    status: row.status,
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    availableBalanceAfterCents: row.available_balance_after_cents === null
      ? null
      : Number(row.available_balance_after_cents),
    pendingBalanceAfterCents: row.pending_balance_after_cents === null
      ? null
      : Number(row.pending_balance_after_cents),
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    idempotencyKey: row.idempotency_key,
    fundingMethodId: row.funding_method_id,
    externalTransactionId: row.external_transaction_id,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

function buildWalletReturnIdempotencyKey(idempotencyKey: string, suffix: "credit" | "fee"): string {
  const hash = createHash("sha256").update(`${idempotencyKey}:${suffix}`).digest("hex").slice(0, 48);
  return `rma_${suffix}_${hash}`;
}

function requiredRow<T>(row: T | null | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }
  return row;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "23505";
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}
