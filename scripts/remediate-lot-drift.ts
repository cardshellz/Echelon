/**
 * Reconcile FIFO lot projections to the operational inventory-level spine.
 *
 * This command never changes inventory.inventory_levels and never posts a
 * physical inventory movement. It repairs only the lot projection used for
 * FIFO/COGS selection: on-hand, reserved, and picked totals per variant/location.
 *
 * Safety:
 *   - dry-run by default;
 *   - apply requires actor, reason, approval reference, and the exact dry-run hash;
 *   - takes a transaction-scoped advisory lock and blocks concurrent level/lot DML;
 *   - re-reads and fingerprints the locked state before writing;
 *   - writes all changes atomically and rolls back unless global parity is zero;
 *   - leaves a durable run/actor/reason note on every changed lot.
 *
 * Usage:
 *   npm run wms:remediate-lot-drift -- --limit=30
 *   npm run wms:remediate-lot-drift -- --json
 *   npm run wms:remediate-lot-drift -- --apply \
 *     --expected-hash=<dry-run hash> --actor=<operator> \
 *     --reason=<reason> --approval=<change/approval reference>
 */

import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

interface CliOptions {
  apply: boolean;
  json: boolean;
  limit: number;
  expectedHash: string | null;
  actor: string | null;
  reason: string | null;
  approval: string | null;
}

interface LevelRow {
  id: number;
  productVariantId: number;
  warehouseLocationId: number;
  qtyOnHand: number;
  qtyReserved: number;
  qtyPicked: number;
}

interface LotRow {
  id: number;
  lotNumber: string;
  productVariantId: number;
  warehouseLocationId: number;
  qtyOnHand: number;
  qtyReserved: number;
  qtyPicked: number;
  qtyReceived: number;
  qtyConsumed: number;
  receivedAt: string;
  status: string;
  notes: string | null;
}

interface CellState {
  key: string;
  productVariantId: number;
  warehouseLocationId: number;
  levelId: number | null;
  levelOnHand: number;
  levelReserved: number;
  levelPicked: number;
  lotOnHand: number;
  lotReserved: number;
  lotPicked: number;
  negativeLotBuckets: number;
  costCents: number;
  lots: LotRow[];
}

export interface Snapshot {
  levels: LevelRow[];
  lots: LotRow[];
  costs: Map<number, number>;
}

interface RepairStats {
  runId: string;
  cells: number;
  negativeLotsNormalized: number;
  topupLotsCreated: number;
  topupUnits: number;
  lotsDepleted: number;
  depletedUnits: number;
  bucketLotsUpdated: number;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    json: false,
    limit: 30,
    expectedHash: null,
    actor: null,
    reason: null,
    approval: null,
  };

  for (const arg of argv.slice(2)) {
    if (arg === "--apply") options.apply = true;
    else if (arg === "--json") options.json = true;
    else if (arg.startsWith("--limit=")) options.limit = Math.max(0, Number(arg.slice(8)) || 0);
    else if (arg.startsWith("--expected-hash=")) options.expectedHash = arg.slice(16).trim() || null;
    else if (arg.startsWith("--actor=")) options.actor = arg.slice(8).trim() || null;
    else if (arg.startsWith("--reason=")) options.reason = arg.slice(9).trim() || null;
    else if (arg.startsWith("--approval=")) options.approval = arg.slice(11).trim() || null;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.apply) {
    const missing = [
      ["--expected-hash", options.expectedHash],
      ["--actor", options.actor],
      ["--reason", options.reason],
      ["--approval", options.approval],
    ].filter(([, value]) => !value).map(([flag]) => flag);
    if (missing.length > 0) {
      throw new Error(`Apply requires ${missing.join(", ")}`);
    }
    if (!/^[0-9a-f]{64}$/.test(options.expectedHash!)) {
      throw new Error("--expected-hash must be a 64-character lowercase SHA-256 hash");
    }
  }

  return options;
}

function cellKey(productVariantId: number, warehouseLocationId: number): string {
  return `${productVariantId}:${warehouseLocationId}`;
}

