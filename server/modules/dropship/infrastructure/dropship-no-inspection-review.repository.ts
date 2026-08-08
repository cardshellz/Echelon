import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type {
  DropshipNoInspectionReviewRecord,
  DropshipNoInspectionReviewRepository,
} from "../application/dropship-no-inspection-review-service";
import { DropshipError } from "../domain/errors";

interface RmaReviewRow {
  id: number;
  rma_number: string;
  vendor_id: number;
  status: string;
  no_inspection_evidence: Record<string, unknown> | null;
  policy_version_id: number | null;
}

export class PgDropshipNoInspectionReviewRepository implements DropshipNoInspectionReviewRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async getRmaForReview(input: { rmaId: number }): Promise<DropshipNoInspectionReviewRecord | null> {
    const result = await this.dbPool.query<RmaReviewRow>(
      `SELECT id, rma_number, vendor_id, status, no_inspection_evidence, policy_version_id
       FROM dropship.dropship_rmas
       WHERE id = $1
       LIMIT 1`,
      [input.rmaId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      rmaId: row.id,
      rmaNumber: row.rma_number,
      vendorId: row.vendor_id,
      status: row.status,
      noInspectionEvidence: row.no_inspection_evidence,
      policyVersionId: row.policy_version_id,
    };
  }

  async getPoolCreditBasis(input: { rmaId: number }): Promise<{
    wholesaleProductCents: number;
    allocatedShippingCents: number;
    currency: string;
  } | null> {
    // Credit basis (D3 + D2 credit basis rule): wholesale cost actually
    // debited × units requested on the RMA, plus the order's original
    // shipping charge (carrier-fault matrix: product + allocated shipping
    // credited FROM POOL). NEVER retail price. Follows the same
    // pricing-snapshot parsing as the inspection settlement path
    // (dropship-return.repository getOrderEconomics).
    const economics = await this.dbPool.query<{
      shipping_cents: string | number;
      currency: string;
      pricing_snapshot: Record<string, unknown> | null;
    }>(
      `SELECT e.shipping_cents, e.currency, e.pricing_snapshot
       FROM dropship.dropship_rmas r
       JOIN dropship.dropship_order_economics_snapshots e ON e.intake_id = r.intake_id
       WHERE r.id = $1
       LIMIT 1`,
      [input.rmaId],
    );
    const econRow = economics.rows[0];
    if (!econRow) return null;

    const items = await this.dbPool.query<{
      product_variant_id: number | null;
      quantity: string | number;
    }>(
      `SELECT product_variant_id, quantity
       FROM dropship.dropship_rma_items
       WHERE rma_id = $1
       ORDER BY id ASC`,
      [input.rmaId],
    );

    const unitCostByVariant = new Map<number, number>();
    const snapshot = econRow.pricing_snapshot as {
      wholesale?: { lines?: { productVariantId?: unknown; wholesaleUnitCostCents?: unknown }[] };
    } | null;
    for (const line of snapshot?.wholesale?.lines ?? []) {
      const variantId = Number(line.productVariantId);
      const unitCost = Number(line.wholesaleUnitCostCents);
      if (Number.isSafeInteger(variantId) && variantId > 0
        && Number.isSafeInteger(unitCost) && unitCost >= 0) {
        unitCostByVariant.set(variantId, unitCost);
      }
    }

    let wholesaleProductCents = 0;
    for (const item of items.rows) {
      if (item.product_variant_id === null) continue;
      const unitCost = unitCostByVariant.get(item.product_variant_id);
      if (unitCost === undefined) {
        throw new DropshipError(
          "DROPSHIP_NO_INSPECTION_PRICING_MISMATCH",
          "RMA item variant is missing from the order pricing snapshot; the pool credit cannot be priced.",
          { rmaId: input.rmaId, productVariantId: item.product_variant_id },
        );
      }
      const quantity = requireSafeInteger(item.quantity, "rma item quantity");
      wholesaleProductCents += unitCost * quantity;
    }

    return {
      wholesaleProductCents,
      allocatedShippingCents: requireSafeInteger(econRow.shipping_cents, "shipping_cents"),
      currency: econRow.currency,
    };
  }

