import { sql } from "drizzle-orm";
import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";
import {
  HISTORICAL_COST_EVIDENCE_ORDER_POLICY,
  HistoricalCostEvidenceOrderError,
  orderHistoricalCostEvidence,
} from "../domain/historical-cost-evidence-order";
import {
  historicalCostQuantityGap,
  historicalCostQuantitySnapshotSchema,
  type HistoricalCostQuantitySnapshot,
} from "../domain/historical-cost-quantity";
import {
  CostEvidenceError,
  costInteger,
  lockInventoryCostGraph,
  type CostEvidenceTransaction,
} from "./cost-evidence.repository";
import {
  lotCostTotals,
  lotCostsForIntervals,
  normalizeLotCosts,
  recordedUnitCostMills,
  hasExactLotCostTotals,
  type LotCostRecord,
  type LotCosts,
} from "../domain/lot-cost";
import {
  returnableCostQuantities,
  ReturnCostQuantityError,
} from "../domain/return-cost-quantity";
import {
  sliceCostQuantityIntervals,
  subtractCostQuantityIntervals,
  takeCostQuantityIntervals,
  validateCostQuantityIntervals,
  intersectCostQuantityIntervals,
  type CostQuantityInterval,
} from "../domain/cost-quantity-intervals";

const MAX_COST_ALLOCATION_RECORDS = 50_000;
const MICROSECONDS_PER_SECOND = 1_000_000;
const intervalsSchema = z.array(
  z
    .object({
      start: z.number().int().nonnegative().safe(),
      quantity: z.number().int().positive().safe(),
    })
    .strict(),
);
interface AllocationRow {
  id: number;
  inventory_lot_id: number;
  direction: number;
  quantity: number;
  intervals: CostQuantityInterval[];
  reverses_allocation_id: number | null;
  source_evidence: Record<string, unknown>;
}
export interface LotQuantityCostAllocation {
  id: number | null;
  intervals: CostQuantityInterval[];
  costs: LotCosts;
}

function auditIdentity(actor: string, now: Date): void {
  if (
    typeof actor !== "string" ||
    !actor.trim() ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime())
  )
    throw new CostEvidenceError(
      "COST_AUDIT_IDENTITY_REQUIRED",
      "Exact quantity cost needs an actor and injected timestamp.",
    );
}

function parseAllocationRows(
  rows: Record<string, unknown>[],
  lotId: number,
): AllocationRow[] {
  return rows.map((row) => {
    const parsed = intervalsSchema.safeParse(row.intervals);
    if (!parsed.success || ![-1, 0, 1].includes(Number(row.direction)))
      throw new CostEvidenceError(
        "COST_QUANTITY_EVIDENCE_INVALID",
        "Recorded cost quantity custody is invalid.",
        { lotId },
      );
    const quantity = costInteger(row.quantity, "allocation.quantity", 1);
    if (
      parsed.data.reduce(
        (sum, interval) => sum + BigInt(interval.quantity),
        BigInt(0),
      ) !== BigInt(quantity)
    ) {
      throw new CostEvidenceError(
        "COST_QUANTITY_EVIDENCE_INVALID",
        "Recorded cost intervals do not equal their allocation quantity.",
        { lotId },
      );
    }
    return {
      id: costInteger(row.id, "allocation.id", 1),
      inventory_lot_id: lotId,
      direction: Number(row.direction),
      quantity,
      intervals: parsed.data,
      reverses_allocation_id:
        row.reverses_allocation_id == null
          ? null
          : costInteger(row.reverses_allocation_id, "reversesAllocationId", 1),
      source_evidence: z.record(z.unknown()).parse(row.source_evidence),
    };
  });
}

async function readAllocations(
  tx: CostEvidenceTransaction,
  lotId: number,
): Promise<AllocationRow[]> {
  const result =
    await tx.execute(sql`SELECT id,inventory_lot_id,direction,quantity,intervals,reverses_allocation_id,source_evidence
    FROM inventory.lot_cost_quantity_allocations WHERE inventory_lot_id=${lotId}
    ORDER BY id LIMIT ${MAX_COST_ALLOCATION_RECORDS + 1}`);
  if (result.rows.length > MAX_COST_ALLOCATION_RECORDS)
    throw new CostEvidenceError(
      "COST_QUANTITY_RECORD_LIMIT",
      "This lot needs a bounded review of its complete quantity-cost history.",
      { lotId },
    );
  return parseAllocationRows(result.rows, lotId);
}

export function occupiedCostQuantityIntervals(
  rows: readonly AllocationRow[],
  basis: number,
): CostQuantityInterval[] {
  const occupied: CostQuantityInterval[] = [];
  const positiveIds = new Set(
    rows.filter((row) => row.direction === 1).map((row) => row.id),
  );
  const reversals = new Map<number, CostQuantityInterval[]>();
  for (const row of rows) {
    if (row.direction !== -1) continue;
    if (
      row.reverses_allocation_id === null ||
      !positiveIds.has(row.reverses_allocation_id)
    ) {
      throw new CostEvidenceError(
        "COST_REVERSAL_SOURCE_MISSING",
        "Cost reversal has no original positive allocation.",
      );
    }
    const intervals = reversals.get(row.reverses_allocation_id) ?? [];
    intervals.push(...row.intervals);
    reversals.set(row.reverses_allocation_id, intervals);
  }
  for (const row of rows) {
    validateCostQuantityIntervals(row.intervals, basis);
    if (row.direction !== 1) continue;
    occupied.push(
      ...subtractCostQuantityIntervals(
        row.intervals,
        reversals.get(row.id) ?? [],
        basis,
      ),
    );
  }
  validateCostQuantityIntervals(occupied, basis);
  return occupied;
}