export async function loadSnapshot(client: pg.Pool | pg.PoolClient): Promise<Snapshot> {
  // A PoolClient represents one PostgreSQL connection and cannot execute
  // concurrent queries safely. Keep these reads sequential because apply mode
  // uses a locked transaction on a single client.
  const levelsResult = await client.query(`
      SELECT id,
             product_variant_id AS "productVariantId",
             warehouse_location_id AS "warehouseLocationId",
             variant_qty AS "qtyOnHand",
             reserved_qty AS "qtyReserved",
             picked_qty AS "qtyPicked"
      FROM inventory.inventory_levels
      ORDER BY product_variant_id, warehouse_location_id
    `);
  const lotsResult = await client.query(`
      SELECT id,
             lot_number AS "lotNumber",
             product_variant_id AS "productVariantId",
             warehouse_location_id AS "warehouseLocationId",
             qty_on_hand AS "qtyOnHand",
             qty_reserved AS "qtyReserved",
             qty_picked AS "qtyPicked",
             COALESCE(qty_received, 0) AS "qtyReceived",
             COALESCE(qty_consumed, 0) AS "qtyConsumed",
             received_at AS "receivedAt",
             status,
             notes
      FROM inventory.inventory_lots
      ORDER BY product_variant_id, warehouse_location_id, received_at, id
    `);
  const costsResult = await client.query(`
      SELECT id,
             COALESCE(NULLIF(avg_cost_cents, 0), NULLIF(last_cost_cents, 0), 0)::bigint AS "costCents"
      FROM catalog.product_variants
    `);

  const levels = levelsResult.rows.map((row) => ({
    id: Number(row.id),
    productVariantId: Number(row.productVariantId),
    warehouseLocationId: Number(row.warehouseLocationId),
    qtyOnHand: Number(row.qtyOnHand),
    qtyReserved: Number(row.qtyReserved),
    qtyPicked: Number(row.qtyPicked),
  }));
  const lots = lotsResult.rows.map((row) => ({
    id: Number(row.id),
    lotNumber: String(row.lotNumber),
    productVariantId: Number(row.productVariantId),
    warehouseLocationId: Number(row.warehouseLocationId),
    qtyOnHand: Number(row.qtyOnHand),
    qtyReserved: Number(row.qtyReserved),
    qtyPicked: Number(row.qtyPicked),
    qtyReceived: Number(row.qtyReceived),
    qtyConsumed: Number(row.qtyConsumed),
    receivedAt: new Date(row.receivedAt).toISOString(),
    status: String(row.status ?? "active"),
    notes: row.notes == null ? null : String(row.notes),
  }));
  const costs = new Map<number, number>(
    costsResult.rows.map((row) => [Number(row.id), Number(row.costCents)]),
  );

  return { levels, lots, costs };
}

export function buildCells(snapshot: Snapshot): CellState[] {
  const cells = new Map<string, CellState>();

  for (const level of snapshot.levels) {
    const key = cellKey(level.productVariantId, level.warehouseLocationId);
    cells.set(key, {
      key,
      productVariantId: level.productVariantId,
      warehouseLocationId: level.warehouseLocationId,
      levelId: level.id,
      levelOnHand: level.qtyOnHand,
      levelReserved: level.qtyReserved,
      levelPicked: level.qtyPicked,
      lotOnHand: 0,
      lotReserved: 0,
      lotPicked: 0,
      negativeLotBuckets: 0,
      costCents: snapshot.costs.get(level.productVariantId) ?? 0,
      lots: [],
    });
  }

  for (const lot of snapshot.lots) {
    const key = cellKey(lot.productVariantId, lot.warehouseLocationId);
    const cell = cells.get(key) ?? {
      key,
      productVariantId: lot.productVariantId,
      warehouseLocationId: lot.warehouseLocationId,
      levelId: null,
      levelOnHand: 0,
      levelReserved: 0,
      levelPicked: 0,
      lotOnHand: 0,
      lotReserved: 0,
      lotPicked: 0,
      negativeLotBuckets: 0,
      costCents: snapshot.costs.get(lot.productVariantId) ?? 0,
      lots: [],
    };

    // Negative lot buckets are invalid projections. The repair clamps them to
    // zero before balancing the cell, so totals here represent the safe state.
    cell.lotOnHand += Math.max(0, lot.qtyOnHand);
    cell.lotReserved += Math.max(0, lot.qtyReserved);
    cell.lotPicked += Math.max(0, lot.qtyPicked);
    cell.negativeLotBuckets += [lot.qtyOnHand, lot.qtyReserved, lot.qtyPicked]
      .filter((qty) => qty < 0).length;
    cell.lots.push(lot);
    cells.set(key, cell);
  }

  return [...cells.values()].sort((a, b) =>
    a.productVariantId - b.productVariantId ||
    a.warehouseLocationId - b.warehouseLocationId,
  );
}

