import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeMigrationWithRetry } from "../../../../../migrations/migration-executor";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { createPurchaseForecastBacktestingRepository } from "../../../procurement/purchase-forecast-backtesting.repository";
import { correctProduct102PurchasingIdentity } from "../../../procurement/product-102-identity-cleanup.repository";
import { correctProduct102CountIdentity } from "../../../inventory/infrastructure/product-102-count-identity.repository";
import {
  Product102CleanupService,
  product102RequestHash,
  type Product102CleanupTransactionPort,
} from "../../application/product-102-cleanup.service";
import {
  Product102CleanupRepository,
  Product102CleanupTransaction,
} from "../../infrastructure/product-102-cleanup.repository";
import {
  product102CleanupFixture,
  cleanupMigrationFile,
  cleanupTestPolicy,
  cleanupTestTime,
  insertCleanupTestForecast,
  readCleanupMigration,
} from "../fixtures/product-102-cleanup.fixture";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
if (
  url &&
  disposable &&
  !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)
) {
  throw new Error(
    "Product cleanup tests require a local disposable PostgreSQL server.",
  );
}
const dbDescribe = url && disposable ? describe : describe.skip;

dbDescribe.sequential(
  "product 102 cleanup / real migration and command",
  () => {
    let database: InventoryCutoverTestDatabase;
    let repository: Product102CleanupRepository;
    let service: Product102CleanupService;
    const roles: string[] = [];

    beforeEach(async () => {
      database = await createInventoryCutoverTestDatabase(
        url,
        disposable,
        product102CleanupFixture,
      );
      repository = new Product102CleanupRepository(database.pool);
      service = new Product102CleanupService(repository, () => cleanupTestTime);
    });
    afterEach(async () => {
      try {
        for (const role of roles.splice(0)) {
          await database.pool.query(`DROP OWNED BY "${role}"`);
          await database.pool.query(`DROP ROLE "${role}"`);
        }
      } finally {
        await database?.close();
      }
    });

    async function migrate(): Promise<void> {
      const sql = readCleanupMigration(cleanupMigrationFile);
      const client = await database.pool.connect();
      try {
        await executeMigrationWithRetry({
          client,
          sql,
          file: cleanupMigrationFile,
          contentHash: createHash("sha256").update(sql).digest("hex"),
          options: {
            maxAttempts: 1,
            lockTimeoutMs: 2000,
            retryBaseDelayMs: 0,
            retryMaxDelayMs: 0,
          },
        });
      } finally {
        client.release();
      }
    }
    async function command() {
      const preview = await service.preview();
      expect(preview.blockers).toEqual([]);
      expect(preview.status).toBe("ready");
      if (!preview.executableHash)
        throw new Error("Expected an executable preview.");
      return {
        expectedHash: preview.executableHash,
        actorId: "owner-test",
        approval:
          "Owner approved exact identity cleanup; leave all quantities and receiving sizes unchanged.",
      };
    }
    async function capture(): Promise<string> {
      return repository.transaction(
        true,
        async (tx) => (await tx.capture()).data,
      );
    }
    async function assertNotApplied(): Promise<void> {
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS n FROM catalog.product_cleanup_receipts",
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS n FROM public.audit_events",
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS n FROM procurement.po_events",
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await database.pool.query(
            "SELECT product_id FROM procurement.purchase_order_lines WHERE id=221",
          )
        ).rows[0].product_id,
      ).toBe(102);
    }
    async function createRole(): Promise<string> {
      const name = (
        await database.pool.query(
          "SELECT 'cleanup_' || substr(current_database(),19) AS name",
        )
      ).rows[0].name as string;
      if (!/^cleanup_[a-f0-9]{32}$/.test(name))
        throw new Error("Unsafe disposable role name.");
      await database.pool.query(`CREATE ROLE "${name}" NOLOGIN`);
      roles.push(name);
      return name;
    }
    function interceptMutation(
      intercept: (tx: Product102CleanupTransactionPort) => Promise<void>,
    ): Product102CleanupService {
      return new Product102CleanupService(
        {
          transaction: (readOnly, work) =>
            repository.transaction(readOnly, async (tx) => {
              if (!readOnly) {
                const mutate = tx.mutate.bind(tx);
                tx.mutate = async () => {
                  await mutate();
                  await intercept(tx);
                };
              }
              return work(tx);
            }),
        },
        () => cleanupTestTime,
      );
    }
    async function expectBlocked(pid: number): Promise<void> {
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await database.pool.query<{ blocked: boolean }>(
          "SELECT cardinality(pg_blocking_pids($1))>0 AS blocked",
          [pid],
        );
        if (result.rows[0].blocked) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(
        "The concurrent operation did not wait on the expected row lock.",
      );
    }

    it("preflights without writes before migration but gives no executable approval hash", async () => {
      const before = await capture();
      const preview = await service.preview();
      expect(preview.status).toBe("blocked");
      expect(preview.executableHash).toBeNull();
      expect(preview.blockers.map((item) => item.code)).toEqual([
        "CLEANUP_MIGRATION_REQUIRED",
      ]);
      expect(await capture()).toBe(before);
      await expect(
        service.apply({
          expectedHash: preview.evidenceHash,
          actorId: "owner-test",
          approval: "Not yet executable",
        }),
      ).rejects.toMatchObject({ code: "CLEANUP_MIGRATION_REQUIRED" });
    });

    it("uses the migration runner without rewriting any original observation, evaluation or catalog row", async () => {
      const before = await capture();
      await migrate();
      const afterText = await capture();
      expect(
        await repository.transaction(true, (tx) =>
          tx.changedSections(before, afterText),
        ),
      ).toEqual(["historyIdentities"]);
      const after = JSON.parse(afterText);
      expect(
        after.historyIdentities.map(
          (row: { product_id: number }) => row.product_id,
        ),
      ).toEqual([5, 102]);
      expect(
        (await database.pool.query("SELECT filename FROM _migrations")).rows,
      ).toEqual([{ filename: cleanupMigrationFile }]);
      expect((await service.preview()).blockers).toEqual([]);
      await assertNotApplied();
    });

    it("preserves exact values, history and unrelated orders while removing only the reviewed duplicate identities", async () => {
      await migrate();
      const before = await capture();
      const input = await command();
      const result = await service.apply(input);
      expect(result.auditEventId).toBe("9007199254740993");
      expect(result.poEventIds).toEqual([
        "9007199254740993",
        "9007199254740994",
      ]);
      const after = await capture();
      expect(after).toBe(
        await repository.transaction(true, (tx) => tx.expectedAfter(before)),
      );
      expect(
        (
          await database.pool.query(
            "SELECT line_total_cents::text AS value FROM procurement.purchase_order_lines WHERE id=39",
          )
        ).rows[0].value,
      ).toBe("9007199254740993");
      expect(
        (
          await database.pool.query(
            "SELECT expected_receive_units_per_variant FROM procurement.purchase_order_lines WHERE id=221",
          )
        ).rows[0],
      ).toEqual({ expected_receive_units_per_variant: 1 });
      const receipt = await repository.transaction(true, (tx) =>
        tx.readReceipt(),
      );
      expect(receipt?.before).toBe(before);
      expect(receipt?.after).toBe(after);
      expect(receipt?.before).toContain("9007199254740993");
      expect(await service.verify()).toMatchObject({
        recordedComplete: true,
        currentStateMatches: true,
        changedSections: [],
      });
      expect((await service.preview()).status).toBe("already_applied");
      expect(await service.apply(input)).toEqual({
        ...result,
        alreadyApplied: true,
      });
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS n FROM procurement.po_events",
          )
        ).rows[0].n,
      ).toBe(2);
      await expect(
        service.apply({
          ...input,
          approval: "Different approval on the same key",
        }),
      ).rejects.toMatchObject({ code: "CLEANUP_COMMAND_CONFLICT" });
    });

    it("keeps the real backtesting readers on original product 102, not product 5 demand", async () => {
      await migrate();
      const backtests = createPurchaseForecastBacktestingRepository(
        drizzle(database.pool),
      );
      const query = {
        asOf: new Date("2027-01-01T00:00:00Z"),
        horizons: [90] as (7 | 30 | 90)[],
        evaluationVersion: 1,
        limit: 1000,
      };
      const recent = {
        evaluationVersion: 1,
        limit: 1000,
        policyFingerprint: cleanupTestPolicy.fingerprint,
        forecastMethod: "recent_order_velocity_v1",
        forecastVersion: 1,
      };
      const candidatesBefore = await backtests.loadMaturedCandidates(query);
      const recentBefore = await backtests.loadRecent(recent);
      expect(recentBefore).toHaveLength(66);
      expect(
        candidatesBefore.filter((row) => row.productId === 102),
      ).toHaveLength(38);
      expect(
        candidatesBefore
          .filter((row) => row.productId === 102)
          .every((row) => row.actualDemandPieces === 0),
      ).toBe(true);
      expect(
        candidatesBefore.some(
          (row) => row.productId === 5 && row.actualDemandPieces === 3000,
        ),
      ).toBe(true);
      await service.apply(await command());
      expect(await backtests.loadMaturedCandidates(query)).toEqual(
        candidatesBefore,
      );
      expect(await backtests.loadRecent(recent)).toEqual(recentBefore);
    });

    it("rejects a changed preview including a change only in an unsafe-in-JS financial integer", async () => {
      await migrate();
      const input = await command();
      await database.pool.query(
        "UPDATE procurement.purchase_order_lines SET line_total_cents=9007199254740992 WHERE id=39",
      );
      await expect(service.apply(input)).rejects.toMatchObject({
        code: "CLEANUP_PREVIEW_STALE",
      });
      await assertNotApplied();
    });

    it("fingerprints the linked paid invoice and rejects a financial change after preview", async () => {
      await migrate();
      const input = await command();
      await database.pool.query(
        "UPDATE procurement.vendor_invoice_lines SET line_total_cents=line_total_cents+1 WHERE id=43",
      );
      await expect(service.apply(input)).rejects.toMatchObject({
        code: "CLEANUP_PREVIEW_STALE",
      });
      await assertNotApplied();
    });

    it.each(["owner-test-missing", "no-grant", "inactive"])(
      "rolls back all audit work when actor %s lacks an active grant",
      async (actorId) => {
        await migrate();
        const before = await capture();
        await expect(
          service.apply({ ...(await command()), actorId }),
        ).rejects.toMatchObject({ code: "42501" });
        expect(await capture()).toBe(before);
        await assertNotApplied();
      },
    );

    it("rejects a scoped permission rather than treating it as unrestricted authority", async () => {
      await migrate();
      const input = await command();
      await database.pool.query(
        `UPDATE identity.auth_role_permissions SET constraints='{"warehouseId":1}'`,
      );
      await expect(service.apply(input)).rejects.toMatchObject({
        code: "42501",
      });
      await assertNotApplied();
    });

    it.each([
      "UPDATE procurement.purchase_order_lines SET received_qty=1 WHERE id=221",
      "UPDATE inventory.cycle_count_items SET counted_qty=81 WHERE id=3062",
      "UPDATE catalog.products SET is_active=true WHERE id=102",
      "INSERT INTO catalog.product_variants VALUES(999,102,'new-source-variant',1,true)",
      "INSERT INTO procurement.receiving_lines VALUES(2,39)",
      "INSERT INTO inventory.availability_activation_freezes VALUES(1,null)",
      "INSERT INTO inventory.quantity_ledger_opening VALUES(1)",
      "UPDATE inventory.availability_runtime_authority SET authority='canonical'",
    ])("blocks drift in the reviewed scope: %s", async (statement) => {
      await migrate();
      const input = await command();
      await database.pool.query(statement);
      expect((await service.preview()).status).toBe("blocked");
      await expect(service.apply(input)).rejects.toThrow();
      await assertNotApplied();
    });

    it("blocks a newly introduced cascading product dependency without silently deleting it", async () => {
      await migrate();
      await database.pool.query(
        "CREATE TABLE catalog.extra_link(product_id int REFERENCES catalog.products(id) ON DELETE CASCADE); INSERT INTO catalog.extra_link VALUES(102)",
      );
      const preview = await service.preview();
      expect(preview.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "CLEANUP_DEPENDENCY_CHANGED" }),
        ]),
      );
      await assertNotApplied();
    });

    it("blocks a dropped required FK and a disabled forecast guard", async () => {
      await migrate();
      await database.pool.query(
        "ALTER TABLE inventory.cycle_count_items DROP CONSTRAINT cycle_count_items_product_id_fkey",
      );
      await database.pool.query(
        "ALTER TABLE procurement.purchase_forecast_observations DISABLE TRIGGER purchase_forecast_observations_update_guard_trg",
      );
      expect((await service.preview()).blockers.map((row) => row.code)).toEqual(
        expect.arrayContaining([
          "CLEANUP_GUARD_MISSING",
          "CLEANUP_REFERENCE_GUARD_MISSING",
        ]),
      );
      await assertNotApplied();
    });

    it("rolls back an unexpected quantity side effect even after all intended writes", async () => {
      await migrate();
      await database.pool
        .query(`CREATE FUNCTION inventory.test_bad_cleanup_side_effect() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE inventory.inventory_levels SET variant_qty=variant_qty+1 WHERE product_variant_id=206; RETURN NEW; END $$;
      CREATE TRIGGER test_side_effect AFTER UPDATE OF product_id ON inventory.cycle_count_items
      FOR EACH ROW EXECUTE FUNCTION inventory.test_bad_cleanup_side_effect()`);
      const before = await capture();
      await expect(service.apply(await command())).rejects.toMatchObject({
        code: "CLEANUP_UNEXPECTED_SIDE_EFFECT",
      });
      expect(await capture()).toBe(before);
      await assertNotApplied();
    });

    it("rolls back a failure after mutation, including the receipt and both audit paths", async () => {
      await migrate();
      const before = await capture();
      const failing = interceptMutation(async () => {
        throw new Error("Injected post-write verification failure");
      });
      await expect(failing.apply(await command())).rejects.toThrow(
        "Injected post-write",
      );
      expect(await capture()).toBe(before);
      await assertNotApplied();
    });

    it.each([
      { name: "Purchasing", write: correctProduct102PurchasingIdentity },
      { name: "Inventory", write: correctProduct102CountIdentity },
    ])(
      "rejects the $name owner API outside the approved cleanup transaction",
      async ({ write }) => {
        await migrate();
        const before = await capture();
        const client = await database.pool.connect();
        try {
          await expect(write(client)).rejects.toMatchObject({
            code: "CLEANUP_ADMISSION_MISSING",
          });
        } finally {
          client.release();
        }
        expect(await capture()).toBe(before);
        await assertNotApplied();
      },
    );

    it("cannot commit an authorization receipt without the actual deletion", async () => {
      await migrate();
      const input = await command();
      await expect(
        repository.transaction(false, async (tx) => {
          await tx.lock();
          const before = await tx.capture();
          await tx.record(
            input,
            product102RequestHash(input),
            before,
            await tx.expectedAfter(before.data),
            cleanupTestTime.toISOString(),
          );
        }),
      ).rejects.toMatchObject({
        code: "23514",
        message: "CATALOG_CLEANUP_NOT_COMPLETED",
      });
      await assertNotApplied();
    });

    it("rolls back the history migration itself if the runner cannot record completion", async () => {
      await database.pool.query(
        "ALTER TABLE _migrations ADD CONSTRAINT reject_test_migration CHECK(false)",
      );
      const before = await capture();
      await expect(migrate()).rejects.toMatchObject({ code: "23514" });
      expect(await capture()).toBe(before);
      expect(
        (
          await database.pool.query(
            "SELECT to_regclass('catalog.forecast_product_identities') AS relation",
          )
        ).rows[0].relation,
      ).toBeNull();
      await expect(
        database.pool.query(
          "UPDATE procurement.purchase_forecast_observations SET product_id=5 WHERE product_id=102",
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it.each([
      "UPDATE procurement.purchase_forecast_observations SET product_id=5 WHERE product_id=102",
      "DELETE FROM procurement.purchase_forecast_observations WHERE product_id=102",
      "UPDATE procurement.purchase_forecast_evaluations SET actual_demand_pieces=1",
      "DELETE FROM procurement.purchase_forecast_evaluations",
      "UPDATE catalog.forecast_product_identities SET catalog_snapshot='{}'",
      "DELETE FROM catalog.forecast_product_identities",
      "TRUNCATE catalog.forecast_product_identities CASCADE",
      "UPDATE catalog.product_cleanup_receipts SET approval='Changed approval'",
      "DELETE FROM catalog.product_cleanup_receipts",
      "TRUNCATE catalog.product_cleanup_receipts",
      "TRUNCATE catalog.products CASCADE",
    ])(
      "retains evidence immutability after real cleanup: %s",
      async (statement) => {
        await migrate();
        await service.apply(await command());
        await expect(database.pool.query(statement)).rejects.toMatchObject({
          code: "23514",
        });
        expect((await service.verify()).currentStateMatches).toBe(true);
      },
    );

    it("rejects new forecasts for the removed ID, ID reuse and incorrect selected-variant ownership", async () => {
      await migrate();
      await expect(
        database.pool.query(
          insertCleanupTestForecast
            .replace(
              "product_id,product_sku",
              "product_id,selected_receive_variant_id,product_sku",
            )
            .replace("$1,'test'", "$1,206,'test'"),
          [102],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await service.apply(await command());
      await expect(
        database.pool.query(insertCleanupTestForecast, [102]),
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        database.pool.query(
          "INSERT INTO catalog.products VALUES(102,'reused',true,'active')",
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("allows a restricted normal catalog/forecast writer without granting direct history-table access", async () => {
      await migrate();
      const role = await createRole();
      await database.pool
        .query(`GRANT USAGE ON SCHEMA procurement,catalog TO "${role}";
      GRANT INSERT,SELECT,UPDATE,DELETE ON catalog.products TO "${role}";
      GRANT INSERT ON procurement.purchase_forecast_observations TO "${role}";
      GRANT USAGE ON SEQUENCE procurement.purchase_forecast_observations_id_seq TO "${role}"`);
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE "${role}"`);
        await client.query(
          "INSERT INTO catalog.products VALUES(500,'new',true,'active'),(501,'unused',true,'active')",
        );
        await client.query(insertCleanupTestForecast, [500]);
        await client.query("DELETE FROM catalog.products WHERE id=501");
        await client.query("COMMIT");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      expect(
        (
          await database.pool.query(
            "SELECT product_id FROM catalog.forecast_product_identities WHERE product_id=500",
          )
        ).rows,
      ).toEqual([{ product_id: 500 }]);
      await expect(
        database.pool.query("DELETE FROM catalog.products WHERE id=500"),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("does not let an app DB role mint receipts even when it is accidentally granted INSERT", async () => {
      await migrate();
      const input = await command();
      const role = await createRole();
      await database.pool
        .query(`GRANT USAGE ON SCHEMA procurement,catalog,inventory,wms,identity TO "${role}";
      GRANT SELECT ON ALL TABLES IN SCHEMA procurement,catalog,inventory,wms,identity,public TO "${role}";
      GRANT INSERT ON catalog.product_cleanup_receipts,public.audit_events,procurement.po_events TO "${role}";
      GRANT USAGE ON ALL SEQUENCES IN SCHEMA public,procurement TO "${role}"`);
      const before = await repository.transaction(true, (tx) => tx.capture());
      const after = await repository.transaction(true, (tx) =>
        tx.expectedAfter(before.data),
      );
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await client.query(`SET LOCAL ROLE "${role}"`);
        await expect(
          new Product102CleanupTransaction(client).record(
            input,
            product102RequestHash(input),
            before,
            after,
            cleanupTestTime.toISOString(),
          ),
        ).rejects.toMatchObject({
          code: "42501",
          message: "CATALOG_CLEANUP_ADMIN_TRANSACTION_REQUIRED",
        });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      await assertNotApplied();
    });

    it("does not double-apply competing identical commands; a serialization loser can replay safely", async () => {
      await migrate();
      const input = await command();
      const results = await Promise.allSettled([
        service.apply(input),
        service.apply(input),
      ]);
      expect(results.some((result) => result.status === "fulfilled")).toBe(
        true,
      );
      for (const result of results)
        if (result.status === "rejected")
          expect(result.reason).toMatchObject({ code: "40001" });
      expect((await service.apply(input)).alreadyApplied).toBe(true);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS n FROM catalog.product_cleanup_receipts",
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS n FROM procurement.po_events",
          )
        ).rows[0].n,
      ).toBe(2);
    });

    it("blocks an in-flight cutover fence without posting anything", async () => {
      await migrate();
      const input = await command();
      const activation = await database.pool.connect();
      try {
        await activation.query("BEGIN");
        await activation.query(
          "SELECT * FROM inventory.cutover_admission_fence FOR UPDATE",
        );
        await expect(service.apply(input)).rejects.toMatchObject({
          code: "55P03",
        });
      } finally {
        await activation.query("ROLLBACK");
        activation.release();
      }
      await assertNotApplied();
    });

    it("makes a concurrent new forecast wait, then reject the retired product without orphan evidence", async () => {
      await migrate();
      const input = await command();
      const incoming = await database.pool.connect();
      let pending: Promise<string> | undefined;
      try {
        await incoming.query("SET statement_timeout='5s'");
        const pid = (await incoming.query("SELECT pg_backend_pid() AS id"))
          .rows[0].id;
        const coordinated = interceptMutation(async () => {
          pending = incoming.query(insertCleanupTestForecast, [102]).then(
            () => "unexpected_success",
            (error: { code: string }) => error.code,
          );
          await expectBlocked(pid);
        });
        await coordinated.apply(input);
        expect(await pending).toBe("23503");
        expect((await service.verify()).currentStateMatches).toBe(true);
      } finally {
        await pending;
        incoming.release();
      }
    });

    it("pins the actual RBAC grant until the cleanup transaction commits", async () => {
      await migrate();
      const input = await command();
      const revoking = await database.pool.connect();
      let pending: Promise<number | null> | undefined;
      try {
        await revoking.query("SET statement_timeout='5s'");
        const pid = (await revoking.query("SELECT pg_backend_pid() AS id"))
          .rows[0].id;
        const coordinated = interceptMutation(async () => {
          pending = revoking
            .query("DELETE FROM identity.auth_role_permissions WHERE id=1")
            .then((result) => result.rowCount);
          // Attach a handler immediately: a failed assertion still rolls back the
          // cleanup and releases the waiting revocation before leaving the test.
          void pending.catch(() => undefined);
          await expectBlocked(pid);
        });
        await coordinated.apply(input);
        expect(await pending).toBe(1);
        expect((await service.verify()).currentStateMatches).toBe(true);
      } finally {
        await pending;
        revoking.release();
      }
    });

    it("recovers the original receipt after a real commit whose acknowledgement was lost", async () => {
      await migrate();
      const input = await command();
      const faultyPool = {
        connect: async () => {
          const client = await database.pool.connect();
          return new Proxy(client, {
            get(target, property) {
              if (property === "query")
                return async (statement: unknown, ...args: unknown[]) => {
                  const result = await Reflect.apply(target.query, target, [
                    statement,
                    ...args,
                  ]);
                  if (statement === "COMMIT")
                    throw Object.assign(
                      new Error("Simulated lost commit acknowledgement"),
                      { code: "ECONNRESET" },
                    );
                  return result;
                };
              const member = Reflect.get(target, property);
              return typeof member === "function"
                ? member.bind(target)
                : member;
            },
          });
        },
      } as unknown as Pool;
      const uncertain = new Product102CleanupService(
        new Product102CleanupRepository(faultyPool),
        () => cleanupTestTime,
      );
      await expect(uncertain.apply(input)).rejects.toThrow(
        "commit outcome uncertain",
      );
      expect(await service.verify()).toMatchObject({
        recordedComplete: true,
        currentStateMatches: true,
      });
      expect((await service.apply(input)).alreadyApplied).toBe(true);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS n FROM catalog.product_cleanup_receipts",
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS n FROM procurement.po_events",
          )
        ).rows[0].n,
      ).toBe(2);
    });

    it("reports later legitimate stock movement separately from a completed receipt", async () => {
      await migrate();
      const input = await command();
      await service.apply(input);
      await database.pool.query(
        "UPDATE inventory.inventory_levels SET variant_qty=79 WHERE id=1",
      );
      expect(await service.verify()).toMatchObject({
        recordedComplete: true,
        currentStateMatches: false,
        changedSections: ["levels"],
      });
      expect((await service.apply(input)).alreadyApplied).toBe(true);
      expect(
        (
          await database.pool.query(
            "SELECT variant_qty FROM inventory.inventory_levels WHERE id=1",
          )
        ).rows[0].variant_qty,
      ).toBe(79);
    });
  },
);
