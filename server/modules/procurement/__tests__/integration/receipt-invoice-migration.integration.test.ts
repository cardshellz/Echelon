import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { validatePostgresTestEnvironment } from "../../../../../scripts/ci/postgres-tests";

const enabled =
  !!process.env.ECHELON_TEST_DATABASE_URL &&
  process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
(enabled ? describe : describe.skip).sequential(
  "actual receipt invoice allocation migration",
  () => {
    let pool: pg.Pool;
    const owned: string[] = [];
    beforeAll(async () => {
      validatePostgresTestEnvironment(process.env);
      pool = new pg.Pool({
        connectionString: process.env.ECHELON_TEST_DATABASE_URL,
        ssl: false,
      });
      for (const name of ["identity", "procurement"]) {
        await pool.query(`CREATE SCHEMA ${name}`);
        owned.push(name);
      }
      await pool.query(`CREATE TABLE identity.users(id varchar PRIMARY KEY);INSERT INTO identity.users VALUES('admin');
      CREATE TABLE procurement.purchase_order_lines(id integer PRIMARY KEY,line_total_cents bigint NOT NULL);
      CREATE TABLE procurement.receiving_lines(id integer PRIMARY KEY);
      CREATE TABLE procurement.vendor_invoice_lines(id integer PRIMARY KEY);
      INSERT INTO procurement.purchase_order_lines VALUES(1,12345);INSERT INTO procurement.receiving_lines VALUES(1),(2);
      INSERT INTO procurement.vendor_invoice_lines VALUES(1),(2)`);
      await pool.query(
        readFileSync(
          resolve(
            process.cwd(),
            "migrations/900000047000019790001_receipt_invoice_cost_allocations.sql",
          ),
          "utf8",
        ),
      );
    });
    afterAll(async () => {
      try {
        for (const name of [...owned].reverse())
          await pool.query(`DROP SCHEMA ${name} CASCADE`);
      } finally {
        await pool?.end();
      }
    });
    const insert = (
      receipt: number,
      invoice: number,
      start: number,
      invoiceStart: number,
      pieces: number,
      actor = "admin",
    ) =>
      pool.query(
        `INSERT INTO procurement.receipt_invoice_cost_allocations
    (purchase_order_line_id,receiving_line_id,invoice_line_id,receipt_start_piece,invoice_start_piece,pieces,approved_by,approved_at)
    VALUES(1,$1,$2,$3,$4,$5,$6,'2026-11-01T12:00:00Z')`,
        [receipt, invoice, start, invoiceStart, pieces, actor],
      );
    it("preserves historical money and does not infer receipt assignments", async () => {
      expect(
        (await pool.query("SELECT * FROM procurement.purchase_order_lines"))
          .rows,
      ).toEqual([
        { id: 1, line_total_cents: "12345", receipt_costing_enabled: 0 },
      ]);
      expect(
        (
          await pool.query(
            "SELECT * FROM procurement.receipt_invoice_cost_allocations",
          )
        ).rows,
      ).toEqual([]);
    });
    it("requires valid receipt, invoice and approving identities", async () => {
      await expect(insert(999, 1, 0, 0, 1)).rejects.toMatchObject({
        code: "23503",
      });
      await expect(insert(1, 999, 0, 0, 1)).rejects.toMatchObject({
        code: "23503",
      });
      await expect(insert(1, 1, 0, 0, 1, "missing")).rejects.toMatchObject({
        code: "23503",
      });
    });
    it("rejects zero, negative and unsafe interval quantities", async () => {
      await expect(insert(1, 1, 0, 0, 0)).rejects.toMatchObject({
        code: "23514",
      });
      await expect(insert(1, 1, -1, 0, 1)).rejects.toMatchObject({
        code: "23514",
      });
      await expect(
        insert(1, 1, Number.MAX_SAFE_INTEGER, 0, 1),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          "UPDATE procurement.purchase_order_lines SET receipt_costing_enabled=2 WHERE id=1",
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
    it("enforces nonoverlap independently on both receipt and invoice intervals", async () => {
      await insert(1, 1, 0, 0, 10);
      await expect(insert(1, 2, 5, 0, 5)).rejects.toMatchObject({
        code: "23P01",
      });
      await expect(insert(2, 1, 0, 5, 5)).rejects.toMatchObject({
        code: "23P01",
      });
      await insert(1, 1, 10, 10, 10);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM procurement.receipt_invoice_cost_allocations",
          )
        ).rows[0].count,
      ).toBe(2);
    });
  },
);
