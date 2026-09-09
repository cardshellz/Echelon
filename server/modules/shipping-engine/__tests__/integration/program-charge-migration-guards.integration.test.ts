import { describe, it, expect } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SHARED_SHIPPING_LEGACY_FIXTURE_SQL } from "./fixtures/shared-shipping-legacy";

const enabled =
  Boolean(process.env.ECHELON_TEST_DATABASE_URL) &&
  process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
describe.skipIf(!enabled)("program charge migration preflight", () => {
  it.each([
    {
      name: "legacy assignment shared with retail",
      code: "SHIPPING_PROGRAM_SHARED_WITH_RETAIL",
      extra:
        "INSERT INTO shipping.rate_book_assignments(rate_book_id,is_active,pricing_channel,rate_purpose) VALUES(1,true,'shopify','customer_checkout')",
    },
    {
      name: "canonical routing shared with retail",
      code: "SHIPPING_PROGRAM_SHARED_WITH_RETAIL",
      extra:
        "INSERT INTO shipping.channel_policies VALUES(1,'active','customer_checkout'); INSERT INTO shipping.channel_policy_routes VALUES(1,1)",
    },
    {
      name: "overlapping legacy charges",
      code: "SHIPPING_CHARGES_OVERLAP",
      extra:
        "INSERT INTO dropship.dropship_shipping_markup_config VALUES(2,200,0,NULL,NULL,true,'2026-02-01',NULL)",
    },
  ])("rejects $name and rolls back all changes", async ({ code, extra }) => {
    const name = `shipping_guard_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({
      connectionString: process.env.ECHELON_TEST_DATABASE_URL,
    });
    let database: Pool | undefined;
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      const url = new URL(process.env.ECHELON_TEST_DATABASE_URL!);
      url.pathname = `/${name}`;
      database = new Pool({ connectionString: url.toString() });
      await database.query(SHARED_SHIPPING_LEGACY_FIXTURE_SQL);
      await database.query(extra);
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        await expect(
          client.query(
            readFileSync(
              resolve(
                "migrations/238_shared_packaging_and_program_charges.sql",
              ),
              "utf8",
            ),
          ),
        ).rejects.toThrow(code);
        await client.query("ROLLBACK");
        expect(
          (
            await client.query(
              "SELECT column_name FROM information_schema.columns WHERE table_schema='shipping' AND table_name='rate_books' AND column_name='charge_policy_required'",
            )
          ).rows,
        ).toEqual([]);
        expect(
          (
            await client.query(
              "SELECT to_regclass('shipping.box_suites') AS relation",
            )
          ).rows[0].relation,
        ).toBeNull();
        expect(
          (await client.query("SELECT code FROM shipping.box_catalog")).rows,
        ).toEqual([{ code: "SHARED" }]);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    } finally {
      await database?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
    }
  });
});
