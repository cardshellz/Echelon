import { describe, expect, it, vi } from "vitest";

vi.mock("../../../notifications/in-app-notifications.api", () => ({
  notify: vi.fn(async () => undefined),
}));
vi.mock("../../../warehouse/settings.api", () => ({
  getSettingsForWarehouse: vi.fn(async () => null),
}));

import { cycleCounts, inventoryLevels, replenTasks } from "@shared/schema";
import { ReplenishmentUseCases } from "../../../inventory/application/replenishment.use-cases";
import { legacyTransformationExecutionAuthority } from "../../../inventory/application/transformation-execution-authority.port";
import { resolveReplenishmentAutoExecution } from "../../../inventory/domain/replenishment-auto-execution";
import {
  isReplaceableRemoteConversion,
  selectRemoteConversionsToReplace,
} from "../../../inventory-planning/domain/claim-remote-conversion-replacement";
import type { InventoryAvailabilityRuntimeClaimContext } from "../../../inventory-planning/application/inventory-availability-runtime-claim.service";
import { PickingUseCases } from "../../application/picking.use-cases";

function makeOrderItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 501,
    orderId: 901,
    sku: "SLV-P25",
    name: "Sleeves Pack of 25",
    quantity: 2,
    pickedQuantity: 0,
    fulfilledQuantity: 0,
    requiresShipping: 1,
    location: "A-01",
    status: "pending",
    shortReason: null,
    onHold: false,
    productId: 101,
    catalogProductId: 10,
    inventoryTracking: true,
    pickedAt: null,
    ...overrides,
  } as any;
}

