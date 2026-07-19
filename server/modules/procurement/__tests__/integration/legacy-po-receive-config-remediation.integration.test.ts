import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "dotenv";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyLegacyPoReceiveConfigRemediation,
  previewLegacyPoReceiveConfigRemediation,
} from "../../legacy-po-receive-config-remediation.service";

config({ path: resolve(process.cwd(), ".env.test") });

const TEST_DB_URL = process.env.ECHELON_TEST_DATABASE_URL;
const DISPOSABLE_DB = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeWithDisposableDb = TEST_DB_URL && DISPOSABLE_DB ? describe : describe.skip;
const identityGuardSql = readFileSync(
  resolve(process.cwd(), "migrations", "146_po_vendor_product_identity_guard.sql"),
  "utf8",
);

function sslConfig(connectionString: string) {
  return /localhost|127\.0\.0\.1/.test(connectionString)
    ? false
    : { rejectUnauthorized: false };
}

describeWithDisposableDb.sequential(
  "legacy PO receive configuration PostgreSQL guarantees",
  () => {
    let pool: pg.Pool;

    beforeAll(async () => {
      const productionUrls = [
        process.env.DATABASE_URL,
          ].filter((value): value is string => Boolean(value));
      if (productionUrls.includes(TEST_DB_URL!)) {
        throw new Error(
          "ECHELON_TEST_DATABASE_URL must not equal DATABASE_URL",
        );
      }
      if (!DISPOSABLE_DB) {
        throw new Error(
          "Legacy PO receive configuration tests require an explicitly disposable database",
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
          id INTEGER PRIMARY KEY
        );

        CREATE TABLE catalog.products (
          id INTEGER PRIMARY KEY
        );

        CREATE TABLE catalog.product_variants (
          id INTEGER PRIMARY KEY,
          product_id INTEGER NOT NULL REFERENCES catalog.products(id),
          sku TEXT,
          name TEXT NOT NULL,
          units_per_variant INTEGER NOT NULL,
          is_active BOOLEAN NOT NULL
        );

        CREATE TABLE procurement.vendor_products (
          id INTEGER PRIMARY KEY,
          vendor_id INTEGER NOT NULL REFERENCES procurement.vendors(id),
          product_id INTEGER NOT NULL REFERENCES catalog.products(id),
          product_variant_id INTEGER REFERENCES catalog.product_variants(id),
          is_active INTEGER NOT NULL
        );

        CREATE TABLE procurement.purchase_orders (
          id INTEGER PRIMARY KEY,
          po_number TEXT NOT NULL,
          vendor_id INTEGER NOT NULL REFERENCES procurement.vendors(id),
          status TEXT NOT NULL
        );

        CREATE TABLE procurement.purchase_order_lines (
          id INTEGER PRIMARY KEY,
          purchase_order_id INTEGER NOT NULL
            REFERENCES procurement.purchase_orders(id),
          line_type TEXT NOT NULL,
          status TEXT NOT NULL,
          product_id INTEGER REFERENCES catalog.products(id),
          product_variant_id INTEGER REFERENCES catalog.product_variants(id),
          expected_receive_variant_id INTEGER REFERENCES catalog.product_variants(id),
          expected_receive_units_per_variant INTEGER NOT NULL DEFAULT 1,
          vendor_product_id INTEGER REFERENCES procurement.vendor_products(id),
          sku TEXT,
          order_qty INTEGER NOT NULL,
          received_qty INTEGER NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp()
        );

        CREATE TABLE procurement.receiving_lines (
          id INTEGER PRIMARY KEY,
          purchase_order_line_id INTEGER NOT NULL
            REFERENCES procurement.purchase_order_lines(id),
          product_variant_id INTEGER REFERENCES catalog.product_variants(id),
          expected_qty INTEGER NOT NULL,
          received_qty INTEGER NOT NULL,
          status TEXT NOT NULL
        );

        CREATE TABLE procurement.po_receipts (
          id INTEGER PRIMARY KEY,
          purchase_order_line_id INTEGER NOT NULL
            REFERENCES procurement.purchase_order_lines(id),
          receiving_line_id INTEGER NOT NULL
            REFERENCES procurement.receiving_lines(id),
          qty_received INTEGER NOT NULL
        );

        INSERT INTO public.users (id) VALUES ('operator-1');
        INSERT INTO procurement.vendors (id) VALUES (1), (2);
        INSERT INTO catalog.products (id) VALUES (1), (33);
        INSERT INTO catalog.product_variants (
          id, product_id, sku, name, units_per_variant, is_active
        ) VALUES
          (2, 1, 'PRODUCT-1-C1000', 'Case of 1000', 1000, TRUE),
          (472, 1, 'PRODUCT-1-C500', 'Case of 500', 500, TRUE),
          (67, 33, 'PRODUCT-33-C700', 'Case of 700', 700, FALSE),
          (438, 33, 'PRODUCT-33-C750', 'Case of 750', 750, TRUE);
        INSERT INTO procurement.vendor_products (
          id, vendor_id, product_id, product_variant_id, is_active
        ) VALUES
          (27, 2, 1, 2, 1),
          (1, 1, 33, 67, 1),
          (67, 1, 33, 438, 1);
        INSERT INTO procurement.purchase_orders (
          id, po_number, vendor_id, status
        ) VALUES
          (117, 'PO-117', 2, 'partially_received'),
          (118, 'PO-118', 1, 'received');
        INSERT INTO procurement.purchase_order_lines (
          id, purchase_order_id, line_type, status, product_id,
          product_variant_id, expected_receive_variant_id,
          expected_receive_units_per_variant, vendor_product_id,
          sku, order_qty, received_qty
        ) VALUES
          (
            176, 117, 'product', 'partially_received', 1,
            NULL, NULL, 1, 27,
            'PRODUCT-1', 25000, 5000
          ),
          (
            178, 118, 'product', 'received', 33,
            NULL, NULL, 1, 1,
            'PRODUCT-33', 324000, 324000
          );
        INSERT INTO procurement.receiving_lines (
          id, purchase_order_line_id, product_variant_id,
          expected_qty, received_qty, status
        ) VALUES
          (2650, 176, 472, 10, 10, 'complete'),
          (2666, 178, 438, 432, 432, 'complete');
        INSERT INTO procurement.po_receipts (
          id, purchase_order_line_id, receiving_line_id, qty_received
        ) VALUES
          (180, 176, 2650, 5000),
          (196, 178, 2666, 324000);
      `);

      await pool.query(identityGuardSql);
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

    it("stamps expected configuration, performs one exact relink, and audits atomically", async () => {
      const preview = await previewLegacyPoReceiveConfigRemediation(pool);
      expect(preview.summary).toEqual({
        candidateLines: 2,
        safeLines: 2,
        linesToStamp: 1,
        linesToRelink: 1,
        blockedLines: 0,
        linesWithoutReceivingEvidence: 0,
        receiptVariantDeviations: 2,
      });
      expect(preview.targets).toEqual([
        expect.objectContaining({
          lineId: 176,
          action: "stamp_linked_mapping_configuration",
          targetVendorProductId: 27,
          targetReceiveVariantId: 2,
          targetReceiveUnitsPerVariant: 1000,
        }),
        expect.objectContaining({
          lineId: 178,
          action: "relink_to_corroborated_received_configuration",
          targetVendorProductId: 67,
          targetReceiveVariantId: 438,
          targetReceiveUnitsPerVariant: 750,
        }),
      ]);

      const applied = await applyLegacyPoReceiveConfigRemediation({
        pool,
        actorId: "operator-1",
        expectedPreviewHash: preview.previewHash,
      });
      expect(applied).toMatchObject({
        stampedLines: 1,
        relinkedLines: 1,
        auditedLines: 2,
      });

      const stored = await pool.query<{
        id: number;
        vendor_product_id: number;
        expected_receive_variant_id: number;
        expected_receive_units_per_variant: number;
      }>(`
        SELECT id, vendor_product_id, expected_receive_variant_id,
               expected_receive_units_per_variant
        FROM procurement.purchase_order_lines
        WHERE id IN (176, 178)
        ORDER BY id
      `);
      expect(stored.rows).toEqual([
        {
          id: 176,
          vendor_product_id: 27,
          expected_receive_variant_id: 2,
          expected_receive_units_per_variant: 1000,
        },
        {
          id: 178,
          vendor_product_id: 67,
          expected_receive_variant_id: 438,
          expected_receive_units_per_variant: 750,
        },
      ]);

      const audits = await pool.query<{
        action: string;
        target: string;
      }>(`
        SELECT action, target
        FROM public.audit_events
        ORDER BY target
      `);
      expect(audits.rows).toEqual([
        {
          action: "purchase_order_line.receive_configuration_recovered",
          target: "purchase_order_line:176",
        },
        {
          action: "purchase_order_line.receive_configuration_recovered",
          target: "purchase_order_line:178",
        },
      ]);

      const after = await previewLegacyPoReceiveConfigRemediation(pool);
      expect(after.summary.candidateLines).toBe(0);
    });
  },
);
