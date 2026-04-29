import "dotenv/config";
import { db } from "./server/db";
import { sql } from "drizzle-orm";

async function run() {
  const qTrim = "toploader";
  const like = "%toploader%";
  const prefix = "toploader%";
  
  const inCatalogRows = await db.execute(sql`
      SELECT * FROM (
        SELECT DISTINCT ON (p.id)
          vp.id              AS vendor_product_id,
          vp.product_id      AS product_id,
          vp.product_variant_id AS product_variant_id,
          COALESCE(pv.sku, p.sku) AS sku,
          p.name             AS product_name,
          NULL               AS variant_name,
          vp.vendor_sku      AS vendor_sku,
          vp.vendor_product_name AS vendor_product_name,
          vp.unit_cost_cents AS unit_cost_cents,
          vp.unit_cost_mills AS unit_cost_mills,
          vp.pack_size       AS pack_size,
          vp.moq             AS moq,
          vp.lead_time_days  AS lead_time_days,
          vp.is_preferred    AS is_preferred,
          (
            CASE
              WHEN LOWER(COALESCE(pv.sku, p.sku, '')) LIKE ${prefix} THEN 0
              WHEN LOWER(COALESCE(pv.sku, p.sku, '')) LIKE ${like} THEN 1
              WHEN LOWER(COALESCE(vp.vendor_sku, '')) LIKE ${like} THEN 1
              WHEN LOWER(p.name) LIKE ${like} THEN 2
              WHEN LOWER(COALESCE(pv.name, '')) LIKE ${like} THEN 2
              WHEN LOWER(COALESCE(vp.vendor_product_name, '')) LIKE ${like} THEN 2
              ELSE 3
            END
          ) AS rank
        FROM procurement.vendor_products vp
        JOIN catalog.products p ON p.id = vp.product_id
        LEFT JOIN catalog.product_variants pv ON pv.id = vp.product_variant_id
        WHERE vp.vendor_id = 1
          AND vp.is_active = 1
          AND (
            LOWER(COALESCE(p.sku, '')) LIKE ${like}
            OR LOWER(COALESCE(pv.sku, '')) LIKE ${like}
            OR LOWER(COALESCE(vp.vendor_sku, '')) LIKE ${like}
            OR LOWER(p.name) LIKE ${like}
            OR LOWER(COALESCE(pv.name, '')) LIKE ${like}
            OR LOWER(COALESCE(vp.vendor_product_name, '')) LIKE ${like}
          )
        ORDER BY p.id, vp.is_preferred DESC NULLS LAST, vp.id ASC
      ) AS distinct_products
      ORDER BY rank ASC, is_preferred DESC NULLS LAST, product_name ASC
      LIMIT 10
  `);
  console.log(inCatalogRows.rows);
  process.exit(0);
}
run().catch(console.error);