export function isDrifting(cell: CellState): boolean {
  return cell.negativeLotBuckets > 0 ||
    cell.levelOnHand !== cell.lotOnHand ||
    cell.levelReserved !== cell.lotReserved ||
    cell.levelPicked !== cell.lotPicked;
}

export function validateSnapshot(snapshot: Snapshot, cells: CellState[]): void {
  const invalidMetadata = snapshot.lots.filter((lot) => lot.qtyReceived < 0 || lot.qtyConsumed < 0);
  if (invalidMetadata.length > 0) {
    throw new Error(
      `Refusing repair: ${invalidMetadata.length} lot(s) have negative received/consumed history`,
    );
  }

  const invalidLevels = cells.filter((cell) =>
    cell.levelOnHand < 0 || cell.levelReserved < 0 || cell.levelPicked < 0 ||
    cell.levelReserved > cell.levelOnHand,
  );
  if (invalidLevels.length > 0) {
    throw new Error(
      `Refusing repair: ${invalidLevels.length} inventory level cell(s) have invalid target buckets`,
    );
  }
}

export function fingerprint(cells: CellState[]): string {
  const candidates = cells.filter(isDrifting).map((cell) => ({
    productVariantId: cell.productVariantId,
    warehouseLocationId: cell.warehouseLocationId,
    level: [cell.levelId, cell.levelOnHand, cell.levelReserved, cell.levelPicked],
    lots: cell.lots.map((lot) => [
      lot.id,
      lot.qtyOnHand,
      lot.qtyReserved,
      lot.qtyPicked,
      lot.qtyReceived,
      lot.qtyConsumed,
      lot.status,
    ]),
  }));
  return createHash("sha256").update(JSON.stringify(candidates)).digest("hex");
}

export function summarize(cells: CellState[]) {
  const drift = cells.filter(isDrifting);
  return {
    candidateCells: drift.length,
    onHandDriftCells: drift.filter((cell) => cell.levelOnHand !== cell.lotOnHand).length,
    reservedDriftCells: drift.filter((cell) => cell.levelReserved !== cell.lotReserved).length,
    pickedDriftCells: drift.filter((cell) => cell.levelPicked !== cell.lotPicked).length,
    negativeLotBucketCells: drift.filter((cell) => cell.negativeLotBuckets > 0).length,
    onHandUnitsToCreate: drift.reduce(
      (sum, cell) => sum + Math.max(0, cell.levelOnHand - cell.lotOnHand),
      0,
    ),
    onHandUnitsToDeplete: drift.reduce(
      (sum, cell) => sum + Math.max(0, cell.lotOnHand - cell.levelOnHand),
      0,
    ),
    reservedAbsoluteDrift: drift.reduce(
      (sum, cell) => sum + Math.abs(cell.levelReserved - cell.lotReserved),
      0,
    ),
    pickedAbsoluteDrift: drift.reduce(
      (sum, cell) => sum + Math.abs(cell.levelPicked - cell.lotPicked),
      0,
    ),
  };
}