  async approveReview(input: {
    rmaId: number;
    vendorId: number;
    creditCents: number;
    currency: string;
    reason: string | null;
    policyVersionId: number | null;
    idempotencyKey: string;
    requestHash: string;
    actor: { actorType: "admin"; actorId: string };
    now: Date;
  }): Promise<{
    status: string;
    walletLedgerEntryId: number | null;
    poolLedgerEntryId: number | null;
    idempotentReplay: boolean;
  }> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<{ id: number; status: string }>(
        `SELECT id, status FROM dropship.dropship_rmas WHERE id = $1 LIMIT 1 FOR UPDATE`,
        [input.rmaId],
      );
      const rma = locked.rows[0];
      if (!rma) {
        throw new DropshipError(
          "DROPSHIP_RMA_NOT_FOUND",
          "Dropship RMA was not found for no-inspection approval.",
          { rmaId: input.rmaId },
        );
      }

      // One-time idempotency (D3): the wallet credit key is deterministic per
      // RMA. When it already exists, this approval is a replay — return the
      // existing ids and never credit twice.
      const creditIdempotencyKey = `dropship-no-inspection-credit:${input.rmaId}`;
      const existingCredit = await client.query<{ id: number }>(
        `SELECT id FROM dropship.dropship_wallet_ledger WHERE idempotency_key = $1 LIMIT 1`,
        [creditIdempotencyKey],
      );
      if (existingCredit.rows[0]) {
        const poolRow = await client.query<{ id: number }>(
          `SELECT id FROM dropship.dropship_insurance_pool_ledger
           WHERE idempotency_key = $1 LIMIT 1`,
          [`dropship-pool-payout:${input.rmaId}`],
        );
        await client.query("COMMIT");
        return {
          status: rma.status,
          walletLedgerEntryId: existingCredit.rows[0].id,
          poolLedgerEntryId: poolRow.rows[0]?.id ?? null,
          idempotentReplay: true,
        };
      }

      if (rma.status !== "no_inspection_review") {
        throw new DropshipError(
          "DROPSHIP_RMA_NOT_IN_NO_INSPECTION_REVIEW",
          "Dropship RMA is not queued for no-inspection review.",
          { rmaId: input.rmaId, status: rma.status },
        );
      }

      // 1. Vendor wallet credit from the pool (insurance_pool_credit).
      const account = await getOrCreateWalletAccountForUpdate(client, {
        vendorId: input.vendorId,
        currency: input.currency,
        now: input.now,
      });
      const nextAvailable = account.availableBalanceCents + input.creditCents;
      await client.query(
        `UPDATE dropship.dropship_wallet_accounts
         SET available_balance_cents = $2, updated_at = $3
         WHERE id = $1`,
        [account.walletAccountId, nextAvailable, input.now],
      );
      const walletLedger = await client.query<{ id: number }>(
        `INSERT INTO dropship.dropship_wallet_ledger
          (wallet_account_id, vendor_id, type, status, amount_cents, currency,
           available_balance_after_cents, pending_balance_after_cents,
           reference_type, reference_id, idempotency_key, metadata, created_at, settled_at)
         VALUES ($1, $2, 'insurance_pool_credit', 'settled', $3, $4, $5, $6,
                 'dropship_rma_no_inspection', $7, $8, $9::jsonb, $10, $10)
         RETURNING id`,
        [
          account.walletAccountId,
          input.vendorId,
          input.creditCents,
          input.currency,
          nextAvailable,
          account.pendingBalanceCents,
          `${input.rmaId}:no-inspection-credit`,
          creditIdempotencyKey,
          JSON.stringify({
            rmaId: input.rmaId,
            source: "insurance_pool",
            noInspection: true,
            policyVersionId: input.policyVersionId,
            approvedBy: input.actor.actorId,
          }),
          input.now,
        ],
      );
      const walletLedgerEntryId = requiredRow(
        walletLedger.rows[0],
        "No-inspection wallet credit insert returned no row.",
      ).id;

