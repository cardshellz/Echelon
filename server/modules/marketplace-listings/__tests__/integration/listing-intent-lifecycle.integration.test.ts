import {
  readStockClearingEvidence,
  fenceStockClearingEvidence,
} from "../../../inventory-planning/stock-clearing-evidence";
import { quantityPublicationScopeLockKey } from "../../../inventory-planning/infrastructure/quantity-publication-admission.repository";
import type { QuantityPublicationScope } from "../../../inventory-planning/domain/quantity-publication-admission";
import type { ListingMemberIdentity } from "@shared/types/listing-member-lifecycle";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { listingIntentBase } from "../fixtures/listing-intent.fixture";
import {
  installIntentLifecycleFixture,
  verifyZero,
} from "../fixtures/listing-intent-lifecycle.fixture";
import { ListingIntentLifecycleService } from "../../application/listing-intent-lifecycle.service";
import { PostgresListingIntentLifecycleReader } from "../../infrastructure/pg-listing-intent-lifecycle.reader";
import { PostgresListingIntentPropagationRepository } from "../../infrastructure/pg-listing-intent-propagation.repository";
import { ListingIntentPropagationService } from "../../application/listing-intent-propagation.service";
import { ExistingListingIntentHandoff } from "../../infrastructure/existing-listing-intent-handoff";
import { PostgresListingMemberLifecycleRepository } from "../../infrastructure/pg-listing-member-lifecycle.repository";
import { processListingMemberRetirement } from "../../application/process-listing-member-retirement";
import type { IntentDelivery } from "../../domain/listing-intent-propagation";
import { PostgresListingUpdateRepository } from "../../infrastructure/pg-listing-update.repository";
import { listingUpdateRecord } from "../fixtures/listing-update.fixture";
import { listingHash } from "../../domain/listing-publication";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
(url && disposable ? describe : describe.skip).sequential(
  "excluded listing disposition with PostgreSQL",
  () => {
    let database: InventoryCutoverTestDatabase;
    let repository: PostgresListingIntentPropagationRepository;
    let lifecycle: ListingIntentLifecycleService;
    let now: Date;
    const sync = vi.fn();
    const getByCommand = vi.fn();
    const getAdmission = vi.fn();
    const handoff = () =>
      new ExistingListingIntentHandoff(
        database.pool,
        { createListingPushJob: vi.fn() },
        { channelId: 34, service: { getByCommand, getAdmission }, sync },
        lifecycle,
      );
    const worker = () =>
      new ListingIntentPropagationService({
        store: repository,
        handoff: handoff(),
        now: () => now,
        uuid: randomUUID,
      });
    const rows = async () =>
      (
        await database.pool.query(
          "SELECT * FROM marketplace.listing_intent_deliveries ORDER BY id",
        )
      ).rows;
    async function exclude() {
      await database.pool.query(
        "UPDATE catalog.products SET ebay_listing_excluded=true WHERE id=20",
      );
      await repository.expand(20, now);
    }
    async function claim(): Promise<IntentDelivery> {
      const row = await repository.claim(randomUUID(), now);
      if (!row) throw new Error("missing delivery");
      return row;
    }
    // Production requests can carry no Catalog hints. Persist the actual
    // admission owner's keys, including group member identities, in these tests.
    function scope(
      overrides: Partial<QuantityPublicationScope> = {},
    ): QuantityPublicationScope {
      return {
        destinationKind: "channel_connection",
        connectionId: 4,
        providerKey: "ebay",
        providerScopeType: "account",
        externalScopeId: "seller-a",
        externalInventoryItemId: "SKU-A",
        productId: null,
        productVariantId: null,
        ...overrides,
      };
    }
    async function attempt(
      root: QuantityPublicationScope,
      members: QuantityPublicationScope[] = [root],
      state: "uncertain" | "succeeded" = "uncertain",
    ) {
      return (
        await database.pool.query<{ id: string }>(
          `INSERT INTO inventory.quantity_publication_attempts(owner_token,owner_kind,gate_epoch,scope_key,scope,
          affected_scope_keys,affected_scopes,state,started_at,completed_at)
         VALUES($1,'legacy',0,$2,$3,$4,$5,$6,$7,$8) RETURNING id::text`,
          [
            randomUUID(),
            quantityPublicationScopeLockKey(root),
            JSON.stringify(root),
            members.map(quantityPublicationScopeLockKey),
            JSON.stringify(members),
            state,
            now,
            state === "succeeded" ? new Date(now.getTime() + 1000) : null,
          ],
        )
      ).rows[0].id;
    }
    async function catchup(identity: QuantityPublicationScope) {
      return (
        await database.pool.query<{ id: string }>(
          `INSERT INTO inventory.quantity_publication_catchup(scope_key,scope,reason,next_attempt_at,updated_at)
         VALUES($1,$2,'retained work',$3,$3) RETURNING id::text`,
          [
            quantityPublicationScopeLockKey(identity),
            JSON.stringify(identity),
            now,
          ],
        )
      ).rows[0].id;
    }
    beforeEach(async () => {
      vi.resetAllMocks();
      now = new Date("2026-10-20T20:00:00Z");
      getByCommand.mockResolvedValue(null);
      getAdmission.mockResolvedValue(null);
      database = await createInventoryCutoverTestDatabase(
        url,
        disposable,
        listingIntentBase,
      );
      await installIntentLifecycleFixture(database.pool);
      // Keep this suite's product destination exact; other fixtures retain all
      // three providers for the propagation fanout tests.
      await database.pool.query(
        "DELETE FROM channels.channel_feeds WHERE channel_id<>34; DELETE FROM channels.channel_listings WHERE channel_id<>34; DELETE FROM dropship.dropship_vendor_listings",
      );
      repository = new PostgresListingIntentPropagationRepository(
        database.pool,
      );
      lifecycle = new ListingIntentLifecycleService(
        new PostgresListingIntentLifecycleReader(database.pool),
        () => now,
      );
    });
    afterEach(async () => {
      await database?.close();
    });
    it.each(["uncertain", "succeeded"] as const)(
      "does not block other products with an unhinted %s group request",
      async (state) => {
        await exclude();
        await verifyZero(database.pool, now);
        const root = scope({ externalInventoryItemId: "group:OTHER-PRODUCT" });
        const id = await attempt(
          root,
          [
            root,
            scope({ externalInventoryItemId: "OTHER-PACK" }),
            scope({ externalInventoryItemId: "OTHER-CASE" }),
          ],
          state,
        );
        await worker().processDue();
        expect((await rows())[0].state).toBe("not_applicable");
        expect(
          (
            await database.pool.query(
              "SELECT state FROM inventory.quantity_publication_attempts WHERE id=$1",
              [id],
            )
          ).rows[0].state,
        ).toBe(state);
        expect(sync).not.toHaveBeenCalled();
      },
    );
    it("does not manufacture completion when an unrelated request was the only pending blocker", async () => {
      await exclude();
      await attempt(scope({ externalInventoryItemId: "OTHER-PRODUCT" }));
      await worker().processDue();
      const [row] = await rows();
      expect(row.state).toBe("waiting_lifecycle");
      expect(
        row.lifecycle.members.map((member: { code: string }) => member.code),
      ).toEqual([
        "LISTING_STOCK_CLEARING_UNPROVEN",
        "LISTING_STOCK_CLEARING_UNPROVEN",
      ]);
    });
    it.each(["root", "affected"])(
      "retains the exact unhinted %s member request without blocking its sibling",
      async (kind) => {
        await exclude();
        await verifyZero(database.pool, now);
        const member = scope();
        const root =
          kind === "root"
            ? member
            : scope({ externalInventoryItemId: "group:PRODUCT" });
        const id = await attempt(root, [
          root,
          member,
          scope({ externalInventoryItemId: "OTHER-PACK" }),
        ]);
        await worker().processDue();
        const [row] = await rows();
        expect(row.state).toBe("waiting_lifecycle");
        expect(row.lifecycle.members[0]).toMatchObject({
          state: "pending",
          references: ["request:" + id],
        });
        expect(row.lifecycle.members[1].state).toBe("settled");
      },
    );
    it.each([true, false])(
      "scopes unhinted catch-up to its exact retained member (matching=%s)",
      async (matching) => {
        await exclude();
        await verifyZero(database.pool, now);
        const id = await catchup(
          scope({ externalInventoryItemId: matching ? "SKU-A" : "OTHER-PACK" }),
        );
        await worker().processDue();
        const [row] = await rows();
        expect(row.state).toBe(
          matching ? "waiting_lifecycle" : "not_applicable",
        );
        expect(row.lifecycle.members[0].state).toBe(
          matching ? "pending" : "settled",
        );
        expect(row.lifecycle.members[1].state).toBe("settled");
        expect(
          (
            await database.pool.query(
              "SELECT completed_revision::text n FROM inventory.quantity_publication_catchup WHERE id=$1",
              [id],
            )
          ).rows[0].n,
        ).toBe("0");
      },
    );
    it("invalidates only the affected member's proof after a later unhinted completed request", async () => {
      await exclude();
      await verifyZero(database.pool, now);
      await attempt(scope(), [scope()], "succeeded");
      await worker().processDue();
      const [row] = await rows();
      expect(row.state).toBe("waiting_lifecycle");
      expect(row.lifecycle.members[0]).toMatchObject({
        state: "attention",
        code: "LISTING_STOCK_CLEARING_UNPROVEN",
      });
      expect(row.lifecycle.members[1].state).toBe("settled");
    });
    it.each([
      { label: "provider", override: { providerKey: "shopify" } },
      { label: "account", override: { externalScopeId: "other-seller" } },
      { label: "location", override: { providerScopeType: "location" } },
      { label: "connection", override: { connectionId: 40 } },
      {
        label: "destination",
        override: { destinationKind: "dropship_store_connection" },
      },
    ] satisfies Array<{
      label: string;
      override: Partial<QuantityPublicationScope>;
    }>)(
      "keeps unhinted requests and catch-up isolated by $label",
      async ({ override }) => {
        await exclude();
        await verifyZero(database.pool, now);
        const identity = scope(override);
        await attempt(identity);
        await catchup(identity);
        await attempt(identity, [identity], "succeeded");
        await worker().processDue();
        expect((await rows())[0].state).toBe("not_applicable");
      },
    );
    it.each([
      {
        providerKey: "ebay",
        destinationKind: "channel_connection",
        providerScopeType: "account",
      },
      {
        providerKey: "walmart",
        destinationKind: "channel_connection",
        providerScopeType: "account",
      },
      {
        providerKey: "shopify",
        destinationKind: "channel_connection",
        providerScopeType: "location",
      },
      {
        providerKey: "shopify",
        destinationKind: "dropship_store_connection",
        providerScopeType: "location",
      },
    ] satisfies Array<
      Pick<
        QuantityPublicationScope,
        "providerKey" | "destinationKind" | "providerScopeType"
      >
    >)(
      "uses shared exact member matching for $providerKey / $destinationKind",
      async (identity) => {
        await verifyZero(database.pool, now);
        const dropship =
          identity.destinationKind === "dropship_store_connection";
        await database.pool.query(
          `UPDATE inventory.inventory_publication_targets
          SET destination_kind=$1,channel_connection_id=$2,dropship_store_connection_id=$3,provider_scope_type=$4`,
          [
            identity.destinationKind,
            dropship ? null : 4,
            dropship ? 4 : null,
            identity.providerScopeType,
          ],
        );
        await database.pool.query(
          `UPDATE inventory.inventory_publication_outbox
          SET destination_kind_snapshot=$1,channel_connection_id_snapshot=$2,dropship_store_connection_id_snapshot=$3,
            provider_scope_type_snapshot=$4,provider_key_snapshot=$5`,
          [
            identity.destinationKind,
            dropship ? null : 4,
            dropship ? 4 : null,
            identity.providerScopeType,
            identity.providerKey,
          ],
        );
        await database.pool.query(
          `UPDATE inventory.inventory_publication_readbacks
          SET destination_kind_snapshot=$1,channel_connection_id_snapshot=$2,dropship_store_connection_id_snapshot=$3,provider_scope_type_snapshot=$4`,
          [
            identity.destinationKind,
            dropship ? null : 4,
            dropship ? 4 : null,
            identity.providerScopeType,
          ],
        );
        const id = await attempt(scope(identity));
        const client = await database.pool.connect();
        try {
          await client.query("BEGIN");
          await fenceStockClearingEvidence(client);
          const evidence = await readStockClearingEvidence(client, {
            destinationKind: identity.destinationKind,
            connectionId: 4,
            accountId: "seller-a",
            providerKey: identity.providerKey,
            productId: 20,
            productVariantIds: [101, 102],
          });
          expect(evidence[0]).toMatchObject({
            state: "pending",
            references: ["request:" + id],
          });
          expect(evidence[1].state).toBe("settled");
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      },
    );
    it.each(["mapping", "outbox", "alias"])(
      "retains an exact historic %s identity after remapping",
      async (source) => {
        await exclude();
        await verifyZero(database.pool, now);
        if (source === "mapping") {
          await database.pool
            .query(`INSERT INTO inventory.publication_variant_mapping_versions
          (id,publication_target_id,product_variant_id,lifecycle_status,external_inventory_item_id)
          VALUES(201,1,101,'retired','OLD-ITEM')`);
        } else if (source === "outbox") {
          await database.pool
            .query(`INSERT INTO inventory.inventory_publication_outbox
          (id,publication_target_id,product_variant_id,destination_kind_snapshot,channel_connection_id_snapshot,
           state,desired_quantity,desired_revision,external_inventory_item_id_snapshot,external_scope_id_snapshot)
          VALUES(201,1,101,'channel_connection',4,'cancelled',3,0,'OLD-ITEM','old-seller')`);
        } else {
          await database.pool.query(
            "UPDATE inventory.publication_variant_mapping_versions SET external_sku='OLD-ITEM' WHERE id=101",
          );
        }
        const id = await attempt(
          scope({
            externalInventoryItemId: "OLD-ITEM",
            externalScopeId: source === "outbox" ? "old-seller" : "seller-a",
          }),
        );
        await worker().processDue();
        expect((await rows())[0].lifecycle.members[0]).toMatchObject({
          state: "pending",
          references: ["request:" + id],
        });
        expect((await rows())[0].lifecycle.members[1].state).toBe("settled");
      },
    );
    it("assesses the supported 250-member scope within the owner's statement timeout", async () => {
      await verifyZero(database.pool, now);
      await database.pool
        .query(`INSERT INTO catalog.product_variants(id,product_id,sku)
          SELECT n,20,'MEMBER-'||n FROM generate_series(1000,1249) n;
        INSERT INTO inventory.publication_variant_mapping_versions
          (id,publication_target_id,product_variant_id,lifecycle_status,external_inventory_item_id)
          SELECT n,1,n,'sealed','MEMBER-'||n FROM generate_series(1000,1249) n;
        INSERT INTO inventory.publication_variant_mapping_heads
          SELECT 1,n,n FROM generate_series(1000,1249) n;
        INSERT INTO inventory.inventory_publication_outbox
          (id,publication_target_id,product_variant_id,destination_kind_snapshot,channel_connection_id_snapshot,
           state,desired_quantity,desired_revision,external_inventory_item_id_snapshot)
          SELECT n,1,n,'channel_connection',4,'verified',0,1,'MEMBER-'||n FROM generate_series(1000,1249) n;`);
      await database.pool.query(
        `INSERT INTO inventory.inventory_publication_readbacks
        SELECT n,1,n,n,'channel_connection',4,NULL,1,'account','seller-a','MEMBER-'||n,0,true,true,$1
        FROM generate_series(1000,1249) n`,
        [now],
      );
      const history = Array.from({ length: 10_000 }, (_, index) => {
        const identity = scope({ externalInventoryItemId: "HISTORY-" + index });
        return {
          token: randomUUID(),
          scope: identity,
          key: quantityPublicationScopeLockKey(identity),
        };
      });
      await database.pool.query(
        `INSERT INTO inventory.quantity_publication_attempts(owner_token,owner_kind,gate_epoch,
        scope_key,scope,affected_scope_keys,affected_scopes,state,started_at,completed_at)
        SELECT h.token,'legacy',0,h.key,h.scope,ARRAY[h.key],jsonb_build_array(h.scope),'succeeded',$2,$2
        FROM jsonb_to_recordset($1::jsonb) h(token uuid,key text,scope jsonb)`,
        [JSON.stringify(history), new Date(now.getTime() + 1000)],
      );
      await database.pool.query(
        `INSERT INTO inventory.quantity_publication_catchup(scope_key,scope,reason,next_attempt_at,updated_at)
        SELECT h.key,h.scope,'unrelated retained work',$2,$2 FROM jsonb_to_recordset($1::jsonb) h(key text,scope jsonb)`,
        [JSON.stringify(history), now],
      );
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN");
        // Same limit as PostgresListingIntentLifecycleReader, enforced by PostgreSQL.
        await client.query("SET LOCAL statement_timeout='5s'");
        await fenceStockClearingEvidence(client);
        const evidence = await readStockClearingEvidence(client, {
          destinationKind: "channel_connection",
          connectionId: 4,
          accountId: "seller-a",
          providerKey: "ebay",
          productId: 20,
          productVariantIds: Array.from(
            { length: 250 },
            (_, index) => index + 1000,
          ),
        });
        expect(evidence).toHaveLength(250);
        expect(evidence.every((member) => member.state === "settled")).toBe(
          true,
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
    it("retains excluded members and shows their unverified clearing duty without calling content sync", async () => {
      await exclude();
      await worker().processDue();
      const [row] = await rows();
      expect(row.state).toBe("waiting_lifecycle");
      expect(row.variant_ids).toEqual([101, 102]);
      expect(row.lifecycle.members.map((m: any) => m.state)).toEqual([
        "attention",
        "attention",
      ]);
      expect(row.lifecycle.members[0].duty).toBe("stock_clear");
      expect(sync).not.toHaveBeenCalled();
      expect((await repository.list({ channelId: 34 })).items[0]).toMatchObject(
        { can_retry: false, state: "waiting_lifecycle" },
      );
    });
    it("settles only verified exact zero evidence and preserves immutable disposition history", async () => {
      await exclude();
      await verifyZero(database.pool, now);
      await worker().processDue();
      const [row] = await rows();
      expect(row.state).toBe("not_applicable");
      expect(row.receipt).toBeNull();
      expect(
        row.lifecycle.members.every((m: any) => m.state === "settled"),
      ).toBe(true);
      await expect(
        database.pool.query(
          "UPDATE marketplace.listing_intent_deliveries SET state='pending' WHERE id=$1",
          [row.id],
        ),
      ).rejects.toThrow(/IMMUTABLE/);
      await worker().processDue();
      expect(await rows()).toHaveLength(1);
      expect(sync).not.toHaveBeenCalled();
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int n FROM marketplace.listing_intent_delivery_events",
          )
        ).rows[0].n,
      ).toBe(1);
    });
    it("never uses catch-up completion or a zero observation to skip an unresolved provider request", async () => {
      await exclude();
      await verifyZero(database.pool, now);
      const scope = {
        destinationKind: "channel_connection",
        connectionId: 4,
        providerKey: "ebay",
        providerScopeType: "account",
        externalScopeId: "seller-a",
        externalInventoryItemId: "SKU-A",
        productId: 20,
        productVariantId: 101,
      };
      await database.pool.query(
        `INSERT INTO inventory.quantity_publication_attempts(owner_token,owner_kind,gate_epoch,scope_key,scope,affected_scope_keys,affected_scopes,state,started_at)
      VALUES($1,'legacy',0,$2,$3,ARRAY[$2],jsonb_build_array($3::jsonb),'uncertain',$4)`,
        [randomUUID(), "a".repeat(64), JSON.stringify(scope), now],
      );
      await worker().processDue();
      const [row] = await rows();
      expect(row.state).toBe("waiting_lifecycle");
      expect(row.lifecycle.members[0]).toMatchObject({
        state: "pending",
        code: "LISTING_STOCK_WORK_OUTSTANDING",
      });
      expect(
        (
          await database.pool.query(
            "SELECT state FROM inventory.quantity_publication_attempts",
          )
        ).rows[0].state,
      ).toBe("uncertain");
    });
    it("automatically rechecks pending clearing and settles only after the existing owner finishes", async () => {
      await exclude();
      await verifyZero(database.pool, now);
      await database.pool.query(
        `INSERT INTO inventory.quantity_publication_catchup(scope_key,scope,reason,next_attempt_at,updated_at)
      VALUES($1,$2,'excluded',$3,$3)`,
        [
          "b".repeat(64),
          JSON.stringify({
            destinationKind: "channel_connection",
            connectionId: 4,
            productId: 20,
            productVariantId: 101,
          }),
          now,
        ],
      );
      await worker().processDue();
      expect((await rows())[0].state).toBe("waiting_lifecycle");
      await database.pool.query(
        "UPDATE inventory.quantity_publication_catchup SET completed_revision=revision",
      );
      now = new Date(now.getTime() + 60000);
      await worker().processDue();
      expect((await rows())[0].state).toBe("not_applicable");
      expect(
        (
          await database.pool.query(
            "SELECT action FROM marketplace.listing_intent_delivery_events ORDER BY id",
          )
        ).rows.map((r) => r.action),
      ).toEqual(["waiting_lifecycle", "not_applicable"]);
    });
    it.each([
      "account",
      "mapping",
      "quantity",
      "consistency",
      "acknowledged",
      "later-positive",
      "target-revision",
    ])("rejects stale or incomplete %s proof", async (kind) => {
      await exclude();
      await verifyZero(database.pool, now);
      if (kind === "target-revision")
        await database.pool.query(
          "UPDATE inventory.inventory_publication_targets SET revision=revision+1",
        );
      if (kind === "account")
        await database.pool.query(
          "UPDATE inventory.inventory_publication_readbacks SET external_scope_id_snapshot='another-seller'",
        );
      if (kind === "mapping")
        await database.pool.query(
          "UPDATE inventory.publication_variant_mapping_versions SET external_inventory_item_id='replacement'",
        );
      if (kind === "quantity")
        await database.pool.query(
          "UPDATE inventory.inventory_publication_readbacks SET observed_quantity=1",
        );
      if (kind === "consistency")
        await database.pool.query(
          "UPDATE inventory.inventory_publication_readbacks SET quantity_consistent=false",
        );
      if (kind === "acknowledged")
        await database.pool.query(
          "UPDATE inventory.inventory_publication_outbox SET state='acknowledged'",
        );
      if (kind === "later-positive")
        await database.pool.query(
          "INSERT INTO inventory.inventory_publication_outbox(id,publication_target_id,product_variant_id,destination_kind_snapshot,channel_connection_id_snapshot,dropship_store_connection_id_snapshot,state,desired_quantity,desired_revision,external_inventory_item_id_snapshot) VALUES(103,1,101,'channel_connection',4,NULL,'verified',12,2,'SKU-A')",
        );
      await worker().processDue();
      expect((await rows())[0].state).toBe("waiting_lifecycle");
      expect(sync).not.toHaveBeenCalled();
    });
    it.each(["price", "picture", "policy"])(
      "reuses current verified zero for an excluded %s change without creating new stock work",
      async (kind) => {
        // Store-policy changes fan out to every retained product; this proof is
        // scoped to the excluded product, with unrelated targets removed.
        await database.pool.query(
          "DELETE FROM channels.channel_listings WHERE product_variant_id=103; DELETE FROM channels.channel_feeds WHERE product_variant_id=103",
        );
        await exclude();
        await verifyZero(database.pool, new Date("2026-10-19T20:00:00Z"));
        await worker().processDue();
        expect((await rows())[0].state).toBe("not_applicable");
        if (kind === "price")
          await database.pool.query(
            "UPDATE channels.channel_pricing_rules SET value=11 WHERE id=1",
          );
        if (kind === "picture")
          await database.pool.query(
            "UPDATE catalog.product_assets SET url='https://example.com/revised.jpg' WHERE id=1",
          );
        if (kind === "policy")
          await database.pool.query(
            "UPDATE channels.channel_connections SET metadata=metadata || $1::jsonb WHERE id=4",
            [JSON.stringify({ fulfillmentPolicyId: "valid-policy" })],
          );
        await repository.expand(20, now);
        await worker().processDue();
        const deliveries = await rows();
        expect(deliveries).toHaveLength(2);
        expect(deliveries.map((row) => row.state)).toEqual([
          "not_applicable",
          "not_applicable",
        ]);
        expect(
          (
            await database.pool.query(
              "SELECT count(*)::int n FROM inventory.inventory_publication_outbox",
            )
          ).rows[0].n,
        ).toBe(2);
        expect(
          (
            await database.pool.query(
              "SELECT count(*)::int n FROM inventory.quantity_publication_attempts",
            )
          ).rows[0].n,
        ).toBe(0);
        expect(sync).not.toHaveBeenCalled();
      },
    );
    it("requires a new observation after a later completed quantity request", async () => {
      await exclude();
      await verifyZero(database.pool, new Date("2026-10-19T20:00:00Z"));
      const scope = {
        destinationKind: "channel_connection",
        connectionId: 4,
        productId: 20,
        productVariantId: 101,
      };
      await database.pool.query(
        "INSERT INTO inventory.quantity_publication_attempts(owner_token,owner_kind,gate_epoch,scope_key,scope,affected_scope_keys,affected_scopes,state,started_at,completed_at) VALUES($1,'legacy',0,$2,$3,ARRAY[$2],jsonb_build_array($3::jsonb),'succeeded',$4,$4)",
        [randomUUID(), "e".repeat(64), JSON.stringify(scope), now],
      );
      await worker().processDue();
      expect((await rows())[0].state).toBe("waiting_lifecycle");
      now = new Date(now.getTime() + 60000);
      await verifyZero(database.pool, now);
      await worker().processDue();
      expect((await rows())[0].state).toBe("not_applicable");
      expect(sync).not.toHaveBeenCalled();
    });
    it("AUDIT: an expired unsubmitted review does not become outstanding channel work", async () => {
      await database.pool.query(`UPDATE channels.channels SET provider='walmart' WHERE id=34;
        INSERT INTO channels.walmart_connections(channel_id,connection_id,partner_id,environment,ship_node_id,warehouse_id,revision,market)
          VALUES(34,4,'partner-a','production','node-a',1,1,'US');
        INSERT INTO channels.channel_product_overrides(id,channel_id,product_id,is_listed) VALUES(1,34,20,0)`);
      await repository.expand(20, now);
      await verifyZero(database.pool, now);
      await database.pool.query(`UPDATE inventory.inventory_publication_targets SET external_scope_id='partner-a';
        UPDATE inventory.inventory_publication_readbacks SET external_scope_id_snapshot='partner-a';
        UPDATE inventory.inventory_publication_outbox SET external_scope_id_snapshot='partner-a',provider_key_snapshot='walmart'`);
      const delivery = await claim();
      expect(await lifecycle.assess(delivery)).toMatchObject({ state: "not_applicable" });
      const original = listingUpdateRecord();
      const account = { ...original.intent.account, channelId: 34, connectionId: 4, accountId: "partner-a", market: "US", environment: "production" as const, scopeId: "node-a" };
      expect(delivery.destination).toMatchObject({ provider: account.provider, accountId: account.accountId,
        environment: account.environment, marketplaceId: account.market });
      const source = { ...original.intent.source, sku: "SKU-A", externalProductId: "listing-a" };
      const intent = { ...original.intent, account, source, command: { ...original.intent.command,
        sku: source.sku, sourceHash: listingHash({ account, current: source }) } };
      const review = { ...original, intent, view: { ...original.view, sku: source.sku, reviewHash: listingHash(intent) } };
      const updates = new PostgresListingUpdateRepository(database.pool);
      await updates.insert(review, "operator");
      expect(new Date(review.view.expiresAt).getTime()).toBeLessThan(now.getTime());
      expect((await updates.get(34, review.view.id)).commandKey).toBeNull();
      expect(await updates.list(34)).toEqual([]);
      const outcome = await handoff().handoff(delivery);
      await repository.finish(delivery, outcome, now);
      expect((await rows())[0].state).toBe("not_applicable");
    });

    it("keeps earlier listing operations outstanding instead of hiding their errors", async () => {
      await exclude();
      await verifyZero(database.pool, now);
      const identity = {
        channelId: 34,
        connectionId: 4,
        productId: 20,
        accountId: "seller-a",
        variants: [
          {
            variantId: 101,
            sku: "SKU-A",
            offerId: "offer-a",
            listingId: "listing-a",
          },
        ],
      };
      await database.pool.query(
        "INSERT INTO channels.ebay_listing_sync_jobs(id,channel_id,connection_id,product_id,operation,state,identity,error_code) VALUES($1,34,4,20,'sync','needs_attention',$2,'EXISTING_FAILURE')",
        [randomUUID(), JSON.stringify(identity)],
      );
      await worker().processDue();
      expect((await rows())[0].lifecycle.members[0].code).toBe(
        "LISTING_LIFECYCLE_PRIOR_WORK",
      );
      expect(
        (
          await database.pool.query(
            "SELECT error_code FROM channels.ebay_listing_sync_jobs",
          )
        ).rows[0].error_code,
      ).toBe("EXISTING_FAILURE");
    });
    it("does not suppress selected siblings or restore an archived member to content scope", async () => {
      await database.pool.query(
        "UPDATE catalog.product_variants SET is_active=false WHERE id=102",
      );
      await repository.expand(20, now);
      expect(await lifecycle.assess(await claim())).toBeNull();
    });
    it.each(["ebay", "shopify", "walmart"])(
      "requires exact current retirement receipts for archived-only %s products",
      async (provider) => {
        await database.pool.query(
          "UPDATE channels.channels SET provider=$1 WHERE id=34",
          [provider],
        );
        await database.pool.query(
          "UPDATE channels.channel_connections SET shop_domain='shop.example',metadata=CASE WHEN $1='ebay' THEN metadata ELSE NULL END WHERE id=4",
          [provider],
        );
        if (provider === "walmart")
          await database.pool.query(
            "INSERT INTO channels.walmart_connections VALUES(34,4,'partner-a','production','node-a',1,1,'US')",
          );
        await database.pool.query(
          "UPDATE catalog.products SET is_active=false WHERE id=20",
        );
        await repository.expand(20, now);
        const delivery = await claim();
        expect((await lifecycle.assess(delivery))?.state).toBe(
          "waiting_lifecycle",
        );
        const store = new PostgresListingMemberLifecycleRepository(
          database.pool,
        );
        await store.discover(now, 25);
        const adapter = {
          observe: vi.fn(async (identity: ListingMemberIdentity) => ({
            identity,
            retired: true,
          })),
          retire: vi.fn(),
        };
        for (const id of await store.due(now, 25))
          await store.withMember(id, (session) =>
            processListingMemberRetirement(
              session,
              { store, adapter: async () => adapter },
              () => now,
            ),
          );
        const outcome = await lifecycle.assess(delivery);
        expect(outcome?.state).toBe("not_applicable");
        expect(adapter.retire).not.toHaveBeenCalled();
        await repository.finish(delivery, outcome!, now);
        await database.pool.query(
          "UPDATE catalog.products SET is_active=true,updated_at=updated_at+interval '1 second' WHERE id=20",
        );
        await repository.expand(20, now);
        const next = await claim();
        expect(next.commandKey).not.toBe(delivery.commandKey);
        expect(await lifecycle.assess(next)).toBeNull();
        expect((await rows())[0].state).toBe("not_applicable");
      },
    );
    it("has one disposition under concurrent workers and rejects stale-lease completion", async () => {
      await exclude();
      await verifyZero(database.pool, now);
      const claims = await Promise.all([
        repository.claim(randomUUID(), now),
        repository.claim(randomUUID(), now),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const delivery = claims.find(Boolean)!;
      const outcome = (await lifecycle.assess(delivery))!;
      await repository.finish(
        { ...delivery, leaseToken: randomUUID() },
        outcome,
        now,
      );
      expect((await rows())[0].state).toBe("pending");
      await repository.finish(delivery, outcome, now);
      await repository.finish(delivery, outcome, now);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int n FROM marketplace.listing_intent_delivery_events",
          )
        ).rows[0].n,
      ).toBe(1);
    });
    it("retains old refusal events while reclassifying previously blocked exclusions", async () => {
      await exclude();
      const delivery = await claim();
      await repository.finish(
        delivery,
        {
          state: "blocked",
          code: "PREVIOUS_REFUSAL",
          message: "Earlier refusal",
        },
        now,
      );
      // Represents a row that predates the new assessment migration.
      await database.pool.query(
        "UPDATE marketplace.listing_intent_deliveries SET lifecycle_checked_at=NULL",
      );
      now = new Date(now.getTime() + 60000);
      await worker().processDue();
      expect((await rows())[0].state).toBe("waiting_lifecycle");
      const events = (
        await database.pool.query(
          "SELECT after_state FROM marketplace.listing_intent_delivery_events ORDER BY id",
        )
      ).rows;
      expect(events[0].after_state.last_error_code).toBe("PREVIOUS_REFUSAL");
      expect(events[1].after_state.state).toBe("waiting_lifecycle");
    });
    it("serializes dispatch even after a slow worker's lease expires", async () => {
      await exclude();
      const first = await claim();
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const running = repository.withDelivery(first, async () => {
        entered();
        await held;
      });
      await ready;
      try {
        now = new Date(now.getTime() + 301000);
        const second = await claim();
        const work = vi.fn(async () => {});
        expect(await repository.withDelivery(second, work)).toBe(false);
        expect(work).not.toHaveBeenCalled();
        expect((await rows())[0].state).toBe("pending");
      } finally {
        release();
        await running;
      }
    });
    it("does not import another product's group catch-up into this exclusion", async () => {
      await exclude();
      await verifyZero(database.pool, now);
      await database.pool.query(
        `INSERT INTO inventory.quantity_publication_catchup(scope_key,scope,reason,next_attempt_at,updated_at)
      VALUES($1,$2,'other product',$3,$3)`,
        [
          "c".repeat(64),
          JSON.stringify({
            destinationKind: "channel_connection",
            connectionId: 4,
            productId: 21,
            productVariantId: null,
          }),
          now,
        ],
      );
      await worker().processDue();
      expect((await rows())[0].state).toBe("not_applicable");
      expect(
        (
          await database.pool.query(
            "SELECT completed_revision::text revision FROM inventory.quantity_publication_catchup",
          )
        ).rows[0].revision,
      ).toBe("0");
    });
    it("rejects a fabricated terminal disposition with pending members at the database boundary", async () => {
      await exclude();
      const delivery = await claim();
      const pending = await lifecycle.assess(delivery);
      if (!pending || !("lifecycle" in pending))
        throw new Error("missing lifecycle evidence");
      await expect(
        repository.finish(
          delivery,
          { ...pending, state: "not_applicable" },
          now,
        ),
      ).rejects.toThrow(/listing_intent_lifecycle_evidence_check/);
      expect((await rows())[0].state).toBe("pending");
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int n FROM marketplace.listing_intent_delivery_events",
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it("keeps stock catch-up outstanding after exact remote archival completion", async () => {
      await database.pool.query(
        "UPDATE catalog.products SET is_active=false WHERE id=20",
      );
      await repository.expand(20, now);
      const store = new PostgresListingMemberLifecycleRepository(database.pool);
      await store.discover(now, 25);
      const adapter = {
        observe: vi.fn(async (identity: ListingMemberIdentity) => ({
          identity,
          retired: true,
        })),
        retire: vi.fn(),
      };
      for (const id of await store.due(now, 25))
        await store.withMember(id, (session) =>
          processListingMemberRetirement(
            session,
            { store, adapter: async () => adapter },
            () => now,
          ),
        );
      await database.pool.query(
        `INSERT INTO inventory.quantity_publication_catchup(scope_key,scope,reason,next_attempt_at,updated_at)
      VALUES($1,$2,'archive pending',$3,$3)`,
        [
          "d".repeat(64),
          JSON.stringify({
            destinationKind: "channel_connection",
            connectionId: 4,
            productId: 20,
            productVariantId: 101,
          }),
          now,
        ],
      );
      await worker().processDue();
      expect((await rows())[0]).toMatchObject({ state: "waiting_lifecycle" });
      expect((await rows())[0].lifecycle.members[0]).toMatchObject({
        duty: "retirement",
        code: "LISTING_STOCK_WORK_OUTSTANDING",
      });
    });
    it.each(["track_inventory", "requires_shipping"])(
      "keeps content updates selected when %s is false",
      async (field) => {
        // Both are allowlisted fixture column names, never request input.
        await database.pool.query(
          "UPDATE catalog.product_variants SET " +
            field +
            "=false WHERE product_id=20",
        );
        await database.pool.query(
          "UPDATE catalog.products SET name='Content still selected' WHERE id=20",
        );
        await repository.expand(20, now);
        expect(await lifecycle.assess(await claim())).toBeNull();
      },
    );
    it.each(["seller-a", "other-account", null])(
      "requires an account-bound withdrawal receipt (%s)",
      async (accountId) => {
        await exclude();
        await database.pool.query(
          "UPDATE channels.channel_listings SET sync_status='ended' WHERE channel_id=34",
        );
        const identity = {
          channelId: 34,
          connectionId: 4,
          productId: 20,
          ...(accountId ? { accountId } : {}),
          variants: [
            {
              variantId: 101,
              sku: "SKU-A",
              offerId: "offer-a",
              listingId: "listing-a",
            },
            {
              variantId: 102,
              sku: "SKU-B",
              offerId: "offer-b",
              listingId: "listing-a",
            },
          ],
        };
        await database.pool.query(
          "INSERT INTO channels.ebay_listing_sync_jobs(id,channel_id,connection_id,product_id,operation,state,identity,provider_identity) VALUES($1,34,4,20,'withdraw','completed',$2,$2)",
          [randomUUID(), JSON.stringify(identity)],
        );
        await worker().processDue();
        expect((await rows())[0].state).toBe(
          accountId === "seller-a" ? "not_applicable" : "waiting_lifecycle",
        );
      },
    );
    it("accepts the stock owner's exact verified location proof without requiring multi-surface quantity metadata", async () => {
      await database.pool.query(
        "UPDATE channels.channels SET provider='shopify' WHERE id=34",
      );
      await database.pool.query(
        "UPDATE channels.channel_connections SET shop_domain='shop.example',metadata=NULL WHERE id=4",
      );
      await database.pool.query(
        "INSERT INTO channels.channel_product_overrides(id,channel_id,product_id,is_listed) VALUES(1,34,20,0)",
      );
      await repository.expand(20, now);
      await verifyZero(database.pool, now);
      await database.pool.query(
        "UPDATE inventory.inventory_publication_targets SET provider_scope_type='location',external_scope_id='location-a'",
      );
      await database.pool.query(
        "UPDATE inventory.inventory_publication_readbacks SET provider_scope_type_snapshot='location',external_scope_id_snapshot='location-a',quantity_consistent=NULL",
      );
      await worker().processDue();
      expect((await rows())[0].state).toBe("not_applicable");
      expect(sync).not.toHaveBeenCalled();
    });
    it("preserves accepted receipt-first recovery before consulting exclusion", async () => {
      await exclude();
      const delivery = await claim();
      getByCommand.mockResolvedValue({
        id: "accepted-job",
        productId: 20,
        identity: {
          connectionId: 4,
          accountId: "seller-a",
          marketplaceId: "EBAY_US",
        },
      });
      const spy = vi.spyOn(lifecycle, "assess");
      expect(await handoff().handoff(delivery)).toMatchObject({
        state: "delivered",
        receipt: { operationId: "accepted-job" },
      });
      expect(spy).not.toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
    });
    it("keeps transport and fence failures retryable without inventing a terminal status", async () => {
      await exclude();
      const lock = await database.pool.connect();
      await lock.query("BEGIN");
      await lock.query("SELECT pg_advisory_xact_lock_shared(918419,0)");
      try {
        await worker().processDue();
        expect((await rows())[0]).toMatchObject({
          state: "pending",
          last_error_code: "LISTING_LIFECYCLE_EVIDENCE_BUSY",
        });
      } finally {
        await lock.query("ROLLBACK");
        lock.release();
      }
      now = new Date(now.getTime() + 60000);
      await worker().processDue();
      expect((await rows())[0].state).toBe("waiting_lifecycle");
    });
    it("preserves the last exclusion assessment when a later check cannot acquire the fence", async () => {
      await exclude();
      await worker().processDue();
      const before = (await rows())[0].lifecycle;
      now = new Date(now.getTime() + 60000);
      const lock = await database.pool.connect();
      await lock.query("BEGIN");
      await lock.query("SELECT pg_advisory_xact_lock_shared(918419,0)");
      try {
        await worker().processDue();
        const row = (await rows())[0];
        expect(row.state).toBe("waiting_lifecycle");
        expect(row.lifecycle).toEqual(before);
      } finally {
        await lock.query("ROLLBACK");
        lock.release();
      }
    });
    it("keeps superseded idle job history without treating it as outstanding execution", async () => {
      await exclude();
      await verifyZero(database.pool, now);
      await database.pool.query(
        "INSERT INTO channels.ebay_listing_sync_jobs(id,channel_id,connection_id,product_id,operation,state,identity,error_code) VALUES($1,34,4,20,'sync','needs_attention','{}','EBAY_SYNC_SOURCE_SUPERSEDED')",
        [randomUUID()],
      );
      await worker().processDue();
      expect((await rows())[0].state).toBe("not_applicable");
      expect(
        (
          await database.pool.query(
            "SELECT error_code FROM channels.ebay_listing_sync_jobs",
          )
        ).rows[0].error_code,
      ).toBe("EBAY_SYNC_SOURCE_SUPERSEDED");
    });
    it("rejects changed accounts rather than disposing another destination's work", async () => {
      await exclude();
      await database.pool.query(
        "UPDATE ebay.ebay_oauth_tokens SET external_account_id='other-seller'",
      );
      const delivery = await claim();
      expect(await handoff().handoff(delivery)).toMatchObject({
        state: "blocked",
        code: "LISTING_INTENT_LIFECYCLE_SCOPE_CHANGED",
      });
      expect(sync).not.toHaveBeenCalled();
    });
  },
);