async function insertAllocation(
  tx: CostEvidenceTransaction,
  input: {
    lotId: number;
    key: string | null;
    direction: -1 | 0 | 1;
    quantity: number;
    intervals: CostQuantityInterval[];
    reversesId?: number;
    evidence: Record<string, unknown>;
    actor: string;
    now: Date;
  },
): Promise<number> {
  auditIdentity(input.actor, input.now);
  costInteger(input.lotId, "lotId", 1);
  const quantity = costInteger(input.quantity, "allocation.quantity", 1);
  if (
    quantity > 2_147_483_647 ||
    input.intervals.length === 0 ||
    input.intervals.reduce(
      (sum, interval) => sum + BigInt(interval.quantity),
      BigInt(0),
    ) !== BigInt(quantity)
  ) {
    throw new CostEvidenceError(
      "COST_QUANTITY_EVIDENCE_INVALID",
      "Allocation intervals must equal their supported quantity.",
    );
  }
  if (
    input.key !== null &&
    (typeof input.key !== "string" || !input.key.trim())
  ) {
    throw new CostEvidenceError(
      "COST_ALLOCATION_KEY_INVALID",
      "Cost allocation retry identity cannot be blank.",
    );
  }
  // This explicitly stateful identity is allocated in the caller's transaction.
  // Public physical commands own retry identity; imports and references also
  // provide stable keys so repeated applications cannot create new custody.
  const sequence = await tx.execute(
    sql`SELECT nextval(pg_get_serial_sequence('inventory.lot_cost_quantity_allocations','id')) AS id`,
  );
  const id = costInteger(sequence.rows[0]?.id, "allocation.id", 1);
  await tx.execute(sql`INSERT INTO inventory.lot_cost_quantity_allocations
    (id,inventory_lot_id,allocation_key,direction,quantity,intervals,reverses_allocation_id,source_evidence,recorded_by,recorded_at)
    OVERRIDING SYSTEM VALUE VALUES (${id},${input.lotId},${input.key ?? `cost_quantity:${id}`},${input.direction},${input.quantity},
      ${canonicalJson(input.intervals)}::jsonb,${input.reversesId ?? null},${canonicalJson(input.evidence)}::jsonb,${input.actor},${input.now})`);
  return id;
}

/** Establish historical financial allocation positions only from the complete
 * recorded operation/COGS quantities. Stable evidence order is a documented
 * allocation policy, not an assertion about unidentified physical pieces.
 * Ordinary stock commands reject incomplete history. A cost revision may retain
 * a positive unexplained portion in immutable financial custody. This portion
 * is neither stock nor COGS and remains an explicit review on every application.
 * Conflicting quantities and unidentified reversals always prevent import.
 */