export const REPAIR_LOT_INSERT_SQL = `
  INSERT INTO inventory.inventory_lots (
    lot_number, product_variant_id, warehouse_location_id, received_at,
    qty_on_hand, qty_received, qty_reserved, qty_picked,
    unit_cost_cents, po_unit_cost_cents, packaging_cost_cents,
    landed_cost_cents, total_unit_cost_cents,
    unit_cost_mills, po_unit_cost_mills, packaging_cost_mills,
    landed_cost_mills, total_unit_cost_mills,
    cost_source, cost_provisional, status, notes
  ) VALUES (
    $1::text, $2::integer, $3::integer, NOW(),
    $4::integer, $4::integer, 0, 0,
    $5::integer, $5::integer, 0, 0, $5::integer,
    $6::bigint, $6::bigint, 0, 0, $6::bigint,
    'legacy', $7::integer, 'active', $8::text
  )
  RETURNING id
`;

async function insertRepairLot(
  client: pg.PoolClient,
  cell: CellState,
  qtyOnHand: number,
  runId: string,
): Promise<number> {
  const costCents = cell.costCents;
  const costMills = costCents * 100;
  const result = await client.query(REPAIR_LOT_INSERT_SQL, [
    `LOT-RECON-${runId.slice(0, 8)}-${cell.productVariantId}-${cell.warehouseLocationId}`,
    cell.productVariantId,
    cell.warehouseLocationId,
    qtyOnHand,
    costCents,
    costMills,
    costCents === 0 ? 1 : 0,
    `Lot projection reconciliation run ${runId}`,
  ]);
  return Number(result.rows[0].id);
}

