import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "dotenv";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyHistoricalPoSupplierEvidence,
  previewHistoricalPoSupplierEvidence,
} from "../../historical-po-supplier-evidence-backfill.service";

config({ path: resolve(process.cwd(), ".env.test") });

const TEST_DB_URL = process.env.ECHELON_TEST_DATABASE_URL;
const DISPOSABLE_DB = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeWithDisposableDb = TEST_DB_URL && DISPOSABLE_DB ? describe : describe.skip;
const migrationSql = readFileSync(
  resolve(process.cwd(), "migrations/144_vendor_product_last_cost_mills.sql"),
  "utf8",
);

function sslConfig(connectionString: string) {
  return /localhost|127\.0\.0\.1/.test(connectionString)
    ? false
    : { rejectUnauthorized: false };
}

async function expectDatabaseError(
  operation: () => Promise<unknown>,
  code: string,
): Promise<void> {
  let error: unknown;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeTruthy();
  expect((error as { code?: string }).code).toBe(code);
}

describeWithDisposableDb.sequential(
  "historical PO supplier evidence PostgreSQL guarantees",
  () => {
    let pool: pg.Pool;

    beforeAll(async () => {
      const productionUrls = [
        process.env.DATABASE_URL,
        process.env.EXTERNAL_DATABASE_URL,
      ].filter((value): value is string => Boolean(value));
      if (productionUrls.includes(TEST_DB_URL!)) {
        throw new Error(
          "ECHELON_TEST_DATABASE_URL must not equal DATABASE_URL or EXTERNAL_DATABASE_URL",
        );
      }
      if (!DISPOSABLE_DB) {
        throw new Error(
          "Historical supplier evidence integration tests require an explicitly disposable database",
        );
      }

      pool = new pg.Pool({
        connectionString: TEST_DB_URL,
        max: 4,
        ssl: sslConfig(TEST_DB_URL!),
      });
      await pool.query(`
        CREATE SCHEMA catalog;
        CREATE SCHEMA procurement;

        CREATE TABLE public.users (
          id VARCHAR PRIMARY KEY
        );

        CREATE TABLE public.audit_events (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          level TEXT NOT NULL,
          actor TEXT NOT NULL,
          action TEXT NOT NULL,
          target TEXT NOT NULL,
          changes JSONB NOT NULL,
          context JSONB NOT NULL
        );

        CREATE TABLE procurement.vendors (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          active INTEGER NOT NULL
        );

        CREATE TABLE catalog.products (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          sku TEXT,
          is_active BOOLEAN NOT NULL
        );

        CREATE TABLE catalog.product_variants (
          id INTEGER PRIMARY KEY,
          product_id INTEGER NOT NULL REFERENCES catalog.products(id),
          sku TEXT,
          is_active BOOLEAN NOT NULL
        );

        CREATE TABLE procurement.vendor_products (
          id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          vendor_id INTEGER NOT NULL REFERENCES procurement.vendors(id),
          product_id INTEGER NOT NULL REFERENCES catalog.products(id),
          product_variant_id INTEGER REFERENCES catalog.product_variants(id),
          unit_cost_cents BIGINT NOT NULL DEFAULT 0,
          unit_cost_mills BIGINT,
          pricing_basis TEXT NOT NULL DEFAULT 'legacy_unknown',
          purchase_uom TEXT,
          quoted_unit_cost_mills BIGINT,
          pieces_per_purchase_uom INTEGER,
          quote_reference TEXT,
          quoted_at TIMESTAMPTZ,
          quote_valid_until DATE,
          pack_size INTEGER NOT NULL DEFAULT 1,
          moq INTEGER NOT NULL DEFAULT 1,
          lead_time_days INTEGER,
          is_preferred INTEGER NOT NULL DEFAULT 0,
          is_active INTEGER NOT NULL DEFAULT 1,
          last_purchased_at TIMESTAMPTZ,
          last_cost_cents BIGINT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp()
        );

        CREATE UNIQUE INDEX vendor_products_identity_uidx
          ON procurement.vendor_products (
            vendor_id,
            product_id,
            (COALESCE(product_variant_id, 0))
          );

        CREATE TABLE procurement.purchase_orders (
          id INTEGER PRIMARY KEY,
          po_number TEXT NOT NULL,
          vendor_id INTEGER NOT NULL REFERENCES procurement.vendors(id),
          status TEXT NOT NULL,
          closed_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp()
        );

        CREATE TABLE procurement.purchase_order_lines (
          id INTEGER PRIMARY KEY,
          purchase_order_id INTEGER NOT NULL
            REFERENCES procurement.purchase_orders(id),
          line_type TEXT NOT NULL,
          status TEXT NOT NULL,
          product_id INTEGER NOT NULL REFERENCES catalog.products(id),
          product_variant_id INTEGER REFERENCES catalog.product_variants(id),
          expected_receive_variant_id INTEGER REFERENCES catalog.product_variants(id),
          unit_cost_cents BIGINT NOT NULL,
          unit_cost_mills BIGINT,
          received_qty INTEGER NOT NULL,
          fully_received_date TIMESTAMPTZ,
          last_received_at TIMESTAMPTZ,
          vendor_product_id INTEGER REFERENCES procurement.vendor_products(id),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp()
        );
      `);

      await pool.query(`
        INSERT INTO public.users (id) VALUES ('backfill-user');
        INSERT INTO procurement.vendors (id, name, active)
        VALUES (2, 'Supplier', 1);
        INSERT INTO catalog.products (id, name, sku, is_active)
        VALUES
          (36, 'Sub-cent sleeves', 'SLV', TRUE),
          (37, 'Zero placeholder', 'ZERO', TRUE),
          (38, 'Existing evidence', 'EXISTING', TRUE);
        INSERT INTO catalog.product_variants (id, product_id, sku, is_active)
        VALUES (73, 36, 'SLV-C10000', TRUE);
        INSERT INTO procurement.vendor_products (
          vendor_id, product_id, last_cost_cents
        ) VALUES (2, 38, 125);
      `);
      await pool.query(migrationSql);
      await pool.query(`
        INSERT INTO procurement.purchase_orders (
          id, po_number, vendor_id, status, closed_at
        ) VALUES (
          115, 'PO-115', 2, 'received', '2026-07-08 14:11:25.932'
        );
        INSERT INTO procurement.purchase_order_lines (
          id, purchase_order_id, line_type, status,
          product_id, product_variant_id, expected_receive_variant_id,
          unit_cost_cents, unit_cost_mills, received_qty,
          fully_received_date
        ) VALUES
          (
            167, 115, 'product', 'received',
            36, 73, 73,
            0, 48, 300000,
            '2026-07-08 14:11:25.932'
          ),
          (
            168, 115, 'product', 'received',
            37, NULL, NULL,
            0, 0, 10,
            '2026-07-08 14:11:25.932'
          );
      `);
    });

    afterAll(async () => {
      if (pool) {
        await pool.query("DROP SCHEMA procurement CASCADE");
        await pool.query("DROP SCHEMA catalog CASCADE");
        await pool.query("DROP TABLE public.audit_events");
        await pool.query("DROP TABLE public.users");
        await pool.end();
      }
    });

    it("backfills existing cents and enforces the exact mills mirror", async () => {
      const existing = await pool.query<{
        last_cost_mills: string;
        last_cost_cents: string;
      }>(`
        SELECT last_cost_mills::text, last_cost_cents::text
        FROM procurement.vendor_products
        WHERE product_id = 38
      `);
      expect(existing.rows[0]).toEqual({
        last_cost_mills: "12500",
        last_cost_cents: "125",
      });

      await expectDatabaseError(
        () => pool.query(`
          UPDATE procurement.vendor_products
          SET last_cost_mills = 48, last_cost_cents = 1
          WHERE product_id = 38
        `),
        "23514",
      );
    });

    it("uses completed PO evidence atomically and excludes zero-cost placeholders", async () => {
      const preview = await previewHistoricalPoSupplierEvidence(pool);
      expect(preview.summary).toEqual({
        targetCount: 1,
        mappingsToCreate: 1,
        mappingsToUpdate: 0,
        mappingsUnchanged: 0,
        linesToLink: 1,
        conflictingLines: 0,
        nonpositiveCostLinesExcluded: 1,
      });
      expect(preview.targets[0]).toMatchObject({
        productId: 36,
        productVariantId: 73,
        sourceCompletedAt: "2026-07-08T14:11:25.932000",
        lastCostMills: 48,
        lastCostCents: 0,
        linesToLink: [167],
      });

      const applied = await applyHistoricalPoSupplierEvidence({
        pool,
        actorId: "backfill-user",
        expectedPreviewHash: preview.previewHash,
      });
      expect(applied).toMatchObject({
        createdMappings: 1,
        updatedMappings: 0,
        linkedLines: 1,
        conflictingLinesSkipped: 0,
        nonpositiveCostLinesExcluded: 1,
        unchangedTargets: 0,
      });

      const stored = await pool.query<{
        id: number;
        pricing_basis: string;
        is_preferred: number;
        last_cost_mills: string;
        last_cost_cents: string;
        last_purchased_at: string;
        line_vendor_product_id: number;
        audit_action: string;
      }>(`
        SELECT
          vp.id,
          vp.pricing_basis,
          vp.is_preferred,
          vp.last_cost_mills::text,
          vp.last_cost_cents::text,
          to_char(
            vp.last_purchased_at,
            'YYYY-MM-DD"T"HH24:MI:SS.US'
          ) AS last_purchased_at,
          pol.vendor_product_id AS line_vendor_product_id,
          audit.action AS audit_action
        FROM procurement.vendor_products vp
        JOIN procurement.purchase_order_lines pol ON pol.id = 167
        JOIN public.audit_events audit
          ON audit.target = 'vendor_product:' || vp.id::text
        WHERE vp.product_id = 36
      `);
      expect(stored.rows[0]).toEqual({
        id: expect.any(Number),
        pricing_basis: "legacy_unknown",
        is_preferred: 0,
        last_cost_mills: "48",
        last_cost_cents: "0",
        last_purchased_at: "2026-07-08T14:11:25.932000",
        line_vendor_product_id: expect.any(Number),
        audit_action: "vendor_catalog.historical_purchase_mapping_created",
      });

      const after = await previewHistoricalPoSupplierEvidence(pool);
      expect(after.summary).toMatchObject({
        targetCount: 1,
        mappingsToCreate: 0,
        mappingsToUpdate: 0,
        mappingsUnchanged: 1,
        linesToLink: 0,
        nonpositiveCostLinesExcluded: 1,
      });
    });
  },
);