export async function ensureLotCostQuantityBasis(
  tx: CostEvidenceTransaction,
  lot: LotCostRecord & { id: unknown; qty_on_hand?: unknown; lot_number?: unknown },
  actor: string,
  now: Date,
  options: { retainUnresolvedQuantity?: boolean; verifyOnHand?: boolean } = {},
): Promise<number> {
  const lotId = costInteger(lot.id, "lot.id", 1);
  const basis = costInteger(lot.qty_received, "lot.qtyReceived", 1);
  const prior = await tx.execute(
    sql`SELECT quantity FROM inventory.lot_cost_quantity_bases WHERE inventory_lot_id=${lotId}`,
  );
  if (prior.rows.length > 0) {
    if (costInteger(prior.rows[0].quantity, "basis.quantity", 1) !== basis)
      throw new CostEvidenceError(
        "COST_QUANTITY_BASIS_CHANGED",
        "Original lot quantity differs from its immutable cost basis.",
        { lotId },
      );
  }
  auditIdentity(actor, now);
  const operations =
    await tx.execute(sql`SELECT operation_key,operation_kind,MIN(id)::text AS first_id,
    CASE WHEN bool_and(recorded_at IS NOT NULL AND isfinite(recorded_at))
      THEN trunc(EXTRACT(EPOCH FROM MIN(recorded_at)) * ${MICROSECONDS_PER_SECOND})::text
      ELSE NULL END AS recorded_at_micros,
    MIN(source_qty) AS minimum_qty,MAX(source_qty) AS quantity
    FROM inventory.lot_cost_contributions WHERE source_lot_id=${lotId} AND operation_kind<>'return'
    GROUP BY operation_key,operation_kind ORDER BY MIN(recorded_at),MIN(id)`);
  // EXTRACT on timestamp without time zone uses the stored nominal coordinate;
  // on timestamptz it uses the absolute instant. Neither depends on Node's TZ or
  // PostgreSQL's session timezone. Keep microseconds instead of parsing through
  // JavaScript Date, which both interprets naive dates locally and truncates them.
  const cogs = await tx.execute(sql`SELECT *,
    trunc(EXTRACT(EPOCH FROM created_at) * ${MICROSECONDS_PER_SECOND})::text AS created_at_micros FROM oms.order_item_costs
    WHERE inventory_lot_id=${lotId} ORDER BY created_at,id FOR UPDATE`);
  const missingReversals = cogs.rows.filter(
    (row) => Number(row.qty) < 0 && row.cost_quantity_allocation_id == null,
  );
  const reversals = new Map<number, number>();
  if (missingReversals.length > 0) {
    const available = await tx.execute(
      sql`SELECT to_regclass('inventory.availability_claim_pick_movements') IS NOT NULL AS present`,
    );
    if (!available.rows[0]?.present)
      throw new CostEvidenceError(
        "COST_HISTORICAL_REVERSAL_REVIEW",
        "Historical signed consumption has no original reversal registry.",
        { lotId },
      );
    const links =
      await tx.execute(sql`SELECT reversal.order_item_cost_id AS negative_cost_id,original.order_item_cost_id AS original_cost_id,reversal.quantity
      FROM inventory.availability_claim_pick_movements reversal
      JOIN inventory.availability_claim_pick_movements original ON original.id=reversal.reverses_pick_movement_id
      WHERE reversal.order_item_cost_id IN (SELECT value::integer FROM jsonb_array_elements_text(${JSON.stringify(missingReversals.map((row) => Number(row.id)))}::jsonb))
      AND reversal.movement_type='unpick' AND original.movement_type='pick'`);
    const mapped = links.rows.map((row) => ({
      negativeCostId: costInteger(row.negative_cost_id, "negativeCostId", 1),
      originalCostId: costInteger(row.original_cost_id, "originalCostId", 1),
      quantity: costInteger(row.quantity, "reversal.quantity", 1),
    }));
    try {
      returnableCostQuantities(
        cogs.rows
          .filter(
            (row) =>
              Number(row.qty) > 0 || row.cost_quantity_allocation_id == null,
          )
          .map((row) => ({
            id: costInteger(row.id, "costId", 1),
            inventoryLotId: lotId,
            quantity: costInteger(row.qty, "cost.quantity", -2_147_483_647),
            unitMills: recordedUnitCostMills(row),
          })),
        mapped,
      );
    } catch (error) {
      if (error instanceof ReturnCostQuantityError)
        throw new CostEvidenceError(
          "COST_HISTORICAL_REVERSAL_REVIEW",
          error.message,
          { lotId },
        );
      throw error;
    }
    for (const link of mapped)
      reversals.set(link.negativeCostId, link.originalCostId);
  }
  const operationMappings =
    await tx.execute(sql`SELECT edge.operation_key,mapping.allocation_id,allocation.intervals,allocation.quantity
    FROM inventory.lot_cost_contributions edge JOIN inventory.lot_cost_contribution_allocations mapping ON mapping.contribution_id=edge.id
    JOIN inventory.lot_cost_quantity_allocations allocation ON allocation.id=mapping.allocation_id
    WHERE edge.source_lot_id=${lotId} AND edge.operation_kind<>'return' ORDER BY edge.id`);
  const mappedOperations = new Map<string, number>();
  const mappedIntervals = new Map<string, string>();
  for (const row of operationMappings.rows) {
    const id = costInteger(row.allocation_id, "allocation.id", 1);
    const key = String(row.operation_key);
    const signature = canonicalJson({
      quantity: costInteger(row.quantity, "operation.allocationQty", 1),
      intervals: intervalsSchema.parse(row.intervals),
    });
    if (mappedIntervals.has(key) && mappedIntervals.get(key) !== signature)
      throw new CostEvidenceError(
        "COST_OPERATION_ALLOCATION_CONFLICT",
        "One operation records different complete source intervals.",
        { lotId, operationKey: key },
      );
    mappedIntervals.set(key, signature);
    mappedOperations.set(String(row.operation_key), id);
  }
  for (const operation of operations.rows) {
    if (Number(operation.minimum_qty) !== Number(operation.quantity))
      throw new CostEvidenceError(
        "COST_OPERATION_QUANTITY_CONFLICT",
        "One operation records conflicting source quantities.",
        { lotId, operationKey: operation.operation_key },
      );
  }
  const unorderedCandidates = [
    ...operations.rows
      .filter((row) => !mappedOperations.has(String(row.operation_key)))
      .map((row) => {
        if (Number(row.minimum_qty) !== Number(row.quantity))
          throw new CostEvidenceError(
            "COST_OPERATION_QUANTITY_CONFLICT",
            "One operation records conflicting source quantities.",
            { lotId, operationKey: row.operation_key },
          );
        return {
          kind: "operation" as const,
          key: `operation:${lotId}:${row.operation_key}`,
          quantity: costInteger(row.quantity, "operation.quantity", 1),
          timestampMicros: row.recorded_at_micros,
          id: costInteger(row.first_id, "operation.id", 1),
          operationKey: row.operation_key,
        };
      }),
    ...cogs.rows
      .filter((row) => row.cost_quantity_allocation_id == null)
      .map((row) => ({
        kind: Number(row.qty) < 0 ? "reversal" as const : "cogs" as const,
        key: `historical_cogs:${row.id}`,
        quantity: Math.abs(
          costInteger(row.qty, "cogs.quantity", -2_147_483_647),
        ),
        timestampMicros: row.created_at_micros,
        id: costInteger(row.id, "cogs.id", 1),
        operationKey: null,
      })),
  ];
  let candidates: Array<(typeof unorderedCandidates)[number] & { timestampMicros: string }>;
  try {
    candidates = orderHistoricalCostEvidence(unorderedCandidates);
  } catch (error) {
    if (error instanceof HistoricalCostEvidenceOrderError) {
      throw new CostEvidenceError(error.code, error.message, {
        lotId, sourceKind: error.sourceKind, sourceId: error.sourceId,
      });
    }
    throw error;
  }
  // During an owning stock transaction quantity projections may be buffered.
  // Existing immutable custody remains the authority; only a newly observed
  // legacy operation requires a complete historical reconciliation.
  if (prior.rows.length > 0 && candidates.length === 0) {
    if (options.verifyOnHand) {
      const used = occupiedCostQuantityIntervals(await readAllocations(tx, lotId), basis)
        .reduce((sum, interval) => sum + BigInt(interval.quantity), BigInt(0));
      const onHand = costInteger(lot.qty_on_hand, "lot.qtyOnHand");
      if (used + BigInt(onHand) !== BigInt(basis)) throw new CostEvidenceError(
        "COST_QUANTITY_CUSTODY_CONFLICT",
        `Lot ${String(lot.lot_number ?? lotId)}: recorded cost quantities leave ${BigInt(basis) - used} units, but on-hand stock is ${onHand}. Review the stock movements before updating costs.`,
        { lotId },
      );
    }
    await mapHistoricalReturnIntervals(tx, lotId, actor, now);
    return basis;
  }
  const occupied = occupiedCostQuantityIntervals(
    await readAllocations(tx, lotId),
    basis,
  );
  const occupiedQuantity = occupied.reduce(
    (sum, interval) => sum + interval.quantity,
    0,
  );
  const total = candidates.reduce(
    (sum, candidate) =>
      sum +
      BigInt(candidate.quantity) *
        (candidate.kind === "reversal" ? BigInt(-1) : BigInt(1)),
    BigInt(occupiedQuantity),
  );
  const onHandQuantity = costInteger(lot.qty_on_hand, "lot.qtyOnHand");
  const gap = BigInt(basis) - BigInt(onHandQuantity) - total;
  // A newly observed discrepancy on an established basis is not legacy import.
  // Do not absorb it into an existing hold or conceal an active posting error.
  if (gap !== BigInt(0) && (!options.retainUnresolvedQuantity || prior.rows.length > 0 || gap < BigInt(0) || total < BigInt(0))) {
    throw new CostEvidenceError(
      "COST_HISTORICAL_QUANTITY_INCOMPLETE",
      `Lot ${String(lot.lot_number ?? lotId)}: original quantity ${basis}, on hand ${onHandQuantity}, recorded outflow ${total}. These quantities do not reconcile.`,
      { lotId, originalQuantity: basis, onHandQuantity, recordedOutflowQuantity: total.toString() },
    );
  }
  const unresolved = historicalCostQuantityGap({ originalQuantity: basis, onHandQuantity,
    recordedOutflowQuantity: costInteger(total.toString(), "recordedOutflowQuantity") });
  let assigned = occupied;
  for (const candidate of candidates) {
    if (candidate.kind === "reversal") {
      const original = await tx.execute(
        sql`SELECT cost_quantity_allocation_id FROM oms.order_item_costs WHERE id=${reversals.get(candidate.id)}`,
      );
      const reversed = await reverseLotQuantityCost(
        tx,
        costInteger(
          original.rows[0]?.cost_quantity_allocation_id,
          "originalAllocationId",
          1,
        ),
        candidate.quantity,
        actor,
        now,
        candidate.key,
      );
      await tx.execute(
        sql`UPDATE oms.order_item_costs SET cost_quantity_allocation_id=${reversed.id} WHERE id=${candidate.id}`,
      );
      assigned = occupiedCostQuantityIntervals(
        await readAllocations(tx, lotId),
        basis,
      );
      continue;
    }
    const intervals = takeCostQuantityIntervals(
      basis,
      assigned,
      candidate.quantity,
    );
    const id = await insertAllocation(tx, {
      lotId,
      key: candidate.key,
      direction: 1,
      quantity: candidate.quantity,
      intervals,
      evidence: {
        policy: HISTORICAL_COST_EVIDENCE_ORDER_POLICY,
        sourceKind: candidate.kind,
        sourceId: candidate.id,
        operationKey: candidate.operationKey,
      },
      actor,
      now,
    });
    if (candidate.kind === "cogs") {
      await tx.execute(
        sql`UPDATE oms.order_item_costs SET cost_quantity_allocation_id=${id} WHERE id=${candidate.id}`,
      );
    } else {
      await tx.execute(sql`INSERT INTO inventory.lot_cost_contribution_allocations(contribution_id,allocation_id,recorded_by,recorded_at)
        SELECT id,${id},${actor},${now} FROM inventory.lot_cost_contributions
        WHERE source_lot_id=${lotId} AND operation_key=${candidate.operationKey}`);
    }
    assigned = [...assigned, ...intervals];
  }
  if (unresolved !== null) {
    // Known operations retain their deterministic intervals. Reserve the gap
    // before the remaining stock; later cost revisions can revalue every known
    // destination without assigning this amount to an unrelated order.
    await insertAllocation(tx, {
      lotId, key: `historical_unresolved_quantity:${lotId}`, direction: 1,
      quantity: unresolved.unresolvedQuantity,
      intervals: takeCostQuantityIntervals(basis, assigned, unresolved.unresolvedQuantity),
      evidence: { sourceKind: "unresolved_historical_quantity", policy: "retain_unresolved_quantity_v1", snapshot: unresolved },
      actor, now,
    });
  }
  if (prior.rows.length === 0)
    await tx.execute(sql`INSERT INTO inventory.lot_cost_quantity_bases(inventory_lot_id,quantity,source_evidence,recorded_by,recorded_at)
    VALUES (${lotId},${basis},${canonicalJson({
      policy: HISTORICAL_COST_EVIDENCE_ORDER_POLICY,
      sources: candidates,
      unallocatedQuantity: onHandQuantity,
      ...(unresolved === null ? {} : { unresolvedQuantity: unresolved.unresolvedQuantity }),
    })}::jsonb,${actor},${now})`);
  await mapHistoricalReturnIntervals(tx, lotId, actor, now);
  return basis;
}

