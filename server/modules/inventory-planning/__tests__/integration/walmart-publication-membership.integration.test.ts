import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../fixtures/inventory-cutover-composition-database.fixture";
import {
  installWalmartPublicationInventoryFixture,
  activateWalmartPublicationInventoryFixture,
  WALMART_INVENTORY_NOW,
} from "../fixtures/walmart-publication-inventory.fixture";
import { InventoryPublicationMembershipService } from "../../application/inventory-publication-membership.service";
import { PostgresInventoryPublicationMembershipStore } from "../../infrastructure/inventory-publication-membership.repository";
import {
  PostgresQuantityPublicationAdmission,
  quantityPublicationScopeLockKey,
} from "../../infrastructure/quantity-publication-admission.repository";
import {
  assertListingSetupZeroAdmission,
  type ListingSetupZeroIntent,
} from "../../application/listing-setup-zero-intent";
import {
  observeQuantityProviderRequest,
  recordQuantityProviderResponse,
} from "../../application/quantity-provider-request-evidence";
import { loadPublicationTargetScopes } from "../../infrastructure/inventory-publication-target-stop.repository";
import { InventoryPublicationTargetVariantHoldService } from "../../application/inventory-publication-target-variant-hold.service";
import { PostgresInventoryPublicationTargetVariantHoldStore } from "../../infrastructure/inventory-publication-target-variant-hold.repository";
import { PostgresInventoryPublicationOutboxRepository } from "../../infrastructure/inventory-publication-outbox.repository";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
const url = process.env.ECHELON_TEST_DATABASE_URL,
  disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;
