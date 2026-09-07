import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { PgHistoricalShipStationContentsCorrectionRepository } from "../../historical-shipstation-contents-correction.repository";
import { planHistoricalShipStationContentsCorrection } from "../../historical-shipstation-contents-correction.domain";
import { HISTORICAL_SHIPSTATION_CONTENTS_REVIEW_RULE } from "../../historical-shipstation-contents-review.service";
import { shipmentQuantityEvidenceFixtureSql } from "../fixtures/shipment-quantity-evidence.fixture";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const fixtureTables = [
  "wms.reconciliation_exceptions", "wms.outbound_shipment_items", "catalog.product_variants",
  "inventory.inventory_transactions", "inventory.availability_claim_dispatch_receipts",
  "inventory.availability_claim_pick_movements", "inventory.availability_claim_dispatch_movements",
] as const;

const fixtureSql = `
  CREATE SCHEMA inventory;
  CREATE SCHEMA wms;
  CREATE SCHEMA catalog;
  CREATE TABLE wms.reconciliation_exceptions (id bigint PRIMARY KEY, rule text NOT NULL, status text NOT NULL, details jsonb NOT NULL);
  CREATE TABLE wms.outbound_shipment_items (
    id integer PRIMARY KEY, shipment_id integer NOT NULL, order_item_id integer,
    product_variant_id integer, qty integer NOT NULL, from_location_id integer
  );
  CREATE TABLE catalog.product_variants (
    id integer PRIMARY KEY, sku text, name text NOT NULL, is_active boolean NOT NULL,
    requires_shipping boolean NOT NULL, track_inventory boolean NOT NULL
  );
  CREATE TABLE inventory.inventory_transactions (
    id integer PRIMARY KEY, order_id integer, shipment_id integer, shipment_item_id integer,
    order_item_id integer, product_variant_id integer, from_location_id integer,
    transaction_type text NOT NULL, variant_qty_delta integer NOT NULL, reserved_qty_delta integer,
    reference_type text, source_state text, target_state text, voided_at timestamptz
  );
  ${shipmentQuantityEvidenceFixtureSql}
`;

function reviewDetails(extraLine = false) {
  return {
    contract: "historical_shipstation_contents_review_v1",
    decision: "provider_confirmed_pending_inventory_correction",
    inventoryCorrectionRequired: true,
    decisionPreviewEvidenceHash: HASH_A,
    decisionHash: HASH_B,
    providerEvidence: { evidenceHash: HASH_B },
    wmsEvidence: {
      kind: "available",
      lines: [
        { wmsShipmentItemId: 701, sku: "SKU-A", quantity: 2 },
        ...(extraLine ? [{ wmsShipmentItemId: 702, sku: "SKU-A", quantity: 3 }] : []),
      ],
    },
  };
}

function request(quantity = 2) {
  return {
    exceptionId: "91", reviewPreviewEvidenceHash: HASH_A,
    orderNumber: "1001", trackingNumber: "1Z-CORRECTION",
    providerLines: [{ sku: "SKU-A", quantity }],
  };
}

