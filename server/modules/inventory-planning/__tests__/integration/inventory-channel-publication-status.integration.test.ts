import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql, cutoverCompositionSeedSql, cutoverCompositionChannelSeedSql, installCutoverCompositionMigrations } from "../fixtures/inventory-cutover-composition-database.fixture";
import { ChannelPublicationStatusService } from "../../application/inventory-channel-publication-status.service";
import { PostgresChannelPublicationStatusReader } from "../../infrastructure/inventory-channel-publication-status.repository";

vi.mock("../../../../db", () => ({ pool: {} }));
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = databaseUrl && disposable ? describe : describe.skip;

dbDescribe("recorded publication status against the real inventory migrations", () => {
  let database: InventoryCutoverTestDatabase;
  let service: ChannelPublicationStatusService;
  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, cutoverCompositionBaseSql);
    await installCutoverCompositionMigrations(database.pool);
    await database.pool.query(cutoverCompositionSeedSql + cutoverCompositionChannelSeedSql);
    await database.pool.query(`BEGIN;
      UPDATE inventory.publication_variant_mapping_versions SET lifecycle_status='sealed',sealed_by='operator',sealed_at=transaction_timestamp();
      UPDATE inventory.publication_variant_mapping_heads SET active_mapping_id=draft_mapping_id,draft_mapping_id=NULL,revision=revision+1;
      INSERT INTO catalog.product_variants(id,product_id,sku) VALUES(102,20,'UNMAPPED');
      INSERT INTO catalog.product_variants(id,product_id,sku,requires_shipping) VALUES(103,20,'DIGITAL',false);
      INSERT INTO catalog.product_variants(id,product_id,sku,sales_eligibility) VALUES(104,20,'INTERNAL','internal_only');
      COMMIT;`);
    service = new ChannelPublicationStatusService(new PostgresChannelPublicationStatusReader(database.pool));
  }, 30_000);
  afterEach(async () => { await database?.close(); });

  async function seedDelivery(itemId = "test-item", scopeId = "test-location", connectionId = 7) {
    await database.pool.query(`INSERT INTO inventory.inventory_publication_outbox
      (publication_target_id,product_variant_id,desired_revision,desired_quantity,channel_connection_id_snapshot,
       external_scope_id_snapshot,external_inventory_item_id_snapshot,provider_scope_type_snapshot,external_sku_snapshot,
       publication_target_revision_snapshot,state,idempotency_key,payload_hash,available_at,acknowledged_at,created_at)
      VALUES(1,101,1,0,$3,$2,$1,'location','P5',2,'acknowledged','old',repeat('a',64),'2026-09-01','2026-09-01','2026-09-01'),
       (1,101,2,9007199254740993,$3,$2,$1,'location','P5',2,'queued','new',repeat('b',64),'2026-09-02',NULL,'2026-09-02')`, [itemId, scopeId, connectionId]);
    await database.pool.query(`INSERT INTO inventory.inventory_publication_readbacks
      (publication_target_id,product_variant_id,outbox_id,observed_quantity,matches_desired,evidence_hash,
       external_inventory_item_id_snapshot,destination_kind_snapshot,channel_connection_id_snapshot,
       provider_scope_type_snapshot,external_scope_id_snapshot,publication_target_revision_snapshot,observed_at)
      SELECT 1,101,id,0,true,repeat('c',64),$1,'channel_connection',$3,'location',$2,2,'2026-09-01'
      FROM inventory.inventory_publication_outbox WHERE idempotency_key='old'`, [itemId, scopeId, connectionId]);
  }

  it("keeps latest desired, older acceptance and observed zero distinct without losing bigint precision", async () => {
    await seedDelivery();
    const before = (await database.pool.query("SELECT * FROM inventory.inventory_publication_outbox ORDER BY id")).rows;
    const result = await service.read({ publicationTargetId: 1, productId: 20 });
    expect(result.runtimeAuthority).toBe("legacy");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ productVariantId: 101, activeInventoryItemId: "test-item",
      desired: { quantity: "9007199254740993", revision: "2", state: "queued" },
      acknowledged: { quantity: "0" }, observed: { quantity: "0", matchesDesired: true } });
    expect(result.rows[0].acknowledged?.outboxId).not.toBe(result.rows[0].desired?.outboxId);
    expect(result.rows[1]).toEqual({ productVariantId: 102, activeInventoryItemId: null, desired: null, acknowledged: null, observed: null });
    expect((await database.pool.query("SELECT * FROM inventory.inventory_publication_outbox ORDER BY id")).rows).toEqual(before);
  });

  it("excludes another exact inventory item", async () => {
    await seedDelivery("different-item");
    expect((await service.read({ publicationTargetId: 1, productId: 20 })).rows[0])
      .toMatchObject({ desired: null, acknowledged: null, observed: null });
  });

  it.each([["other-location", 7], ["test-location", 88]])("rejects forged destination snapshots: %s / %s", async (scope, connection) => {
    await expect(seedDelivery("test-item", scope, connection)).rejects.toThrow("publication identity snapshot differs from its target");
    expect((await service.read({ publicationTargetId: 1, productId: 20 })).rows[0])
      .toMatchObject({ desired: null, acknowledged: null, observed: null });
  });

  it("does not use a draft mapping as active delivery authority", async () => {
    await seedDelivery();
    await database.pool.query(`BEGIN;
      INSERT INTO inventory.publication_variant_mapping_versions(publication_target_id,product_variant_id,version,external_inventory_item_id,
        external_sku,definition_hash,change_reason,idempotency_key,request_hash,created_by,supersedes_mapping_id)
      VALUES(1,101,2,'new-item','P5',repeat('b',64),'Draft remap','draft-remap',repeat('b',64),'operator',1);
      UPDATE inventory.publication_variant_mapping_heads SET draft_mapping_id=(SELECT max(id) FROM inventory.publication_variant_mapping_versions),revision=revision+1;
      COMMIT;`);
    expect((await service.read({ publicationTargetId: 1, productId: 20 })).rows[0])
      .toMatchObject({ activeInventoryItemId: "test-item", desired: { quantity: "9007199254740993" } });
  });

  it("retains a newer standalone readback without inventing verification of an outbox request", async () => {
    await seedDelivery();
    await database.pool.query(`INSERT INTO inventory.inventory_publication_readbacks
      (publication_target_id,product_variant_id,observed_quantity,evidence_hash,external_inventory_item_id_snapshot,
       destination_kind_snapshot,channel_connection_id_snapshot,provider_scope_type_snapshot,external_scope_id_snapshot,
       publication_target_revision_snapshot,observed_at)
      VALUES(1,101,4,repeat('d',64),'test-item','channel_connection',7,'location','test-location',2,'2026-09-03')`);
    expect((await service.read({ publicationTargetId: 1, productId: 20 })).rows[0].observed)
      .toMatchObject({ quantity: "4", outboxId: null, matchesDesired: null });
  });

  it("reports missing targets/products and invalid requests instead of empty success", async () => {
    await expect(service.read({ publicationTargetId: 99, productId: 20 })).rejects.toMatchObject({ status: 404 });
    await expect(service.read({ publicationTargetId: 1, productId: 99 })).rejects.toMatchObject({ status: 404 });
    await expect(service.read({ publicationTargetId: 0, productId: 20 })).rejects.toMatchObject({ status: 400 });
  });

  it("executes in a read-only transaction and rolls back failed reads without returning zeros", async () => {
    const reader = new PostgresChannelPublicationStatusReader({ connect: async () => {
      const client = await database.pool.connect();
      const query = client.query.bind(client);
      client.query = vi.fn(async (statement: unknown, ...args: unknown[]) => {
        if (String(statement).includes("jsonb_build_object")) {
          expect((await query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");
          throw new Error("Synthetic status read failure");
        }
        return (query as (...args: unknown[]) => Promise<unknown>)(statement, ...args);
      }) as typeof client.query;
      return client;
    } } as Pick<typeof database.pool, "connect">);
    await expect(new ChannelPublicationStatusService(reader).read({ publicationTargetId: 1, productId: 20 }))
      .rejects.toThrow("Synthetic status read failure");
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.inventory_publication_outbox")).rows[0].count).toBe(0);
  });
});