      // 2. Pool-ledger payout row (the pool side of the movement).
      const poolLedger = await client.query<{ id: number }>(
        `INSERT INTO dropship.dropship_insurance_pool_ledger
          (entry_type, amount_cents, currency, rma_id, wallet_ledger_entry_id,
           reference_type, reference_id, idempotency_key, metadata, created_at)
         VALUES ('no_inspection_payout', $1, $2, $3, $4,
                 'dropship_rma_no_inspection', $5, $6, $7::jsonb, $8)
         RETURNING id`,
        [
          -input.creditCents,
          input.currency,
          input.rmaId,
          walletLedgerEntryId,
          `${input.rmaId}:no-inspection-credit`,
          `dropship-pool-payout:${input.rmaId}`,
          JSON.stringify({
            rmaId: input.rmaId,
            walletLedgerEntryId,
            approvedBy: input.actor.actorId,
          }),
          input.now,
        ],
      );
      const poolLedgerEntryId = requiredRow(
        poolLedger.rows[0],
        "No-inspection pool ledger insert returned no row.",
      ).id;

      // 3. Transition no_inspection_review → credited (system-ledger path,
      //    D4: credited is system-written only after the ledger commits).
      const statusUpdateKey = `dropship-no-inspection-credited:${input.rmaId}`;
      const updated = await client.query(
        `UPDATE dropship.dropship_rmas
         SET status = 'credited', credited_at = $2, updated_at = $2
         WHERE id = $1
           AND status = 'no_inspection_review'`,
        [input.rmaId, input.now],
      );
      assertOneRowAffected(updated.rowCount, "No-inspection RMA credit transition failed.");
      await client.query(
        `INSERT INTO dropship.dropship_rma_status_updates
          (rma_id, vendor_id, previous_status, status, notes, actor_type, actor_id,
           policy_version_id, idempotency_key, request_hash, created_at)
         VALUES ($1, $2, 'no_inspection_review', 'credited', $3, 'system', $4, $5, $6, $7, $8)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          input.rmaId,
          input.vendorId,
          input.reason ?? "No-inspection review approved; pool credit posted.",
          input.actor.actorId,
          input.policyVersionId,
          statusUpdateKey,
          input.requestHash,
          input.now,
        ],
      );

      await client.query(
        `INSERT INTO dropship.dropship_audit_events
          (vendor_id, store_connection_id, entity_type, entity_id, event_type,
           actor_type, actor_id, severity, payload, created_at)
         VALUES ($1, NULL, 'dropship_rma', $2, 'rma_no_inspection_approved',
                 'admin', $3, 'info', $4::jsonb, $5)`,
        [
          input.vendorId,
          String(input.rmaId),
          input.actor.actorId,
          JSON.stringify({
            previousStatus: "no_inspection_review",
            status: "credited",
            creditCents: input.creditCents,
            currency: input.currency,
            walletLedgerEntryId,
            poolLedgerEntryId,
            policyVersionId: input.policyVersionId,
          }),
          input.now,
        ],
      );

      await client.query("COMMIT");
      return {
        status: "credited",
        walletLedgerEntryId,
        poolLedgerEntryId,
        idempotentReplay: false,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async denyReview(input: {
    rmaId: number;
    vendorId: number;
    reason: string;
    policyVersionId: number | null;
    idempotencyKey: string;
    requestHash: string;
    actor: { actorType: "admin"; actorId: string };
    now: Date;
  }): Promise<{ status: string; idempotentReplay: boolean }> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<{ id: number; status: string }>(
        `SELECT id, status FROM dropship.dropship_rmas WHERE id = $1 LIMIT 1 FOR UPDATE`,
        [input.rmaId],
      );
      const rma = locked.rows[0];
      if (!rma) {
        throw new DropshipError(
          "DROPSHIP_RMA_NOT_FOUND",
          "Dropship RMA was not found for no-inspection denial.",
          { rmaId: input.rmaId },
        );
      }
      if (rma.status === "closed") {
        await client.query("COMMIT");
        return { status: "closed", idempotentReplay: true };
      }
      if (rma.status !== "no_inspection_review") {
        throw new DropshipError(
          "DROPSHIP_RMA_NOT_IN_NO_INSPECTION_REVIEW",
          "Dropship RMA is not queued for no-inspection review.",
          { rmaId: input.rmaId, status: rma.status },
        );
      }

      const updated = await client.query(
        `UPDATE dropship.dropship_rmas
         SET status = 'closed', updated_at = $2
         WHERE id = $1
           AND status = 'no_inspection_review'`,
        [input.rmaId, input.now],
      );
      assertOneRowAffected(updated.rowCount, "No-inspection RMA deny transition failed.");
      const inserted = await client.query(
        `INSERT INTO dropship.dropship_rma_status_updates
          (rma_id, vendor_id, previous_status, status, notes, actor_type, actor_id,
           policy_version_id, idempotency_key, request_hash, created_at)
         VALUES ($1, $2, 'no_inspection_review', 'closed', $3, 'admin', $4, $5, $6, $7, $8)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          input.rmaId,
          input.vendorId,
          input.reason,
          input.actor.actorId,
          input.policyVersionId,
          input.idempotencyKey,
          input.requestHash,
          input.now,
        ],
      );

      await client.query(
        `INSERT INTO dropship.dropship_audit_events
          (vendor_id, store_connection_id, entity_type, entity_id, event_type,
           actor_type, actor_id, severity, payload, created_at)
         VALUES ($1, NULL, 'dropship_rma', $2, 'rma_no_inspection_denied',
                 'admin', $3, 'info', $4::jsonb, $5)`,
        [
          input.vendorId,
          String(input.rmaId),
          input.actor.actorId,
          JSON.stringify({
            previousStatus: "no_inspection_review",
            status: "closed",
            reason: input.reason,
            policyVersionId: input.policyVersionId,
          }),
          input.now,
        ],
      );

      await client.query("COMMIT");
      return { status: "closed", idempotentReplay: inserted.rowCount === 0 };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordClaimReplenishment(input: {
    carrierClaimId: number;
    amountCents: number;
    currency: string;
    providerPayoutReference: string;
    idempotencyKey: string;
    actor: { actorType: "admin" | "system"; actorId?: string };
    now: Date;
  }): Promise<{ poolLedgerEntryId: number; idempotentReplay: boolean }> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      // Resolve the claim's linked RMA (when any) for the pool-ledger row.
      // The claim row is the authority on the linkage — never trust caller
      // input for it.
      const claim = await client.query<{ id: number; rma_id: number | null }>(
        `SELECT id, rma_id FROM dropship.dropship_carrier_claims WHERE id = $1 LIMIT 1 FOR SHARE`,
        [input.carrierClaimId],
      );
      const claimRow = requiredRow(claim.rows[0], "Carrier claim was not found for pool replenishment.");

      const inserted = await client.query<{ id: number }>(
        `INSERT INTO dropship.dropship_insurance_pool_ledger
          (entry_type, amount_cents, currency, rma_id, carrier_claim_id,
           reference_type, reference_id, idempotency_key, metadata, created_at)
         VALUES ('claim_replenishment', $1, $2, $3, $4,
                 'carrier_claim_payout', $5, $6, $7::jsonb, $8)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [
          input.amountCents,
          input.currency,
          claimRow.rma_id,
          input.carrierClaimId,
          input.providerPayoutReference,
          input.idempotencyKey,
          JSON.stringify({
            carrierClaimId: input.carrierClaimId,
            rmaId: claimRow.rma_id,
            providerPayoutReference: input.providerPayoutReference,
            recordedBy: input.actor.actorId ?? input.actor.actorType,
          }),
          input.now,
        ],
      );
      if (!inserted.rows[0]) {
        const existing = await client.query<{ id: number }>(
          `SELECT id FROM dropship.dropship_insurance_pool_ledger WHERE idempotency_key = $1 LIMIT 1`,
          [input.idempotencyKey],
        );
        const row = requiredRow(existing.rows[0], "Pool replenishment replay row was not found.");
        await client.query("COMMIT");
        return { poolLedgerEntryId: row.id, idempotentReplay: true };
      }

      await client.query(
        `INSERT INTO dropship.dropship_audit_events
          (vendor_id, store_connection_id, entity_type, entity_id, event_type,
           actor_type, actor_id, severity, payload, created_at)
         SELECT i.vendor_id, i.store_connection_id, 'dropship_carrier_claim', $2,
                'insurance_pool_claim_replenishment', $3, $4, 'info', $5::jsonb, $6
         FROM dropship.dropship_carrier_claims cc
         JOIN dropship.dropship_order_intake i ON i.id = cc.intake_id
         WHERE cc.id = $1`,
        [
          input.carrierClaimId,
          String(input.carrierClaimId),
          input.actor.actorType,
          input.actor.actorId ?? null,
          JSON.stringify({
            carrierClaimId: input.carrierClaimId,
            rmaId: claimRow.rma_id,
            amountCents: input.amountCents,
            currency: input.currency,
            providerPayoutReference: input.providerPayoutReference,
            poolLedgerEntryId: inserted.rows[0].id,
          }),
          input.now,
        ],
      );

      await client.query("COMMIT");
      return { poolLedgerEntryId: inserted.rows[0].id, idempotentReplay: false };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function getOrCreateWalletAccountForUpdate(
  client: PoolClient,
  input: { vendorId: number; currency: string; now: Date },
): Promise<{ walletAccountId: number; availableBalanceCents: number; pendingBalanceCents: number }> {
  await client.query(
    `INSERT INTO dropship.dropship_wallet_accounts
      (vendor_id, available_balance_cents, pending_balance_cents, currency, status, created_at, updated_at)
     VALUES ($1, 0, 0, $2, 'active', $3, $3)
     ON CONFLICT (vendor_id) DO NOTHING`,
    [input.vendorId, input.currency, input.now],
  );
  const result = await client.query<{
    id: number;
    available_balance_cents: string | number;
    pending_balance_cents: string | number;
  }>(
    `SELECT id, available_balance_cents, pending_balance_cents
     FROM dropship.dropship_wallet_accounts
     WHERE vendor_id = $1
     LIMIT 1
     FOR UPDATE`,
    [input.vendorId],
  );
  const row = requiredRow(result.rows[0], "Dropship wallet account was not found for no-inspection credit.");
  return {
    walletAccountId: row.id,
    availableBalanceCents: requireSafeInteger(row.available_balance_cents, "available_balance_cents"),
    pendingBalanceCents: requireSafeInteger(row.pending_balance_cents, "pending_balance_cents"),
  };
}

function requireSafeInteger(value: string | number, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new DropshipError(
      "DROPSHIP_NO_INSPECTION_STORED_MONEY_INVALID",
      `${field} is not a safe integer.`,
      { value: String(value) },
    );
  }
  return parsed;
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (row === undefined) {
    throw new DropshipError("DROPSHIP_NO_INSPECTION_WRITE_INCOMPLETE", message);
  }
  return row;
}

function assertOneRowAffected(rowCount: number | null, message: string): void {
  if (rowCount !== 1) {
    throw new DropshipError("DROPSHIP_NO_INSPECTION_WRITE_INCOMPLETE", message, { rowCount });
  }
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}