export async function readUnresolvedCostQuantities(
  tx: CostEvidenceTransaction, lotId: number,
): Promise<Array<{ allocationId: number; intervals: CostQuantityInterval[]; snapshot: HistoricalCostQuantitySnapshot }>> {
  const rows = await readAllocations(tx, lotId);
  return rows.filter(row => row.source_evidence.sourceKind === "unresolved_historical_quantity").flatMap(row => {
    const snapshot = historicalCostQuantitySnapshotSchema.safeParse(row.source_evidence.snapshot);
    if (!snapshot.success || row.source_evidence.policy !== "retain_unresolved_quantity_v1"
      || row.direction !== 1 || snapshot.data.unresolvedQuantity !== row.quantity) {
      throw new CostEvidenceError("COST_UNRESOLVED_QUANTITY_INVALID", "Unresolved cost quantity has invalid retained evidence.", { lotId });
    }
    const reversed = rows.filter(other => other.direction === -1 && other.reverses_allocation_id === row.id).flatMap(other => other.intervals);
    const intervals = subtractCostQuantityIntervals(row.intervals, reversed, snapshot.data.originalQuantity);
    const remaining = intervals.reduce((sum, interval) => sum + interval.quantity, 0);
    return remaining === 0 ? [] : [{ allocationId: row.id, intervals, snapshot: {
      ...snapshot.data,
      recordedOutflowQuantity: snapshot.data.recordedOutflowQuantity + snapshot.data.unresolvedQuantity - remaining,
      unresolvedQuantity: remaining,
    } }];
  });
}

/** Move only previously unassigned FINANCIAL custody into an approved historical
 * operation. Append reversals and replacement allocations; never alter a stock
 * balance, existing order allocation, or the original unresolved evidence. The
 * procurement approval owns the operation's physical evidence and audit. */