describe("WH-7: Unified Pick, Replenishment & Single-Owner Inline Case-Break", () => {
  describe("1. Retired max_qty & hybrid inline threshold enforcement", () => {
    it("always computes 1 destination trigger unit unless an active pick shortfall exceeds 1, ignoring legacy max_qty", () => {
      const service = new ReplenishmentUseCases(
        {} as any,
        {} as any,
        () => new Date("2026-11-26T12:00:00Z"),
        legacyTransformationExecutionAuthority,
      );
      expect(service.calculateQtyNeeded(50, 10, 0)).toBe(1);
      expect(service.calculateQtyNeeded(100, 0, 0)).toBe(1);
      expect(service.calculateQtyNeeded(null, 5, 2)).toBe(1);
      expect(service.calculateQtyNeeded(50, 0, 0, 25)).toBe(25);
    });

    it("keeps 100-unit and 1,000-unit case breaks inline in hybrid and inline modes while honoring queue mode", () => {
      expect(
        resolveReplenishmentAutoExecution(
          null,
          null,
          { replenMode: "hybrid", inlineReplenMaxUnits: 100 },
          500,
          "case_break",
        ),
      ).toEqual({ shouldAutoExecute: true, executionMode: "inline" });

      expect(
        resolveReplenishmentAutoExecution(
          null,
          null,
          { replenMode: "queue" },
          500,
          "case_break",
        ),
      ).toEqual({ shouldAutoExecute: false, executionMode: "queue" });
    });
  });

  describe("2. Zero silent background or post-pick inline cross-bin auto-moves", () => {
    it("skips inline replenishment on background proactive_sweep/event_driven and post-pick queueOnly while queueing pallet_drop / queue tasks", async () => {
      const inserts: Array<{ table: unknown; value: any }> = [];
      const db = {
        select: vi.fn(() => ({
          from: () => ({
            where: () => ({
              limit: vi.fn(async () => [{ id: 1, code: "A-01", warehouseId: 1, productId: 10, sku: "SLV-P25" }]),
            }),
          }),
        })),
        insert: vi.fn((table: unknown) => ({
          values: vi.fn((value: any) => {
            inserts.push({ table, value });
            return {
              returning: vi.fn(async () => [{ id: 777, revision: 0, ...value }]),
            };
          }),
        })),
        execute: vi.fn(async () => ({ rows: [{ variant_qty: 1 }] })),
        transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(db)),
      };
      const service = new ReplenishmentUseCases(
        db as any,
        {} as any,
        () => new Date("2026-11-26T12:00:00Z"),
        legacyTransformationExecutionAuthority,
      );
      const executeSpy = vi.spyOn(service, "executeTask");

      vi.spyOn(service as any, "priorTriggeredTask").mockResolvedValue(null);
      vi.spyOn(service as any, "rememberTriggeredTask").mockResolvedValue(undefined);
      vi.spyOn(service as any, "findActiveTaskForPickBin").mockResolvedValue(null);
      vi.spyOn(service as any, "findRuleForVariant").mockResolvedValue(null);
      vi.spyOn(service as any, "getTaskById").mockImplementation(async (id: unknown) => ({
        id: Number(id),
        status: "pending",
        executionMode: "queue",
        replenMethod: "pallet_drop",
      }) as any);

      vi.spyOn(service as any, "evaluateReplenNeed").mockResolvedValue({
        status: "needed_with_source",
        level: { variantQty: 0 },
        location: { id: 1, code: "A-01", warehouseId: 1 },
        variant: { id: 101, sku: "SLV-P25", productId: 10 },
        whSettings: null,
        params: {
          replenMethod: "case_break",
          priority: 5,
          sourceLocationType: "reserve",
          sourcePriority: "fifo",
          autoReplen: 1,
        },
        taskNotes: "Below threshold",
        sourceResolutionIssue: null,
        rule: null,
        resolvedSourceVariantId: 201,
        sourceLocation: { id: 2, code: "R-10", warehouseId: 1, isPickable: 0 },
        sourceVariant: { id: 201, sku: "SLV-C500", unitsPerVariant: 500 },
        qtySourceUnits: 1,
        qtyTargetUnits: 500,
        executionMode: "inline",
        shouldAutoExecute: true,
        triggerValue: 0,
        evaluatedQty: 0,
      });

      expect(await service.checkAndTriggerAfterPick(101, 1, "proactive_sweep")).toBeNull();
      expect(await service.checkAndTriggerAfterPick(101, 1, "event_driven")).toBeNull();
      expect(
        await service.createAndExecuteReplen(101, 1, "picker-1", {
          orderId: 901,
          orderItemId: 501,
          queueOnly: true,
        }),
      ).toBeNull();
      expect(inserts).toHaveLength(0);
      expect(executeSpy).not.toHaveBeenCalled();

      // Queued pallet_drop still creates a pending task ahead of empty!
      vi.spyOn(service, "checkReplenNeeded").mockResolvedValue({
        needed: true,
        stockout: false,
        sourceLocationId: 3,
        sourceLocationCode: "PALLET-01",
        sourceVariantId: 201,
        sourceVariantSku: "SLV-C500",
        sourceVariantName: "Case of 20 Packs",
        pickVariantId: 101,
        qtySourceUnits: 1,
        qtyTargetUnits: 500,
        replenMethod: "pallet_drop",
        executionMode: "queue",
        taskNotes: "Coverage low",
        triggerValue: 3,
        autoReplen: 2,
        evaluatedQty: 1,
        observedVariantQty: 1,
      });
      const queued = await service.createAndExecuteReplen(101, 1, "picker-1", {
        orderId: 901,
        orderItemId: 501,
        queueOnly: true,
      });
      expect(queued?.task).toMatchObject({ status: "pending", executionMode: "queue", replenMethod: "pallet_drop" });
      expect(inserts.filter((i) => i.table === replenTasks)).toHaveLength(1);
      expect(executeSpy).not.toHaveBeenCalled();
    });
  });

  describe("3. Canonical last-case reserved prediction (no false 'No source stock')", () => {
    it("surfaces this order's own claim-reserved case in R-10 instead of reporting stockout", async () => {
      const db = {
        select: vi.fn(() => ({
          from: (table: unknown) => ({
            where: () => ({
              limit: vi.fn(async () =>
                table === inventoryLevels ? [{ variantQty: 0, reservedQty: 0 }] : [],
              ),
            }),
          }),
        })),
      };
      const service = new ReplenishmentUseCases(
        db as any,
        {} as any,
        () => new Date("2026-11-26T12:00:00Z"),
        legacyTransformationExecutionAuthority,
      );
      // Free stock check sees 0 unreserved cases (`stockout: true`) because R-10's 1 case is reserved by Order 901!
      vi.spyOn(service, "checkReplenNeeded").mockResolvedValue({
        needed: true,
        stockout: true,
        sourceLocationId: null,
        sourceLocationCode: null,
        sourceVariantId: null,
        sourceVariantSku: null,
        sourceVariantName: null,
        pickVariantId: 101,
        qtySourceUnits: 0,
        qtyTargetUnits: 0,
        replenMethod: "case_break",
        executionMode: "inline",
        taskNotes: "No free stock",
        triggerValue: 0,
        autoReplen: 1,
        evaluatedQty: 0,
      });
      vi.spyOn(service, "loadActiveClaimInlineConversionSource").mockResolvedValue({
        locationId: 10,
        locationCode: "R-10",
        variantId: 201,
        variantSku: "SLV-C500",
        variantName: "Case of 20 Packs",
        unitsPerVariant: 20,
        claimedQty: 1,
        freeQty: 0,
        outputQty: 20,
        replenMethod: "case_break",
      });
      vi.spyOn(service, "listEligibleReplenSources").mockResolvedValue([
        {
          locationId: 10,
          locationCode: "R-10",
          variantId: 201,
          variantSku: "SLV-C500",
          variantName: "Case of 20 Packs",
          availableQty: 1,
          unitsPerVariant: 20,
          qtySourceUnits: 1,
          qtyTargetUnits: 20,
          replenMethod: "case_break",
        },
      ]);

      const prediction = await service.predictReplenAfterPick(101, 1, 2, {
        orderId: 901,
        orderItemId: 501,
      });

      expect(prediction).toMatchObject({
        replenNeeded: true,
        stockout: false,
        sourceLocationId: 10,
        sourceLocationCode: "R-10",
        sourceQty: 1,
        qtySourceUnits: 1,
      });
    });
  });

  describe("4. Unified Yes/No Inline Case-Break Flow & Zero Double-Break", () => {
    it("prompts case_break_confirmation_required, executes ONLY 1 canonical break on YES, and skips break + queues draft Cycle Count on NO", async () => {
      const beforeItem = makeOrderItem({ quantity: 2, pickedQuantity: 0, status: "pending" });
      const completedItem = makeOrderItem({ quantity: 2, pickedQuantity: 2, status: "completed" });
      const binState = { variantQty: 0, reservedQty: 0 };
      const draftCounts: any[] = [];

      const pickClaimLine = vi.fn(async () => ({
        outcome: "picked" as const,
        warehouseLocationIds: [1],
      }));
      const context: InventoryAvailabilityRuntimeClaimContext = {
        authority: "canonical",
        authorityRevision: "2",
        activationRunId: "1",
        legacy: {} as any,
        canonical: { pickClaimLine } as any,
        getLatestClaim: vi.fn(async () => ({
          claimId: "99",
          revision: 1,
          status: "active" as const,
          plan: {
            lines: [{ lineKey: "order-item:501", plannedQty: "2" }],
            operations: [
              {
                lineKey: "order-item:501",
                operationKey: "op:break:501",
                operationType: "break_pack",
                outputQty: "20",
                committedOutputQty: "2",
              },
            ],
            resourceClaims: [
              {
                lineKey: "order-item:501",
                consumerOperationKey: "op:break:501",
                warehouseLocationId: 10,
                sourceVariantId: 201,
                claimedQty: "1",
              },
            ],
          } as any,
        })),
        getClaimLinePickMovementCursor: vi.fn(async () => "cursor-1"),
        getVariantMetadata: vi.fn(async () => new Map()),
        getOrderIdByShopifyOrderId: vi.fn(async () => null),
      };

      const db = {
        execute: vi.fn(async () => ({ rows: [] })),
        insert: vi.fn((table: unknown) => ({
          values: vi.fn((val: any) => {
            if (table === cycleCounts) draftCounts.push(val);
            return { returning: vi.fn(async () => [{ id: 401 }]) };
          }),
        })),
      };
      const inventoryCore = {
        getLevel: vi.fn(async () => ({ productVariantId: 101, warehouseLocationId: 1, ...binState })),
        adjustInventory: vi.fn(async ({ qtyDelta }: { qtyDelta: number }) => {
          binState.variantQty += qtyDelta;
        }),
      };
      const replenishment = {
        loadActiveClaimInlineConversionSource: vi.fn(async () => ({
          locationId: 10,
          locationCode: "R-10",
          variantId: 201,
          variantSku: "SLV-C500",
          variantName: "Case of 20 Packs",
          unitsPerVariant: 20,
          claimedQty: 1,
          freeQty: 1,
          outputQty: 20,
          replenMethod: "case_break",
        })),
        listEligibleReplenSources: vi.fn(async () => [
          {
            locationId: 10,
            locationCode: "R-10",
            variantId: 201,
            variantSku: "SLV-C500",
            variantName: "Case of 20 Packs",
            availableQty: 2,
            unitsPerVariant: 20,
            qtySourceUnits: 1,
            qtyTargetUnits: 20,
            replenMethod: "case_break",
          },
          {
            locationId: 11,
            locationCode: "R-11",
            variantId: 201,
            variantSku: "SLV-C500",
            variantName: "Case of 20 Packs",
            availableQty: 3,
            unitsPerVariant: 20,
            qtySourceUnits: 1,
            qtyTargetUnits: 20,
            replenMethod: "case_break",
          },
        ]),
        checkReplenNeeded: vi.fn(),
        createAndExecuteReplen: vi.fn(),
      };
      const storage = {
        getProductVariantById: vi.fn(async () => ({
          id: 101,
          sku: "SLV-P25",
          productId: 10,
          requiresShipping: true,
          trackInventory: true,
        })),
        getInventoryLevelsByProductVariantId: vi.fn(async () => [
          { warehouseLocationId: 1, ...binState },
        ]),
        getAllWarehouseLocations: vi.fn(async () => [
          { id: 1, code: "A-01", warehouseId: 1, isPickable: 1, isActive: 1, cycleCountFreezeId: null, locationType: "pick" },
          { id: 10, code: "R-10", warehouseId: 1, isPickable: 0, isActive: 1, cycleCountFreezeId: null, locationType: "reserve" },
          { id: 11, code: "R-11", warehouseId: 1, isPickable: 0, isActive: 1, cycleCountFreezeId: null, locationType: "reserve" },
        ]),
        getOrderItemById: vi.fn(async () => completedItem),
      };

      const service = new PickingUseCases(db as any, inventoryCore as any, replenishment as any, storage as any);

      // Step A: Unconfirmed scan -> prompts Yes/No modal (`case_break_confirmation_required`)
      const promptRes = await (service as any).applyCanonicalPickProgress(context, {
        itemId: 501,
        beforeItem,
        status: "completed",
        effectivePickedQuantity: 2,
        warehouseId: 1,
        userId: "picker-1",
        pickMethod: "scan",
        confirmFoundOnShelf: false,
      });
      expect(promptRes.deductResult).toMatchObject({
        success: false,
        error: "case_break_confirmation_required",
        locationCode: "A-01",
        systemQty: 0,
        caseBreak: expect.objectContaining({
          sourceLocationCode: "R-10",
          qtySourceUnits: 1,
        }),
      });
      expect(pickClaimLine).not.toHaveBeenCalled();
      expect(replenishment.createAndExecuteReplen).not.toHaveBeenCalled();

      // Step B: `[ YES ]` (`confirmCaseBreak: true`, picker selected alternate R-11) ->
      // NEVER calls `replenishment.createAndExecuteReplen` (zero double-break!), passes preferredConversionSourceLocationId=11
      const yesRes = await (service as any).applyCanonicalPickProgress(context, {
        itemId: 501,
        beforeItem,
        status: "completed",
        effectivePickedQuantity: 2,
        warehouseId: 1,
        userId: "picker-1",
        pickMethod: "scan",
        replenSourceLocationId: 11,
        confirmFoundOnShelf: false,
        confirmCaseBreak: true,
      });
      expect(yesRes.deductResult).toMatchObject({ success: true, authority: "canonical" });
      expect(replenishment.createAndExecuteReplen).not.toHaveBeenCalled();
      expect(pickClaimLine).toHaveBeenCalledTimes(1);
      expect(pickClaimLine).toHaveBeenLastCalledWith(
        expect.objectContaining({
          locationStrategy: "strict",
          preferredConversionSourceLocationId: 11,
        }),
      );
      expect(draftCounts).toHaveLength(0);

      // Step C: `[ NO — Stock Was in A-01 ]` (`confirmCaseBreak: false`) ->
      // Skips case break, adds +2 to A-01, reconciles recorded stock with `skipPackageConversions: true`,
      // and queues a non-freezing `draft` Cycle Count for `A-01,R-10`!
      const noRes = await (service as any).applyCanonicalPickProgress(context, {
        itemId: 501,
        beforeItem,
        status: "completed",
        effectivePickedQuantity: 2,
        warehouseId: 1,
        userId: "picker-1",
        pickMethod: "scan",
        confirmFoundOnShelf: false,
        confirmCaseBreak: false,
      });
      expect(noRes.deductResult).toMatchObject({
        success: true,
        authority: "canonical",
        autoResolved: expect.objectContaining({
          adjustment: 2,
          pickedQty: 2,
        }),
      });
      expect(inventoryCore.adjustInventory).toHaveBeenCalledWith(
        expect.objectContaining({
          productVariantId: 101,
          warehouseLocationId: 1,
          qtyDelta: 2,
          reason: expect.stringContaining("case_break_skipped_found_in_pick_bin:"),
        }),
      );
      expect(pickClaimLine).toHaveBeenLastCalledWith(
        expect.objectContaining({
          locationStrategy: "reconcile_recorded_stock",
          skipPackageConversions: true,
        }),
      );
      expect(draftCounts).toHaveLength(1);
      expect(draftCounts[0]).toMatchObject({
        status: "draft",
        locationCodes: "A-01,R-10",
      });
    });

    it("allows replacing an untouched same-warehouse break_pack operation when allowSameWarehouse=true", () => {
      const candidate = {
        operationKey: "op:break:501",
        parentOperationKey: null,
        warehouseId: 1,
        operationType: "break_pack",
        status: "ready",
        destinationVariantId: 101,
        plannedExecutions: BigInt(1),
        executedExecutions: BigInt(0),
        releasedExecutions: BigInt(0),
        committedOutputQty: BigInt(2),
        hasChildOperation: false,
        hasBuildHandoff: false,
        hasProducedResource: false,
        inputResources: [{ claimedQty: BigInt(1), releasedQty: BigInt(0), consumedQty: BigInt(0), pickedQty: BigInt(0) }],
      };
      expect(isReplaceableRemoteConversion(candidate, 1, 101, false)).toBe(false);
      expect(isReplaceableRemoteConversion(candidate, 1, 101, true)).toBe(true);
      expect(
        selectRemoteConversionsToReplace({
          candidates: [candidate],
          pickWarehouseId: 1,
          targetVariantId: 101,
          requiredQty: BigInt(2),
          allowSameWarehouse: true,
        }),
      ).toEqual({
        operationKeys: ["op:break:501"],
        replacedTargetQty: BigInt(2),
      });
    });
  });

  describe("5. Canonical Short-Pick Spot-Count Zeroing & Reserve Discrepancy Count", () => {
    it("zeroes phantom stock including this shorted order's canonical claim via reconcileCycleCountInventory without touching other orders", async () => {
      const pickLocation = { id: 1, code: "A-01", warehouseId: 1, isPickable: 1, cycleCountFreezeId: null };
      // 5 physical in DB: 2 claimed by THIS shorted order (#901), 2 claimed by ANOTHER order (#902), 1 unreserved phantom
      const binState = { variantQty: 5, reservedQty: 4 };
      const insertedCounts: any[] = [];

      const reservation = {
        releaseOrderReservation: vi.fn(async () => ({ released: 0, failed: [] })),
        releaseOrderItemReservation: vi.fn(async () => {
          throw Object.assign(new Error("Canonical item release unsupported"), {
            code: "CANONICAL_ITEM_RELEASE_UNSUPPORTED",
          });
        }),
        reconcileCycleCountInventory: vi.fn(async ({ countedQty }: { countedQty: number }) => {
          const before = binState.variantQty;
          binState.variantQty = countedQty;
          binState.reservedQty = countedQty;
          return {
            quantityBefore: before,
            quantityAfter: countedQty,
            quantityDelta: countedQty - before,
            displacedOrderIds: [901],
          };
        }),
      };

      const db = {
        select: vi.fn(() => ({
          from: () => ({
            where: () => ({
              limit: vi.fn(async () => [pickLocation]),
            }),
          }),
        })),
        execute: vi.fn(async (query: any) => {
          const text = JSON.stringify(query);
          if (text.includes("to_regclass('inventory.availability_claims')")) {
            return { rows: [{ reg: "inventory.availability_claims" }] };
          }
          if (text.includes("availability_claim_resources")) {
            return { rows: [{ open_qty: 2 }] };
          }
          return { rows: [] };
        }),
        insert: vi.fn((table: unknown) => ({
          values: vi.fn((val: any) => {
            if (table === cycleCounts) insertedCounts.push(val);
            return {
              returning: vi.fn(async () => [{ id: 800 + insertedCounts.length }]),
              then: (resolve: (v: any) => void) => Promise.resolve().then(resolve),
            };
          }),
        })),
      };

      const inventoryCore = {
        getLevel: vi.fn(async () => ({ productVariantId: 101, warehouseLocationId: 1, ...binState })),
        adjustInventory: vi.fn(),
        pickItem: vi.fn(),
        logTransaction: vi.fn(),
      };
      const storage = {
        getOrderById: vi.fn(async () => ({ id: 901, orderNumber: "#901", warehouseId: 1, assignedPickerId: "picker-1" })),
        getUser: vi.fn(async () => ({ id: "picker-1", username: "picker" })),
        getProductVariantBySku: vi.fn(async () => ({ id: 101, sku: "SLV-P25", productId: 10 })),
        createPickingLog: vi.fn(async () => ({})),
        getAllWarehouseSettings: vi.fn(async () => [{ warehouseId: 1, postPickStatus: "ready_to_ship" }]),
        updateOrderProgress: vi.fn(async () => ({ id: 901, warehouseStatus: "exception" })),
      };
      const replenishment = {
        ensureQueuedReplenForShortPick: vi.fn(async () => null),
        loadActiveClaimInlineConversionSource: vi.fn(async () => null),
        resolveDedicatedReplenBin: vi.fn(async () => ({ locationId: 10, locationCode: "R-10" })),
      };

      const service = new PickingUseCases(
        db as any,
        inventoryCore as any,
        replenishment as any,
        storage as any,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        () => new Date("2026-11-26T12:00:00Z"),
        reservation as any,
      );

      const beforeItem = makeOrderItem({ status: "pending", pickedQuantity: 0, quantity: 2 });
      const shortedItem = makeOrderItem({ status: "short", pickedQuantity: 0, quantity: 2, shortReason: "out_of_stock" });

      await (service as any).finishCommittedPick({
        beforeItem,
        item: shortedItem,
        pickDeductResult: null,
        params: {
          status: "short",
          pickedQuantity: 0,
          shortReason: "out_of_stock",
          pickMethod: "short",
          userId: "picker-1",
        },
      });

      // Zeroed 3 phantom units (1 free + 2 from shorted order #901), leaving 2 intact for order #902!
      expect(reservation.reconcileCycleCountInventory).toHaveBeenCalledWith(
        expect.objectContaining({
          productVariantId: 101,
          warehouseLocationId: 1,
          countedQty: 2,
          reasonCode: "short_pick_out_of_stock",
        }),
      );
      expect(binState.variantQty).toBe(2);
      // Also queued a non-freezing `draft` Cycle Count on R-10 because Reserve showed stock!
      expect(insertedCounts.some((c) => c.status === "draft" && c.locationCodes === "R-10")).toBe(true);
    });
  });
});