/** Real repository and planner with reduced query tables, never an ambient application pool. */
describeDatabase.sequential("historical shipment correction quantity PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase | undefined;
  let pool: Pool;

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, fixtureSql);
    pool = database.pool;
  });
  afterAll(async () => { await database?.close(); });

  beforeEach(async () => {
    await pool.query(`TRUNCATE ${fixtureTables.join(", ")}`);
    await pool.query(`
      INSERT INTO catalog.product_variants VALUES (101,'SKU-A','Regular A',true,true,true);
      INSERT INTO wms.outbound_shipment_items VALUES (701,801,901,101,2,301);
      INSERT INTO inventory.inventory_transactions VALUES
        (401,1001,801,701,901,101,301,'ship',0,0,'availability_claim_dispatch','picked','shipped',NULL);
      INSERT INTO inventory.availability_claim_dispatch_receipts VALUES
        (501,401,601,602,2,1001,901,801,701,101,301,1,NULL,NULL);
      INSERT INTO inventory.availability_claim_pick_movements VALUES (701,601,602,2,'pick');
      INSERT INTO inventory.availability_claim_dispatch_movements VALUES (801,501,701,601,602,2);
    `);
    await pool.query(
      "INSERT INTO wms.reconciliation_exceptions VALUES (91,$1,'acknowledged',$2::jsonb)",
      [HISTORICAL_SHIPSTATION_CONTENTS_REVIEW_RULE, JSON.stringify(reviewDetails())],
    );
  });

  async function snapshot() {
    const result: Record<string, unknown> = {};
    for (const table of fixtureTables) {
      result[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    }
    return result;
  }

  function reader() {
    const trace: string[] = [];
    let connections = 0;
    let releases = 0;
    const scopedPool = {
      connect: async () => {
        connections += 1;
        const client = await pool.connect();
        return {
          query: async (text: string, values: unknown[] = []) => {
            trace.push(text);
            const result = await client.query(text, values);
            if (text.startsWith("BEGIN")) {
              const settings = await client.query("SELECT current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation");
              expect(settings.rows).toEqual([{ read_only: "on", isolation: "repeatable read" }]);
            }
            return result;
          },
          release: () => { releases += 1; client.release(); },
        } as unknown as PoolClient;
      },
    } as Pool;
    return {
      repository: new PgHistoricalShipStationContentsCorrectionRepository(scopedPool),
      trace,
      assertClosed: (ending: "COMMIT" | "ROLLBACK") => {
        expect(connections).toBe(1);
        expect(releases).toBe(1);
        expect(trace.at(-1)).toBe(ending);
        expect(trace.join("\n")).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
      },
    };
  }

  it("reads exact canonical units through the compiled native-pg query without changing any evidence", async () => {
    const before = await snapshot();
    const connected = reader();
    const facts = await connected.repository.loadFacts(request());
    expect(facts.wmsLines[0].inventoryShipTransactions[0]).toMatchObject({ quantity: 2, quantitySource: "canonical_dispatch_receipt" });
    expect(planHistoricalShipStationContentsCorrection(facts)).toMatchObject({
      evidenceComplete: true, inventoryPostingRequired: false, packageLineChangeRequired: false,
      lines: [{ recordedInventoryQuantity: 2, inventoryAction: "none", restorations: [], packageLineAdjustments: [] }],
    });
    connected.assertClosed("COMMIT");
    expect(await snapshot()).toEqual(before);
  });

  it("preserves legacy negative-delta quantity behavior through the same real query", async () => {
    await pool.query("DELETE FROM inventory.availability_claim_dispatch_movements; DELETE FROM inventory.availability_claim_dispatch_receipts");
    await pool.query("UPDATE inventory.inventory_transactions SET variant_qty_delta=-2, reference_type=NULL WHERE id=401");
    const before = await snapshot();
    const connected = reader();
    const facts = await connected.repository.loadFacts(request(1));
    expect(facts.wmsLines[0].inventoryShipTransactions[0]).toMatchObject({ quantity: 2, quantitySource: "legacy_on_hand_delta" });
    expect(planHistoricalShipStationContentsCorrection(facts).lines[0]).toMatchObject({
      recordedInventoryQuantity: 2, inventoryAction: "restore", restorations: [{ quantity: 1 }],
    });
    connected.assertClosed("COMMIT");
    expect(await snapshot()).toEqual(before);
  });

  it("reports canonical mismatch without producing a package edit or restoration proposal", async () => {
    const before = await snapshot();
    const connected = reader();
    const plan = planHistoricalShipStationContentsCorrection(await connected.repository.loadFacts(request(1)));
    expect(plan.lines[0]).toMatchObject({
      recordedInventoryQuantity: 2, inventoryQuantityDelta: -1, inventoryAction: "unknown",
      restorations: [], packageLineAdjustments: [],
    });
    expect(plan.blockers.map((entry) => entry.code)).toEqual(["canonical_claim_correction_required"]);
    connected.assertClosed("COMMIT");
    expect(await snapshot()).toEqual(before);
  });

  it("binds multiple shipment IDs as one array and refuses mixed-lineage fake restoration", async () => {
    await pool.query(`
      INSERT INTO wms.outbound_shipment_items VALUES (702,802,902,101,3,302);
      INSERT INTO inventory.inventory_transactions VALUES (402,1001,802,702,902,101,302,'ship',-3,0,NULL,NULL,NULL,NULL);
    `);
    await pool.query("UPDATE wms.reconciliation_exceptions SET details=$1::jsonb WHERE id=91", [JSON.stringify(reviewDetails(true))]);
    const before = await snapshot();
    const connected = reader();
    const plan = planHistoricalShipStationContentsCorrection(await connected.repository.loadFacts(request(2)));
    expect(plan.lines[0]).toMatchObject({
      recordedInventoryQuantity: 5, wmsQuantity: 5, inventoryQuantityDelta: -3,
      inventoryAction: "unknown", restorations: [], packageLineAdjustments: [],
    });
    expect(plan.blockers.map((entry) => entry.code)).toEqual(["canonical_claim_correction_required"]);
    connected.assertClosed("COMMIT");
    expect(await snapshot()).toEqual(before);
  });

  it("rolls back and releases the read transaction when canonical movement evidence is corrupt", async () => {
    await pool.query("UPDATE inventory.availability_claim_dispatch_movements SET quantity=1 WHERE id=801");
    const before = await snapshot();
    const connected = reader();
    await expect(connected.repository.loadFacts(request())).rejects.toMatchObject({
      code: "INVALID_DATABASE_EVIDENCE", context: { evidenceCode: "SHIPMENT_QUANTITY_EVIDENCE_INVALID" },
    });
    connected.assertClosed("ROLLBACK");
    expect(connected.trace).not.toContain("COMMIT");
    expect(await snapshot()).toEqual(before);
  });

  it("excludes voided malformed shipment rows from active correction evidence", async () => {
    await pool.query(`INSERT INTO inventory.inventory_transactions VALUES
      (402,1001,801,701,901,101,301,'ship',0,0,'availability_claim_dispatch','picked','shipped','2026-09-07T00:00:00Z')`);
    const before = await snapshot();
    const connected = reader();
    const facts = await connected.repository.loadFacts(request());
    expect(facts.wmsLines[0].inventoryShipTransactions).toHaveLength(1);
    expect(facts.wmsLines[0].inventoryShipTransactions[0]).toMatchObject({ inventoryTransactionId: 401, quantity: 2 });
    connected.assertClosed("COMMIT");
    expect(await snapshot()).toEqual(before);
  });
});