export async function restoreHistoricalCostAllocation(
  tx: CostEvidenceTransaction, lotId: number, quantity: number,
  operationKey: string, evidence: Record<string, unknown>, actor: string, now: Date,
): Promise<number> {
  costInteger(quantity, "historical operation quantity", 1);
  auditIdentity(actor, now);
  await lockInventoryCostGraph(tx);
  const selected = await tx.execute(sql`SELECT * FROM inventory.inventory_lots WHERE id=${lotId} FOR UPDATE`);
  const lot = selected.rows[0];
  if (!lot) throw new CostEvidenceError("COST_LOT_MISSING", "The historical source lot no longer exists.");
  const key = `historical_link_allocation:${lotId}:${operationKey}`;
  const replay = await tx.execute(sql`SELECT * FROM inventory.lot_cost_quantity_allocations WHERE allocation_key=${key}`);
  if (replay.rows[0]) {
    const row = parseAllocationRows(replay.rows, lotId)[0];
    if (row.inventory_lot_id !== lotId || Number(replay.rows[0].inventory_lot_id) !== lotId || row.quantity !== quantity
      || row.direction !== 1 || canonicalJson(row.source_evidence) !== canonicalJson(evidence)) {
      throw new CostEvidenceError("COST_ALLOCATION_REPLAY_CONFLICT", "This historical operation already owns different cost evidence.");
    }
    return row.id;
  }
  await ensureLotCostQuantityBasis(tx, lot, actor, now, { retainUnresolvedQuantity: true, verifyOnHand: true });
  const unresolved = await readUnresolvedCostQuantities(tx, lotId);
  const available = unresolved.reduce((sum, row) => sum + BigInt(row.snapshot.unresolvedQuantity), BigInt(0));
  if (available < BigInt(quantity)) throw new CostEvidenceError("COST_LINK_ALREADY_ASSIGNED", "The proposed operation would reuse costs already assigned to stock or orders.", { lotId });
  let needed = quantity;
  const intervals: CostQuantityInterval[] = [];
  for (const row of unresolved) {
    const amount = Math.min(needed, row.snapshot.unresolvedQuantity);
    if (amount === 0) continue;
    // Retain the same exact financial intervals, including sub-cent remainders.
    const restored = await reverseLotQuantityCost(tx, row.allocationId, amount, actor, now, `${key}:release:${row.allocationId}`);
    intervals.push(...restored.intervals);
    needed -= amount;
  }
  return insertAllocation(tx, { lotId, key, direction: 1, quantity, intervals, evidence, actor, now });
}

/** Historical returns retain their recorded sold-row identity and quantity.
 * Allocate only from those immutable records; never infer a return from SKU.
 */
async function mapHistoricalReturnIntervals(
  tx: CostEvidenceTransaction,
  lotId: number,
  actor: string,
  now: Date,
): Promise<void> {
  const missing =
    await tx.execute(sql`SELECT edge.id FROM inventory.lot_cost_contributions edge
    LEFT JOIN inventory.lot_cost_contribution_allocations mapping ON mapping.contribution_id=edge.id
    WHERE edge.source_lot_id=${lotId} AND edge.operation_kind='return' AND mapping.contribution_id IS NULL`);
  if (missing.rows.length === 0) return;
  const table = await tx.execute(
    sql`SELECT to_regclass('inventory.return_cost_allocations') IS NOT NULL AS present`,
  );
  if (!table.rows[0]?.present)
    throw new CostEvidenceError(
      "COST_RETURN_SOURCE_MISSING",
      "Historical return has no recorded sold-row allocation.",
      { lotId },
    );
  const records =
    await tx.execute(sql`SELECT returned.returned_lot_id,returned.source_order_item_cost_id,returned.quantity,
      cost.cost_quantity_allocation_id,edge.id AS contribution_id,edge.source_qty,mapping.allocation_id
    FROM inventory.return_cost_allocations returned JOIN oms.order_item_costs cost ON cost.id=returned.source_order_item_cost_id
    JOIN inventory.lot_cost_contributions edge ON edge.output_lot_id=returned.returned_lot_id AND edge.source_lot_id=cost.inventory_lot_id AND edge.operation_kind='return'
    LEFT JOIN inventory.lot_cost_contribution_allocations mapping ON mapping.contribution_id=edge.id
    WHERE cost.inventory_lot_id=${lotId} ORDER BY returned.recorded_at,returned.returned_lot_id,edge.id`);
  const offsets = new Map<number, number>();
  const found = new Set<number>();
  for (const row of records.rows) {
    const contributionId = costInteger(
      row.contribution_id,
      "contributionId",
      1,
    );
    found.add(contributionId);
    const costId = costInteger(
      row.source_order_item_cost_id,
      "sourceCostId",
      1,
    );
    const quantity = costInteger(row.quantity, "return.quantity", 1);
    if (quantity !== costInteger(row.source_qty, "return.sourceQty", 1))
      throw new CostEvidenceError(
        "COST_RETURN_QUANTITY_CONFLICT",
        "Return contribution and sold allocation quantities differ.",
        { lotId },
      );
    const offset = offsets.get(costId) ?? 0;
    const sourceId = costInteger(
      row.cost_quantity_allocation_id,
      "sourceAllocationId",
      1,
    );
    const intervals = sliceCostQuantityIntervals(
      await remainingCostAllocationIntervals(tx, sourceId),
      offset,
      quantity,
    );
    if (row.allocation_id == null) {
      const reference = await referenceLotQuantityCost(
        tx,
        sourceId,
        intervals,
        actor,
        now,
        `historical_return:${contributionId}`,
      );
      await linkLotCostContribution(
        tx,
        contributionId,
        reference.id!,
        actor,
        now,
      );
    }
    offsets.set(costId, offset + quantity);
  }
  if (missing.rows.some((row) => !found.has(Number(row.id))))
    throw new CostEvidenceError(
      "COST_RETURN_SOURCE_MISSING",
      "Historical return contribution has no matching sold-row allocation.",
      { lotId },
    );
}