async function applyRepair(
  client: pg.PoolClient,
  cellsBefore: CellState[],
  options: CliOptions,
): Promise<RepairStats> {
  const runId = randomUUID();
  const changedLotIds = new Set<number>();
  const stats: RepairStats = {
    runId,
    cells: cellsBefore.filter(isDrifting).length,
    negativeLotsNormalized: 0,
    topupLotsCreated: 0,
    topupUnits: 0,
    lotsDepleted: 0,
    depletedUnits: 0,
    bucketLotsUpdated: 0,
  };

  // First repair physical on-hand lot totals and normalize invalid negative
  // projection buckets. No inventory level or movement ledger row is changed.
  for (const cell of cellsBefore.filter(isDrifting)) {
    const lots = cell.lots.map((lot) => ({ ...lot }));
    for (const lot of lots) {
      if (lot.qtyOnHand < 0 || lot.qtyReserved < 0 || lot.qtyPicked < 0) {
        await client.query(`
          UPDATE inventory.inventory_lots
          SET qty_on_hand = GREATEST(qty_on_hand, 0),
              qty_reserved = GREATEST(qty_reserved, 0),
              qty_picked = GREATEST(qty_picked, 0)
          WHERE id = $1
        `, [lot.id]);
        lot.qtyOnHand = Math.max(0, lot.qtyOnHand);
        lot.qtyReserved = Math.max(0, lot.qtyReserved);
        lot.qtyPicked = Math.max(0, lot.qtyPicked);
        changedLotIds.add(lot.id);
        stats.negativeLotsNormalized += 1;
      }
    }

    let lotOnHand = lots.reduce((sum, lot) => sum + lot.qtyOnHand, 0);
    if (lotOnHand < cell.levelOnHand) {
      const qty = cell.levelOnHand - lotOnHand;
      const lotId = await insertRepairLot(client, cell, qty, runId);
      changedLotIds.add(lotId);
      stats.topupLotsCreated += 1;
      stats.topupUnits += qty;
      lotOnHand += qty;
    } else if (lotOnHand > cell.levelOnHand) {
      let remaining = lotOnHand - cell.levelOnHand;
      for (const lot of lots) {
        if (remaining <= 0) break;
        const take = Math.min(lot.qtyOnHand, remaining);
        if (take <= 0) continue;
        await client.query(`
          UPDATE inventory.inventory_lots
          SET qty_on_hand = qty_on_hand - $1
          WHERE id = $2
        `, [take, lot.id]);
        lot.qtyOnHand -= take;
        remaining -= take;
        changedLotIds.add(lot.id);
        stats.lotsDepleted += 1;
        stats.depletedUnits += take;
      }
      if (remaining !== 0) {
        throw new Error(`Could not deplete full on-hand drift for cell ${cell.key}`);
      }
    }

    if (lots.length === 0 && cell.levelOnHand === 0 && cell.levelPicked > 0) {
      const lotId = await insertRepairLot(client, cell, 0, runId);
      changedLotIds.add(lotId);
      stats.topupLotsCreated += 1;
    }
  }

  // Re-read after the on-hand phase so newly created lots participate in FIFO
  // reservation/picked allocation.
  const afterOnHand = await loadSnapshot(client);
  const cellsAfterOnHand = buildCells(afterOnHand);
  const bucketUpdates: Array<{
    lotId: number;
    qtyReserved: number;
    qtyPicked: number;
    status: string;
  }> = [];

  for (const cell of cellsAfterOnHand) {
    if (!isDrifting(cell)) continue;

    let reservedRemaining = cell.levelReserved;
    const reservedByLot = new Map<number, number>();
    for (const lot of cell.lots) {
      const qty = Math.min(Math.max(0, lot.qtyOnHand), reservedRemaining);
      reservedByLot.set(lot.id, qty);
      reservedRemaining -= qty;
    }
    if (reservedRemaining !== 0) {
      throw new Error(`Could not allocate reserved target for cell ${cell.key}`);
    }

    // Preserve existing FIFO picked attribution where possible. Excess picked
    // projection is trimmed newest-last; any shortfall is assigned to the oldest
    // layer, matching the service's FIFO shipment behavior.
    let pickedRemaining = cell.levelPicked;
    const pickedByLot = new Map<number, number>();
    for (const lot of cell.lots) {
      const qty = Math.min(Math.max(0, lot.qtyPicked), pickedRemaining);
      pickedByLot.set(lot.id, qty);
      pickedRemaining -= qty;
    }
    if (pickedRemaining > 0) {
      const oldest = cell.lots[0];
      if (!oldest) throw new Error(`No lot can carry picked target for cell ${cell.key}`);
      pickedByLot.set(oldest.id, (pickedByLot.get(oldest.id) ?? 0) + pickedRemaining);
      pickedRemaining = 0;
    }

    for (const lot of cell.lots) {
      const qtyReserved = reservedByLot.get(lot.id) ?? 0;
      const qtyPicked = pickedByLot.get(lot.id) ?? 0;
      const status = lot.status === "expired"
        ? "expired"
        : (lot.qtyOnHand === 0 && qtyReserved === 0 && qtyPicked === 0 ? "depleted" : "active");
      if (
        qtyReserved !== lot.qtyReserved ||
        qtyPicked !== lot.qtyPicked ||
        status !== lot.status
      ) {
        bucketUpdates.push({ lotId: lot.id, qtyReserved, qtyPicked, status });
        changedLotIds.add(lot.id);
      }
    }
  }

  if (bucketUpdates.length > 0) {
    await client.query(`
      WITH updates AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb)
          AS x("lotId" int, "qtyReserved" int, "qtyPicked" int, status text)
      )
      UPDATE inventory.inventory_lots AS lot
      SET qty_reserved = updates."qtyReserved",
          qty_picked = updates."qtyPicked",
          status = updates.status
      FROM updates
      WHERE lot.id = updates."lotId"
    `, [JSON.stringify(bucketUpdates)]);
    stats.bucketLotsUpdated = bucketUpdates.length;
  }

  if (changedLotIds.size > 0) {
    const auditNote = [
      `lot-projection-reconciliation run=${runId}`,
      `actor=${options.actor}`,
      `approval=${options.approval}`,
      `reason=${options.reason}`,
    ].join("; ");
    await client.query(`
      UPDATE inventory.inventory_lots
      SET notes = CONCAT_WS(' | ', NULLIF(notes, ''), $1)
      WHERE id = ANY($2::int[])
    `, [auditNote, [...changedLotIds]]);
  }

  return stats;
}