dbDescribe.sequential(
  "selected Walmart inventory with real PostgreSQL migrations",
  () => {
    let database: InventoryCutoverTestDatabase,
      service: InventoryPublicationMembershipService,
      admission: PostgresQuantityPublicationAdmission;
    const intent = (
      variant = 102,
      sku = "NEW",
      operationId = `setup-${variant}`,
    ): ListingSetupZeroIntent => ({
      operationId,
      publicationTargetId: 2,
      expectedTargetRevision: "3",
      channelId: 36,
      channelConnectionId: 8,
      partnerId: "partner-36",
      environment: "production",
      shipNodeId: "test-location",
      items: [{ productVariantId: variant, sku, quantity: 0 }],
    });
    const inspectInput = () => ({
      channelId: 36,
      channelConnectionId: 8,
      partnerId: "partner-36",
      environment: "production" as const,
      shipNodeId: "test-location",
      items: intent().items,
    });
    beforeAll(async () => {
      database = await createInventoryCutoverTestDatabase(
        url,
        disposable,
        cutoverCompositionBaseSql,
      );
      await installWalmartPublicationInventoryFixture(database.pool);
      service = new InventoryPublicationMembershipService(
        new PostgresInventoryPublicationMembershipStore(database.pool),
        { now: () => WALMART_INVENTORY_NOW },
      );
      admission = new PostgresQuantityPublicationAdmission(
        database.pool,
        () => WALMART_INVENTORY_NOW,
      );
    }, 30000);
    afterAll(async () => {
      await database?.close();
    });
    it("preserves existing whole-product targets and starts new Walmart targets explicitly empty", async () => {
      expect(
        (
          await database.pool.query(
            "SELECT id,membership_mode FROM inventory.inventory_publication_targets ORDER BY id",
          )
        ).rows,
      ).toEqual([
        { id: 1, membership_mode: "whole_product" },
        { id: 2, membership_mode: "explicit" },
      ]);
      expect(
        (
          await database.pool.query(
            "SELECT * FROM inventory.publication_membership_heads",
          )
        ).rows,
      ).toEqual([]);
      await expect(
        database.pool.query(
          "UPDATE inventory.inventory_publication_targets SET membership_mode='whole_product',revision=revision+1 WHERE id=2",
        ),
      ).rejects.toThrow();
    });
    it("keeps activation a separate prerequisite and makes no setup scope or provider write under legacy", async () => {
      const provider = vi.fn();
      expect(
        await admission.inspectListingSetupZero(inspectInput()),
      ).toMatchObject({
        ready: false,
        publicationTargetId: 2,
        variants: [{ ready: false }],
      });
      await expect(
        admission.runListingSetupZero(intent(), provider),
      ).rejects.toMatchObject({ code: "PUBLICATION_SETUP_CANONICAL_REQUIRED" });
      expect(provider).not.toHaveBeenCalled();
      expect(
        (
          await database.pool.query(
            "SELECT * FROM inventory.publication_listing_setup_scopes",
          )
        ).rows,
      ).toEqual([]);
      await activateWalmartPublicationInventoryFixture(database.pool);
    });
    it("inspects new items without requiring mapping, but requires verified mapping for ATP membership", async () => {
      expect(
        await admission.inspectListingSetupZero(inspectInput()),
      ).toMatchObject({
        ready: true,
        targetRevision: "3",
        variants: [{ productVariantId: 102, ready: true }],
      });
      const membership = await service.inspect({
        channelId: 36,
        channelConnectionId: 8,
        productVariantIds: [102],
      });
      expect(membership.ready).toBe(false);
      expect(membership.blockers.map((row) => row.code)).toContain(
        "PUBLICATION_MAPPING_NOT_READY",
      );
      await expect(
        admission.runListingSetupZero(
          { ...intent(), shipNodeId: "wrong" },
          async () => undefined,
        ),
      ).rejects.toMatchObject({
        code: "PUBLICATION_SETUP_DESTINATION_NOT_READY",
      });
    });
    it("enforces the global stop without manufacturing quantity catch-up or setup attempts", async () => {
      await database.pool.query(
        "UPDATE channels.sync_settings SET global_enabled=false",
      );
      const provider = vi.fn();
      await expect(
        admission.runListingSetupZero(intent(), provider),
      ).rejects.toMatchObject({ code: "PUBLICATION_GLOBAL_STOP_ACTIVE" });
      expect(provider).not.toHaveBeenCalled();
      expect(
        (
          await database.pool.query(
            "SELECT * FROM inventory.quantity_publication_catchup",
          )
        ).rows,
      ).toEqual([]);
      await database.pool.query(
        "UPDATE channels.sync_settings SET global_enabled=true",
      );
    });
    it("uses exact channel SKU overrides and rejects inactive products", async () => {
      await database.pool.query(
        "INSERT INTO channels.channel_variant_overrides VALUES(36,105,'CHANNEL-FUTURE')",
      );
      const input = {
        ...inspectInput(),
        items: [
          {
            productVariantId: 105,
            sku: "CHANNEL-FUTURE",
            quantity: 0 as const,
          },
        ],
      };
      expect((await admission.inspectListingSetupZero(input)).ready).toBe(true);
      expect(
        (
          await admission.inspectListingSetupZero({
            ...input,
            items: [{ productVariantId: 105, sku: "FUTURE", quantity: 0 }],
          })
        ).variants[0].blockers,
      ).toMatchObject([{ code: "PUBLICATION_SETUP_VARIANT_CHANGED" }]);
      await database.pool.query(
        "UPDATE catalog.products SET status='draft' WHERE id=20",
      );
      expect((await admission.inspectListingSetupZero(input)).ready).toBe(
        false,
      );
      await database.pool.query(
        "UPDATE catalog.products SET status='active' WHERE id=20",
      );
      await database.pool.query(
        "INSERT INTO catalog.products(id,sku) VALUES(21,'NO-MODEL'); INSERT INTO catalog.product_variants(id,product_id,sku) VALUES(106,21,'NO-MODEL')",
      );
      const noModel = await admission.inspectListingSetupZero({
        ...inspectInput(),
        items: [{ productVariantId: 106, sku: "NO-MODEL", quantity: 0 }],
      });
      expect(noModel.ready).toBe(false);
      expect(noModel.variants[0].blockers).toMatchObject([
        { code: "PUBLICATION_SETUP_PRODUCT_MODEL_NOT_READY" },
      ]);
    });
    it("durably journals exact zero scopes before HTTP, fences concurrent writers and refuses blind resubmission", async () => {
      await admission.runListingSetupZero(intent(), async (validated) => {
        assertListingSetupZeroAdmission(validated);
        expect(
          (
            await database.pool.query(
              "SELECT desired_quantity,external_inventory_item_id FROM inventory.publication_listing_setup_scopes",
            )
          ).rows,
        ).toEqual([{ desired_quantity: 0, external_inventory_item_id: "NEW" }]);
        expect(
          (
            await database.pool.query(
              "SELECT owner_kind,state,outbox_id FROM inventory.quantity_publication_attempts",
            )
          ).rows,
        ).toEqual([
          {
            owner_kind: "listing_setup_zero",
            state: "running",
            outbox_id: null,
          },
        ]);
        const contender = await database.pool.connect();
        try {
          const key = quantityPublicationScopeLockKey({
            destinationKind: "channel_connection",
            connectionId: 8,
            providerKey: "walmart",
            providerScopeType: "location",
            externalScopeId: "test-location",
            externalInventoryItemId: "NEW",
            productId: null,
            productVariantId: 102,
          });
          expect(
            (
              await contender.query(
                "SELECT pg_try_advisory_lock(hashtextextended($1,918420)) AS acquired",
                [key],
              )
            ).rows[0].acquired,
          ).toBe(false);
        } finally {
          contender.release();
        }
        return observeQuantityProviderRequest(
          {
            method: "POST",
            path: "/v3/feeds?feedType=MP_ITEM",
            body: { quantity: 0 },
          },
          async () => {
            recordQuantityProviderResponse({
              outcome: "completed",
              httpStatus: 200,
              providerRequestId: "request-1",
              responseHash: "a".repeat(64),
              errorCodes: [],
              retryNotBefore: null,
              cooldownScope: null,
            });
            return { feedId: "feed-1" };
          },
        );
      });
      await expect(
        admission.runListingSetupZero(intent(), async () => undefined),
      ).rejects.toMatchObject({ code: "PUBLICATION_SETUP_ALREADY_SUBMITTED" });
      const client = await database.pool.connect();
      try {
        const scopes = await loadPublicationTargetScopes(client, {
          id: 2,
          channel_connection_id: 8,
          dropship_store_connection_id: null,
          destination_kind: "channel_connection",
          provider_key: "walmart",
          provider_scope_type: "location",
          external_scope_id: "test-location",
        });
        expect(scopes.map((row) => row.externalInventoryItemId)).toContain(
          "NEW",
        );
      } finally {
        client.release();
      }
      expect(
        (
          await database.pool.query(
            "SELECT path FROM inventory.quantity_provider_requests",
          )
        ).rows,
      ).toEqual([{ path: "/v3/feeds?feedType=MP_ITEM" }]);
    });
    it("keeps uncertain requests quarantined across a worker restart", async () => {
      const request = intent(103, "UNCERTAIN");
      await expect(
        admission.runListingSetupZero(request, () =>
          observeQuantityProviderRequest(
            {
              method: "POST",
              path: "/v3/feeds?feedType=MP_ITEM_MATCH",
              body: {},
            },
            async () => {
              throw Object.assign(new Error("lost response"), {
                effect: "not_sent",
              });
            },
          ),
        ),
      ).rejects.toThrow("lost response");
      await expect(
        new PostgresQuantityPublicationAdmission(
          database.pool,
          () => WALMART_INVENTORY_NOW,
        ).runListingSetupZero(request, async () => undefined),
      ).rejects.toMatchObject({ code: "PUBLICATION_PRIOR_OUTCOME_UNRESOLVED" });
      expect(
        (
          await database.pool.query(
            "SELECT state FROM inventory.quantity_publication_attempts WHERE listing_setup_operation_id=$1",
            [request.operationId],
          )
        ).rows,
      ).toEqual([{ state: "uncertain" }]);
    });
    it("permits reviewed new zero batches on the same identity, but never replays a completed batch", async () => {
      const request = intent(104, "REJECTED"),
        failure = Object.assign(new Error("Provider rejected request"), {
          code: "WALMART_REJECTED",
        });
      await expect(
        admission.runListingSetupZero(request, () =>
          observeQuantityProviderRequest(
            { method: "POST", path: "/v3/feeds?feedType=MP_ITEM", body: {} },
            async () => {
              recordQuantityProviderResponse({
                outcome: "rejected",
                httpStatus: 400,
                providerRequestId: "rejected-1",
                responseHash: "b".repeat(64),
                errorCodes: ["INVALID_REQUEST"],
                retryNotBefore: null,
                cooldownScope: null,
              });
              throw failure;
            },
          ),
        ),
      ).rejects.toBe(failure);
      await admission.runListingSetupZero(request, () =>
        observeQuantityProviderRequest(
          { method: "POST", path: "/v3/feeds?feedType=MP_ITEM", body: {} },
          async () => {
            recordQuantityProviderResponse({
              outcome: "completed",
              httpStatus: 200,
              providerRequestId: "completed-2",
              responseHash: "c".repeat(64),
              errorCodes: [],
              retryNotBefore: null,
              cooldownScope: null,
            });
          },
        ),
      );
      expect(
        (
          await database.pool.query(
            "SELECT state FROM inventory.quantity_publication_attempts WHERE listing_setup_operation_id=$1 ORDER BY id",
            [request.operationId],
          )
        ).rows,
      ).toEqual([{ state: "rejected" }, { state: "succeeded" }]);
      const corrected = { ...request, operationId: "corrected-batch" };
      await admission.runListingSetupZero(corrected, () =>
        observeQuantityProviderRequest(
          { method: "POST", path: "/v3/feeds?feedType=MP_ITEM", body: {} },
          async () => {
            recordQuantityProviderResponse({
              outcome: "completed",
              httpStatus: 200,
              providerRequestId: "corrected-3",
              responseHash: "e".repeat(64),
              errorCodes: [],
              retryNotBefore: null,
              cooldownScope: null,
            });
          },
        ),
      );
      await expect(
        admission.runListingSetupZero(corrected, async () => undefined),
      ).rejects.toMatchObject({ code: "PUBLICATION_SETUP_ALREADY_SUBMITTED" });
      expect(
        (
          await database.pool.query(
            "SELECT operation_id FROM inventory.publication_listing_setup_scopes WHERE product_variant_id=104 ORDER BY id",
          )
        ).rows,
      ).toEqual([
        { operation_id: request.operationId },
        { operation_id: "corrected-batch" },
      ]);
      await database.pool.query(
        "INSERT INTO channels.channel_variant_overrides VALUES(36,104,'REBOUND')",
      );
      await expect(
        admission.runListingSetupZero(
          {
            ...corrected,
            operationId: "rebind",
            items: [{ productVariantId: 104, sku: "REBOUND", quantity: 0 }],
          },
          async () => undefined,
        ),
      ).rejects.toMatchObject({ code: "PUBLICATION_SETUP_IDENTITY_CONFLICT" });
      await database.pool.query(
        "DELETE FROM channels.channel_variant_overrides WHERE product_variant_id=104",
      );
    });
    it("records explicit preflight no-request failure separately and allows a corrected new batch", async () => {
      const request = intent(105, "CHANNEL-FUTURE", "preflight-one");
      const error = Object.assign(
        new Error("Listing content rejected before HTTP"),
        { code: "WALMART_PREFLIGHT_INVALID", effect: "not_sent" },
      );
      await expect(
        admission.runListingSetupZero(request, async () => {
          throw error;
        }),
      ).rejects.toBe(error);
      expect(
        (
          await database.pool.query(
            "SELECT state,resolution_basis FROM inventory.quantity_publication_attempts WHERE listing_setup_operation_id=$1",
            [request.operationId],
          )
        ).rows,
      ).toEqual([
        { state: "not_sent", resolution_basis: "owner_preflight_no_request" },
      ]);
      expect(
        (
          await database.pool.query(
            "SELECT q.id FROM inventory.quantity_provider_requests q JOIN inventory.quantity_publication_attempts a ON a.id=q.attempt_id WHERE a.listing_setup_operation_id=$1",
            [request.operationId],
          )
        ).rows,
      ).toEqual([]);
      await expect(
        database.pool.query(
          "UPDATE inventory.quantity_publication_attempts SET state='running',completed_at=NULL WHERE listing_setup_operation_id=$1",
          [request.operationId],
        ),
      ).rejects.toThrow(/immutable/);
    });
    it("does not accept callback completion without a physical feed HTTP receipt", async () => {
      const request = intent(105, "CHANNEL-FUTURE");
      await expect(
        admission.runListingSetupZero(request, async () => ({
          feedId: "unproven",
        })),
      ).rejects.toMatchObject({
        code: "PUBLICATION_REQUEST_EVIDENCE_INCOMPLETE",
      });
      expect(
        (
          await database.pool.query(
            "SELECT state FROM inventory.quantity_publication_attempts WHERE listing_setup_operation_id=$1",
            [request.operationId],
          )
        ).rows,
      ).toEqual([{ state: "uncertain" }]);
      await expect(
        admission.runListingSetupZero(request, async () => undefined),
      ).rejects.toMatchObject({ code: "PUBLICATION_PRIOR_OUTCOME_UNRESOLVED" });
      await expect(
        admission.runListingSetupZero(
          { ...request, operationId: "new-but-uncertain" },
          async () => undefined,
        ),
      ).rejects.toMatchObject({ code: "PUBLICATION_PRIOR_OUTCOME_UNRESOLVED" });
    });
    it("seals exact selected membership, enqueues only it, and replays an immutable command receipt", async () => {
      const input = {
        publicationTargetId: 2,
        expectedTargetRevision: "3",
        changes: [{ productVariantId: 101, included: true }],
      };
      const review = await service.review(input);
      expect(review.ready).toBe(true);
      expect(review.quantities.map((row) => row.productVariantId)).toEqual([
        101,
      ]);
      const command = {
        ...input,
        expectedReviewHash: review.reviewHash,
        idempotencyKey: "membership-one",
      };
      await database.pool
        .query(`CREATE FUNCTION public.fail_membership_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='inventory_availability.publication_membership.applied' THEN RAISE EXCEPTION 'simulated audit storage failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_membership_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.fail_membership_audit()`);
      await expect(service.apply(command, "operator")).rejects.toThrow(
        "simulated audit storage failure",
      );
      expect(
        (
          await database.pool.query(
            "SELECT * FROM inventory.publication_membership_heads",
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await database.pool.query(
            "SELECT * FROM inventory.inventory_publication_outbox",
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await database.pool.query(
            "SELECT revision::text FROM inventory.inventory_publication_targets WHERE id=2",
          )
        ).rows[0].revision,
      ).toBe("3");
      await database.pool.query(
        "DROP TRIGGER fail_membership_audit ON public.audit_events; DROP FUNCTION public.fail_membership_audit()",
      );
      const receipt = await service.apply(command, "operator");
      expect(receipt).toMatchObject({
        revision: "4",
        changedProductVariantIds: [101],
        publicationRows: 1,
      });
      expect(await service.apply(command, "operator")).toEqual({
        ...receipt,
        alreadyApplied: true,
      });
      await expect(
        service.apply(
          { ...command, changes: [{ productVariantId: 102, included: true }] },
          "operator",
        ),
      ).rejects.toMatchObject({ code: "MEMBERSHIP_COMMAND_CONFLICT" });
      expect(
        (
          await database.pool.query(
            "SELECT DISTINCT product_variant_id FROM inventory.inventory_publication_outbox WHERE publication_target_id=2",
          )
        ).rows,
      ).toEqual([{ product_variant_id: 101 }]);
      await expect(
        database.pool.query(
          "UPDATE inventory.publication_membership_versions SET included=false",
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        database.pool.query(
          "DELETE FROM inventory.publication_membership_applications",
        ),
      ).rejects.toThrow(/append-only/);
    });
    it("requires a held current verified zero before removing a managed SKU and rejects stale review", async () => {
      const review = await service.review({
        publicationTargetId: 2,
        expectedTargetRevision: "4",
        changes: [{ productVariantId: 101, included: false }],
      });
      expect(review.ready).toBe(false);
      expect(review.blockers.map((row) => row.code)).toContain(
        "MEMBERSHIP_REMOVAL_REQUIRES_VERIFIED_ZERO",
      );
      await expect(
        service.apply(
          {
            publicationTargetId: 2,
            expectedTargetRevision: "3",
            changes: [{ productVariantId: 101, included: true }],
            expectedReviewHash: "b".repeat(64),
            idempotencyKey: "stale",
          },
          "operator",
        ),
      ).rejects.toMatchObject({ code: "MEMBERSHIP_REVIEW_STALE" });
    });
    it("holds stock at zero, suppresses a leased positive, verifies exact readback, then removes membership", async () => {
      let providerTime = WALMART_INVENTORY_NOW;
      async function advanceProviderClockToQueuedPublication(): Promise<void> {
        const queued = await database.pool.query<{ availableAt: Date }>(
          `SELECT available_at AS "availableAt"
           FROM inventory.inventory_publication_outbox
           WHERE publication_target_id=2 AND product_variant_id=101
             AND publication_phase='full' AND state='queued'`,
        );
        expect(queued.rows).toHaveLength(1);
        // Enqueue uses PostgreSQL transaction time, independently of the fixture
        // clock. Date truncates PostgreSQL microseconds, so advance to the next
        // millisecond without moving this worker clock backwards.
        const timestampPrecisionMarginMs = 1;
        providerTime = new Date(
          Math.max(
            providerTime.getTime(),
            queued.rows[0].availableAt.getTime() + timestampPrecisionMarginMs,
          ),
        );
      }
      const outbox = new PostgresInventoryPublicationOutboxRepository(
        database.pool,
      );
      await advanceProviderClockToQueuedPublication();
      const positiveClaims = await outbox.claimDue({
        batchSize: 10,
        leaseSeconds: 120,
        leaseToken: "positive-lease",
        now: providerTime,
      });
      expect(positiveClaims).toHaveLength(1);
      const [positive] = positiveClaims;
      expect(positive.desiredQuantity).not.toBe("0");
      const holds = new InventoryPublicationTargetVariantHoldService(
        new PostgresInventoryPublicationTargetVariantHoldStore(database.pool),
        { now: () => WALMART_INVENTORY_NOW },
      );
      await holds.holdVariants(
        {
          destination: {
            destinationKind: "channel_connection",
            connectionId: 8,
          },
          productVariantIds: [101],
          idempotencyKey: "hold-before-remove",
          reason: "Stop selected SKU before removing automatic stock",
        },
        "operator",
      );
      expect(
        (
          await database.pool.query(
            "SELECT state FROM inventory.inventory_publication_outbox WHERE id=$1",
            [positive.outboxId],
          )
        ).rows[0].state,
      ).toBe("superseded");
      const provider = vi.fn();
      await expect(
        new PostgresQuantityPublicationAdmission(
          database.pool,
          () => providerTime,
        ).runOutbox(positive, provider),
      ).rejects.toThrow();
      expect(provider).not.toHaveBeenCalled();
      const before = await service.review({
        publicationTargetId: 2,
        expectedTargetRevision: "5",
        changes: [{ productVariantId: 101, included: false }],
      });
      expect(before.ready).toBe(false);
      await advanceProviderClockToQueuedPublication();
      const zeroClaims = await outbox.claimDue({
        batchSize: 10,
        leaseSeconds: 120,
        leaseToken: "zero-lease",
        now: providerTime,
      });
      expect(zeroClaims).toHaveLength(1);
      const [zero] = zeroClaims;
      expect(zero.desiredQuantity).toBe("0");
      await new PostgresQuantityPublicationAdmission(
        database.pool,
        () => providerTime,
      ).runOutbox(zero, () =>
        observeQuantityProviderRequest(
          {
            method: "PUT",
            path: "/v3/inventory?sku=P5&shipNode=test-location",
            body: { quantity: 0 },
          },
          async () => {
            recordQuantityProviderResponse({
              outcome: "completed",
              httpStatus: 200,
              providerRequestId: "zero-1",
              responseHash: "d".repeat(64),
              errorCodes: [],
              retryNotBefore: null,
              cooldownScope: null,
            });
          },
        ),
      );
      expect(
        await outbox.recordVerified(zero, {
          observedQuantity: 0,
          providerResponse: { sku: "P5", quantity: 0 },
          completedAt: providerTime,
        }),
      ).toBe("verified");
      const input = {
        publicationTargetId: 2,
        expectedTargetRevision: "5",
        changes: [{ productVariantId: 101, included: false }],
      };
      const review = await service.review(input);
      expect(review.ready).toBe(true);
      const receipt = await service.apply(
        {
          ...input,
          expectedReviewHash: review.reviewHash,
          idempotencyKey: "remove-after-zero",
        },
        "operator",
      );
      expect(receipt).toMatchObject({
        revision: "6",
        changedProductVariantIds: [101],
        publicationRows: 0,
      });
      expect(
        (
          await database.pool.query(
            `SELECT v.included FROM inventory.publication_membership_heads h JOIN inventory.publication_membership_versions v ON v.id=h.active_version_id WHERE h.publication_target_id=2`,
          )
        ).rows,
      ).toEqual([{ included: false }]);
      expect(
        (
          await database.pool.query(
            "SELECT id FROM inventory.inventory_publication_outbox WHERE publication_target_id=2 AND state IN ('queued','leased','retryable','desired','drifted')",
          )
        ).rows,
      ).toEqual([]);
    });
  },
);