export async function allocateLotQuantityCost(
  tx: CostEvidenceTransaction,
  lotId: number,
  quantity: number,
  actor: string,
  now: Date,
  evidence: Record<string, unknown> = {},
  key: string | null = null,
): Promise<LotQuantityCostAllocation> {
  costInteger(quantity, "allocatedQuantity", 1);
  await lockInventoryCostGraph(tx);
  const result = await tx.execute(
    sql`SELECT * FROM inventory.inventory_lots WHERE id=${lotId} FOR UPDATE`,
  );
  const lot = result.rows[0];
  if (!lot)
    throw new CostEvidenceError(
      "COST_LOT_MISSING",
      "Cost quantity source lot does not exist.",
      { lotId },
    );
  if (Number(lot.qty_received ?? 0) === 0 && lot.cost_basis_qty == null) {
    // Existing uniform-price compatibility remains usable for physical work.
    // It does not create an invented original quantity or an exact-cost basis.
    const unit = normalizeLotCosts(lot);
    const qty = BigInt(quantity);
    return {
      id: null,
      intervals: [],
      costs: {
        poMills: unit.poMills * qty,
        packagingMills: unit.packagingMills * qty,
        landedMills: unit.landedMills * qty,
        totalMills: unit.totalMills * qty,
      },
    };
  }
  const basis = await ensureLotCostQuantityBasis(tx, lot, actor, now);
  if (key !== null) {
    const replay = await tx.execute(
      sql`SELECT id,quantity,intervals,direction,inventory_lot_id FROM inventory.lot_cost_quantity_allocations WHERE allocation_key=${key}`,
    );
    if (replay.rows[0]) {
      const row = replay.rows[0];
      if (
        Number(row.quantity) !== quantity ||
        Number(row.inventory_lot_id) !== lotId ||
        Number(row.direction) !== 1
      )
        throw new CostEvidenceError(
          "COST_ALLOCATION_REPLAY_CONFLICT",
          "Cost allocation key belongs to a different quantity or lot.",
        );
      const intervals = intervalsSchema.parse(row.intervals);
      return {
        id: costInteger(row.id, "allocation.id", 1),
        intervals,
        costs: lotCostsForIntervals(lot, intervals),
      };
    }
  }
  const occupied = occupiedCostQuantityIntervals(
    await readAllocations(tx, lotId),
    basis,
  );
  const intervals = takeCostQuantityIntervals(basis, occupied, quantity);
  const id = await insertAllocation(tx, {
    lotId,
    key,
    direction: 1,
    quantity,
    intervals,
    evidence,
    actor,
    now,
  });
  return { id, intervals, costs: lotCostsForIntervals(lot, intervals) };
}

export async function readLotCostAllocation(
  tx: CostEvidenceTransaction,
  id: number,
): Promise<AllocationRow> {
  const selected = await tx.execute(
    sql`SELECT inventory_lot_id FROM inventory.lot_cost_quantity_allocations WHERE id=${id}`,
  );
  if (!selected.rows[0])
    throw new CostEvidenceError(
      "COST_ALLOCATION_SOURCE_MISSING",
      "Original cost allocation is missing.",
      { id },
    );
  const rows = await readAllocations(
    tx,
    costInteger(selected.rows[0].inventory_lot_id, "lotId", 1),
  );
  return rows.find((row) => row.id === id)!;
}

export async function remainingCostAllocationIntervals(
  tx: CostEvidenceTransaction,
  id: number,
): Promise<CostQuantityInterval[]> {
  const source = await readLotCostAllocation(tx, id);
  if (source.direction === -1)
    throw new CostEvidenceError(
      "COST_ALLOCATION_SOURCE_INVALID",
      "A negative allocation cannot own returned inventory.",
    );
  const rootId =
    source.direction === 0
      ? costInteger(
          source.source_evidence.sourceAllocationId,
          "sourceAllocationId",
          1,
        )
      : source.id;
  const rows = await readAllocations(tx, source.inventory_lot_id);
  const lot = await tx.execute(
    sql`SELECT qty_received FROM inventory.inventory_lots WHERE id=${source.inventory_lot_id}`,
  );
  const basis = costInteger(lot.rows[0]?.qty_received, "lot.qtyReceived", 1);
  const removed = rows
    .filter(
      (row) => row.direction === -1 && row.reverses_allocation_id === rootId,
    )
    .flatMap((row) => row.intervals);
  return subtractCostQuantityIntervals(
    source.intervals,
    intersectCostQuantityIntervals(source.intervals, removed),
    basis,
  );
}

export async function reverseLotQuantityCost(
  tx: CostEvidenceTransaction,
  originalId: number,
  quantity: number,
  actor: string,
  now: Date,
  key: string | null = null,
): Promise<LotQuantityCostAllocation> {
  costInteger(quantity, "reversal.quantity", 1);
  auditIdentity(actor, now);
  await lockInventoryCostGraph(tx);
  const requested = await readLotCostAllocation(tx, originalId);
  let original = requested;
  if (original.direction === 0)
    original = await readLotCostAllocation(
      tx,
      costInteger(
        original.source_evidence.sourceAllocationId,
        "sourceAllocationId",
        1,
      ),
    );
  if (original.direction !== 1)
    throw new CostEvidenceError(
      "COST_REVERSAL_SOURCE_INVALID",
      "Cost reversal requires its original positive allocation.",
    );
  const lotResult = await tx.execute(
    sql`SELECT * FROM inventory.inventory_lots WHERE id=${original.inventory_lot_id} FOR UPDATE`,
  );
  const lot = lotResult.rows[0];
  const basis = lotCostTotals(lot).basisQuantity;
  if (key !== null) {
    const replay = await tx.execute(
      sql`SELECT id,quantity,intervals,reverses_allocation_id FROM inventory.lot_cost_quantity_allocations WHERE allocation_key=${key}`,
    );
    if (replay.rows[0]) {
      const row = replay.rows[0];
      if (
        Number(row.quantity) !== quantity ||
        Number(row.reverses_allocation_id) !== original.id
      )
        throw new CostEvidenceError(
          "COST_ALLOCATION_REPLAY_CONFLICT",
          "Cost reversal key belongs to another allocation.",
        );
      const intervals = intervalsSchema.parse(row.intervals);
      return {
        id: costInteger(row.id, "allocation.id", 1),
        intervals,
        costs: lotCostsForIntervals(lot, intervals),
      };
    }
  }
  const remaining = await remainingCostAllocationIntervals(tx, requested.id);
  const count = remaining.reduce((sum, interval) => sum + interval.quantity, 0);
  const intervals = sliceCostQuantityIntervals(
    remaining,
    count - quantity,
    quantity,
  );
  const id = await insertAllocation(tx, {
    lotId: original.inventory_lot_id,
    key,
    direction: -1,
    quantity,
    intervals,
    reversesId: original.id,
    evidence: { sourceAllocationId: original.id },
    actor,
    now,
  });
  return { id, intervals, costs: lotCostsForIntervals(lot, intervals) };
}