function printDryRun(cells: CellState[], hash: string, options: CliOptions): void {
  const summary = summarize(cells);
  const samples = cells.filter(isDrifting).slice(0, options.limit).map((cell) => ({
    productVariantId: cell.productVariantId,
    warehouseLocationId: cell.warehouseLocationId,
    level: {
      onHand: cell.levelOnHand,
      reserved: cell.levelReserved,
      picked: cell.levelPicked,
    },
    lots: {
      onHand: cell.lotOnHand,
      reserved: cell.lotReserved,
      picked: cell.lotPicked,
      negativeBuckets: cell.negativeLotBuckets,
    },
  }));

  if (options.json) {
    console.log(JSON.stringify({ mode: "dry-run", inputHash: hash, summary, samples }, null, 2));
    return;
  }

  console.log("\n=== FIFO Lot Projection Reconciliation (DRY-RUN) ===");
  console.log(`Input hash:                 ${hash}`);
  console.log(`Candidate cells:            ${summary.candidateCells}`);
  console.log(`On-hand drift cells:        ${summary.onHandDriftCells}`);
  console.log(`Reserved drift cells:       ${summary.reservedDriftCells}`);
  console.log(`Picked drift cells:         ${summary.pickedDriftCells}`);
  console.log(`Negative bucket cells:      ${summary.negativeLotBucketCells}`);
  console.log(`On-hand units to create:    ${summary.onHandUnitsToCreate}`);
  console.log(`On-hand units to deplete:   ${summary.onHandUnitsToDeplete}`);
  console.log(`Reserved absolute drift:    ${summary.reservedAbsoluteDrift}`);
  console.log(`Picked absolute drift:      ${summary.pickedAbsoluteDrift}`);
  if (samples.length > 0) {
    console.log(`\nFirst ${samples.length} candidate cell(s):`);
    console.table(samples.map((sample) => ({
      variant: sample.productVariantId,
      location: sample.warehouseLocationId,
      onHand: `${sample.lots.onHand}->${sample.level.onHand}`,
      reserved: `${sample.lots.reserved}->${sample.level.reserved}`,
      picked: `${sample.lots.picked}->${sample.level.picked}`,
      negativeBuckets: sample.lots.negativeBuckets,
    })));
  }
  console.log("\nNo rows were written. Apply requires this exact hash and explicit audit metadata.\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv);
  const connectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("EXTERNAL_DATABASE_URL (or DATABASE_URL) is not set");

  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  try {
    if (!options.apply) {
      const snapshot = await loadSnapshot(pool);
      const cells = buildCells(snapshot);
      validateSnapshot(snapshot, cells);
      printDryRun(cells, fingerprint(cells), options);
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query("SET LOCAL statement_timeout = '120s'");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('wms-lot-projection-reconciliation'))");
      await client.query(
        "LOCK TABLE inventory.inventory_levels, inventory.inventory_lots IN SHARE ROW EXCLUSIVE MODE",
      );

      const snapshot = await loadSnapshot(client);
      const cells = buildCells(snapshot);
      validateSnapshot(snapshot, cells);
      const lockedHash = fingerprint(cells);
      if (lockedHash !== options.expectedHash) {
        throw new Error(
          `Inventory changed after dry-run: expected ${options.expectedHash}, locked state is ${lockedHash}. ` +
          "No rows were written; run dry-run again.",
        );
      }

      const stats = await applyRepair(client, cells, options);
      const finalSnapshot = await loadSnapshot(client);
      const finalCells = buildCells(finalSnapshot);
      validateSnapshot(finalSnapshot, finalCells);
      const remaining = finalCells.filter(isDrifting);
      if (remaining.length > 0) {
        throw new Error(
          `Post-write verification found ${remaining.length} drifting cell(s); rolling back the entire repair`,
        );
      }

      await client.query("COMMIT");
      const result = {
        mode: "applied",
        inputHash: lockedHash,
        remainingDriftCells: 0,
        ...stats,
      };
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log("\n=== FIFO Lot Projection Reconciliation (APPLIED) ===");
        console.log(JSON.stringify(result, null, 2));
        console.log("Global on-hand/reserved/picked lot parity verified at zero.\n");
      }
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

const isMainModule = process.argv[1] != null &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  main().catch((error) => {
    console.error("Lot projection reconciliation failed:", error instanceof Error ? error.message : error);
    process.exit(2);
  });
}
