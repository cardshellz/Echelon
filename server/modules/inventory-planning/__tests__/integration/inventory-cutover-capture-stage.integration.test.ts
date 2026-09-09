import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { captureInventoryCutoverStage, InventoryCutoverCaptureError } from "../../infrastructure/inventory-cutover-capture-stage";
import { inInventoryCutoverTransaction } from "../../infrastructure/inventory-cutover-commit.repository";

vi.mock("../../../../db", () => ({ pool: {} }));

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;

/** Transaction-seam proof only: this sentinel is not inventory/authority DDL. */
const fixtureSql = `CREATE TABLE cutover_capture_atomicity_probe (id integer PRIMARY KEY, note text NOT NULL);`;

describeDatabase.sequential("cutover capture timeout PostgreSQL transaction guarantees", () => {
  let database: InventoryCutoverTestDatabase;
  let pool: Pool;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, fixtureSql);
    pool = database.pool;
  });
  beforeEach(async () => { await pool.query("TRUNCATE cutover_capture_atomicity_probe"); });
  afterAll(async () => { await database?.close(); });

  it.each(["read_only_review", "admitted_commit"] as const)(
    "rolls back a real canceled evidence read in %s, preserves its cause, and stops downstream work", async (mode) => {
      const client = await pool.connect();
      const querySpy = vi.spyOn(client, "query");
      const releaseSpy = vi.spyOn(client, "release");
      const connect = vi.fn(async () => client);
      const downstreamWrite = vi.fn(async () => {
        await client.query("INSERT INTO cutover_capture_atomicity_probe VALUES (2,'must not run')");
        return { complete: true };
      });
      try {
        const failure = await inInventoryCutoverTransaction({ connect } as unknown as Pick<Pool, "connect">, mode, async (transactionClient) => {
          expect(transactionClient).toBe(client);
          if (mode === "admitted_commit") {
            // Prove rollback protection also covers work already performed by
            // a caller before a later capture stage fails; no business rows are used.
            await transactionClient.query("INSERT INTO cutover_capture_atomicity_probe VALUES (1,'must roll back')");
          } else {
            expect((await transactionClient.query("SHOW transaction_read_only")).rows).toEqual([{ transaction_read_only: "on" }]);
          }
          // Intentional cancellation, not a performance assertion: pg_sleep
          // cannot finish its two-second operation inside a twenty-ms budget.
          await transactionClient.query("SET LOCAL statement_timeout = '20ms'");
          await captureInventoryCutoverStage("inventory_custody", async () => transactionClient.query("SELECT pg_sleep(2)"));
          return downstreamWrite();
        }).catch(error => error);

        expect(failure).toBeInstanceOf(InventoryCutoverCaptureError);
        expect(failure).toMatchObject({ stage: "inventory_custody", code: "CUTOVER_EVIDENCE_CAPTURE_TIMEOUT", status: 503,
          postgresCode: "57014", cause: { code: "57014" } });
        expect(failure.cause).toBeInstanceOf(Error);
        expect(failure).not.toHaveProperty("complete");
        expect(downstreamWrite).not.toHaveBeenCalled();
        expect(connect).toHaveBeenCalledOnce();
        const statements = querySpy.mock.calls.map(([sql]) => sql);
        expect(statements.filter(sql => sql === "SELECT pg_sleep(2)")).toHaveLength(1);
        expect(statements.at(-1)).toBe("ROLLBACK");
        expect(statements).not.toContain("COMMIT");
        if (mode === "read_only_review") expect(statements.some(sql => typeof sql === "string" && /\b(?:INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(false);
        expect(releaseSpy).toHaveBeenCalledExactlyOnceWith(false);
      } finally {
        querySpy.mockRestore();
        releaseSpy.mockRestore();
      }
      expect((await pool.query("SELECT * FROM cutover_capture_atomicity_probe")).rows).toEqual([]);
      expect((await pool.query("SELECT 1 AS healthy")).rows).toEqual([{ healthy: 1 }]);
    },
  );
});