export async function referenceLotQuantityCost(
  tx: CostEvidenceTransaction,
  sourceAllocationId: number,
  intervals: CostQuantityInterval[],
  actor: string,
  now: Date,
  key: string | null = null,
): Promise<LotQuantityCostAllocation> {
  await lockInventoryCostGraph(tx);
  auditIdentity(actor, now);
  const source = await readLotCostAllocation(tx, sourceAllocationId);
  if (source.direction === -1)
    throw new CostEvidenceError(
      "COST_ALLOCATION_SOURCE_INVALID",
      "A reversal cannot own a positive cost reference.",
    );
  const lotResult = await tx.execute(
    sql`SELECT * FROM inventory.inventory_lots WHERE id=${source.inventory_lot_id} FOR UPDATE`,
  );
  const lot = lotResult.rows[0];
  const basis = lotCostTotals(lot).basisQuantity;
  subtractCostQuantityIntervals(source.intervals, intervals, basis);
  const quantity = intervals.reduce(
    (sum, interval) => sum + interval.quantity,
    0,
  );
  const rootId =
    source.direction === 0
      ? costInteger(
          source.source_evidence.sourceAllocationId,
          "sourceAllocationId",
          1,
        )
      : source.id;
  const normalized = [...intervals].sort(
    (left, right) => left.start - right.start,
  );
  if (key !== null) {
    const replay = await tx.execute(
      sql`SELECT * FROM inventory.lot_cost_quantity_allocations WHERE allocation_key=${key}`,
    );
    if (replay.rows[0]) {
      const previous = parseAllocationRows(
        replay.rows,
        source.inventory_lot_id,
      )[0];
      if (
        Number(replay.rows[0].inventory_lot_id) !== source.inventory_lot_id ||
        previous.direction !== 0 ||
        previous.quantity !== quantity ||
        Number(previous.source_evidence.sourceAllocationId) !== rootId ||
        canonicalJson(previous.intervals) !== canonicalJson(normalized)
      ) {
        throw new CostEvidenceError(
          "COST_ALLOCATION_REPLAY_CONFLICT",
          "Cost reference key belongs to different source intervals.",
        );
      }
      return {
        id: previous.id,
        intervals: previous.intervals,
        costs: lotCostsForIntervals(lot, previous.intervals),
      };
    }
  }
  const id = await insertAllocation(tx, {
    lotId: source.inventory_lot_id,
    key,
    direction: 0,
    quantity,
    intervals: normalized,
    evidence: { sourceAllocationId: rootId },
    actor,
    now,
  });
  return { id, intervals, costs: lotCostsForIntervals(lot, intervals) };
}

export async function mergeLotQuantityCostReferences(
  tx: CostEvidenceTransaction,
  sourceIds: number[],
  actor: string,
  now: Date,
  key: string | null = null,
): Promise<LotQuantityCostAllocation> {
  auditIdentity(actor, now);
  await lockInventoryCostGraph(tx);
  if (sourceIds.length === 1) {
    const source = await readLotCostAllocation(tx, sourceIds[0]);
    const lot = await tx.execute(
      sql`SELECT * FROM inventory.inventory_lots WHERE id=${source.inventory_lot_id} FOR UPDATE`,
    );
    return {
      id: source.id,
      intervals: source.intervals,
      costs: lotCostsForIntervals(lot.rows[0], source.intervals),
    };
  }
  const sources: AllocationRow[] = [];
  for (const id of sourceIds) sources.push(await readLotCostAllocation(tx, id));
  if (
    sources.length === 0 ||
    sources.some(
      (source) =>
        source.inventory_lot_id !== sources[0].inventory_lot_id ||
        source.direction !== 1,
    )
  ) {
    throw new CostEvidenceError(
      "COST_MERGED_ALLOCATION_CONFLICT",
      "Merged cost references require positive allocations from one source lot.",
    );
  }
  const lotId = sources[0].inventory_lot_id;
  const lotResult = await tx.execute(
    sql`SELECT * FROM inventory.inventory_lots WHERE id=${lotId} FOR UPDATE`,
  );
  const lot = lotResult.rows[0];
  const intervals = sources
    .flatMap((source) => source.intervals)
    .sort((left, right) => left.start - right.start);
  const quantity = intervals.reduce(
    (sum, interval) => sum + interval.quantity,
    0,
  );
  const costs = lotCostsForIntervals(lot, intervals);
  if (key !== null) {
    const replay = await tx.execute(
      sql`SELECT * FROM inventory.lot_cost_quantity_allocations WHERE allocation_key=${key}`,
    );
    if (replay.rows[0]) {
      const previous = parseAllocationRows(replay.rows, lotId)[0];
      if (
        Number(replay.rows[0].inventory_lot_id) !== lotId ||
        previous.direction !== 0 ||
        canonicalJson(previous.intervals) !== canonicalJson(intervals) ||
        canonicalJson(previous.source_evidence.sourceAllocationIds) !==
          canonicalJson(sourceIds)
      ) {
        throw new CostEvidenceError(
          "COST_ALLOCATION_REPLAY_CONFLICT",
          "Merged reference key belongs to different source allocations.",
        );
      }
      return { id: previous.id, intervals: previous.intervals, costs };
    }
  }
  const id = await insertAllocation(tx, {
    lotId,
    key,
    direction: 0,
    quantity,
    intervals,
    evidence: { sourceAllocationIds: sourceIds },
    actor,
    now,
  });
  return { id, intervals, costs };
}

export async function linkLotCostContribution(
  tx: CostEvidenceTransaction,
  contributionId: number,
  allocationId: number,
  actor: string,
  now: Date,
): Promise<void> {
  auditIdentity(actor, now);
  await tx.execute(sql`INSERT INTO inventory.lot_cost_contribution_allocations(contribution_id,allocation_id,recorded_by,recorded_at)
    VALUES (${contributionId},${allocationId},${actor},${now}) ON CONFLICT (contribution_id) DO NOTHING`);
  const recorded = await tx.execute(
    sql`SELECT allocation_id FROM inventory.lot_cost_contribution_allocations WHERE contribution_id=${contributionId}`,
  );
  if (Number(recorded.rows[0]?.allocation_id) !== allocationId)
    throw new CostEvidenceError(
      "COST_CONTRIBUTION_ALLOCATION_CONFLICT",
      "Contribution already has different cost quantity custody.",
    );
}

export async function unallocatedLotCostIntervals(
  tx: CostEvidenceTransaction,
  lot: LotCostRecord & { id: unknown },
): Promise<CostQuantityInterval[]> {
  const basis = lotCostTotals(lot).basisQuantity;
  const occupied = occupiedCostQuantityIntervals(
    await readAllocations(tx, costInteger(lot.id, "lotId", 1)),
    basis,
  );
  const occupiedCount = occupied.reduce(
    (sum, interval) => sum + interval.quantity,
    0,
  );
  return basis === occupiedCount
    ? []
    : takeCostQuantityIntervals(basis, occupied, basis - occupiedCount);
}

/** Read-only preview evidence for an exact physical command. Unlike
 * ensureLotCostQuantityBasis this never imports historical custody. */
export async function readLotCostQuantityState(
  tx: CostEvidenceTransaction,
  lot: LotCostRecord & { id: unknown; qty_picked?: unknown; qty_packed?: unknown },
) {
  const lotId = costInteger(lot.id, "lotId", 1);
  const basisRows = (await tx.execute(sql`SELECT quantity,source_evidence FROM inventory.lot_cost_quantity_bases
    WHERE inventory_lot_id=${lotId}`)).rows;
  if (basisRows.length > 1) throw new CostEvidenceError("COST_QUANTITY_BASIS_CONFLICT", "A lot has ambiguous original cost quantity.");
  let basisQuantity = basisRows[0] ? costInteger(basisRows[0].quantity, "basisQuantity", 1) : null;
  const allocations = await readAllocations(tx, lotId);
  const basis = lotCostTotals(lot).basisQuantity;
  const occupied = occupiedCostQuantityIntervals(allocations, basis);
  const occupiedQuantity = occupied.reduce((sum, interval) => sum + interval.quantity, 0);
  // A newly created exact transfer lot has not needed a consumption basis yet.
  // Its entire original quantity can be previewed without importing history
  // only when no physical or financial outflow has ever been recorded.
  let freshUnconsumed = false;
  if (basisQuantity === null && allocations.length === 0 && hasExactLotCostTotals(lot)
    && costInteger(lot.qty_on_hand, "lot.onHand") === basis
    && costInteger(lot.qty_picked ?? 0, "lot.picked") === 0
    && costInteger(lot.qty_packed ?? 0, "lot.packed") === 0) {
    const history = (await tx.execute(sql`SELECT
      EXISTS(SELECT 1 FROM oms.order_item_costs WHERE inventory_lot_id=${lotId}) AS has_cogs,
      EXISTS(SELECT 1 FROM inventory.lot_cost_contributions WHERE source_lot_id=${lotId}) AS has_outflow,
      EXISTS(SELECT 1 FROM inventory.inventory_transactions WHERE inventory_lot_id=${lotId}
        AND variant_qty_delta<0 AND voided_at IS NULL) AS has_physical_outflow`)).rows[0];
    freshUnconsumed = history?.has_cogs === false && history?.has_outflow === false && history?.has_physical_outflow === false;
    if (freshUnconsumed) basisQuantity = basis;
  }
  return {
    basisQuantity,
    freshUnconsumed,
    basisEvidence: basisRows[0]?.source_evidence ?? null,
    allocations,
    freeIntervals: occupiedQuantity === basis ? [] : takeCostQuantityIntervals(basis, occupied, basis - occupiedQuantity),
    hasUnresolvedQuantity: (await readUnresolvedCostQuantities(tx, lotId)).length > 0,
  };
}

/** Batch counterpart for valuation. The caller supplies one coherent snapshot;
 * no financial custody is created by a read. Bound the complete allocation set
 * rather than silently reporting a truncated inventory value.
 */
export async function readUnallocatedLotCosts(
  tx: Pick<CostEvidenceTransaction, "execute">,
  lots: readonly (LotCostRecord & { id: unknown })[],
): Promise<Map<number, { quantity: number; costs: LotCosts }>> {
  const exact = lots.filter(hasExactLotCostTotals);
  const result = new Map<number, { quantity: number; costs: LotCosts }>();
  if (exact.length === 0) return result;
  const ids = exact.map((lot) => costInteger(lot.id, "lotId", 1));
  const maximumRecords = 1_000_000;
  const rows =
    await tx.execute(sql`SELECT id,inventory_lot_id,direction,quantity,intervals,reverses_allocation_id,source_evidence
    FROM inventory.lot_cost_quantity_allocations WHERE inventory_lot_id IN
      (SELECT value::integer FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
    ORDER BY inventory_lot_id,id LIMIT ${maximumRecords + 1}`);
  if (rows.rows.length > maximumRecords)
    throw new CostEvidenceError(
      "COST_VALUATION_ALLOCATION_LIMIT",
      "Inventory valuation needs a bounded complete allocation read.",
    );
  const byLot = new Map<number, Record<string, unknown>[]>();
  for (const row of rows.rows) {
    const id = costInteger(row.inventory_lot_id, "lotId", 1);
    const group = byLot.get(id) ?? [];
    group.push(row);
    byLot.set(id, group);
  }
  for (const lot of exact) {
    const id = costInteger(lot.id, "lotId", 1);
    const basis = lotCostTotals(lot).basisQuantity;
    const occupied = occupiedCostQuantityIntervals(
      parseAllocationRows(byLot.get(id) ?? [], id),
      basis,
    );
    const quantity =
      basis - occupied.reduce((sum, interval) => sum + interval.quantity, 0);
    const intervals =
      quantity === 0
        ? []
        : takeCostQuantityIntervals(basis, occupied, quantity);
    result.set(id, { quantity, costs: lotCostsForIntervals(lot, intervals) });
  }
  return result;
}
