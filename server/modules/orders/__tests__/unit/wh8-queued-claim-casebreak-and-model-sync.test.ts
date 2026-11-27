import { describe, expect, it, vi } from "vitest";
import { canonicalAvailabilityClaimOperationExecutionCommandSchema } from "@shared/types/inventory-availability-claims";
import { buildAutoSyncedPackagingModelDefinition } from "../../../inventory-planning/catalog-packaging-model-sync.api";
import { tryReplaceUntouchedConversionWithAvailablePickBinStock } from "../../../inventory-planning/infrastructure/claim-repository/claim-pick-reconciliation";
import { ReplenishmentUseCases } from "../../../inventory/application/replenishment.use-cases";
import { PickingUseCases } from "../../application/picking.use-cases";

describe("WH-8: Queue-Mode Canonical Claim Case Breaks, Surplus Reuse & Packaging Model Auto-Sync", () => {
  describe("1. Canonical Claim Package Operation Source Rebinding Contract", () => {
    it("accepts preferredSourceLocationId on canonicalAvailabilityClaimOperationExecutionCommandSchema", () => {
      const parsed = canonicalAvailabilityClaimOperationExecutionCommandSchema.parse({
        claimId: "901",
        operationKey: "op:break:case-to-pack",
        idempotencyKey: "replen-task-claim-op:42:901:op:break:case-to-pack",
        actor: "user:replenisher-1",
        reason: "Replen task #42 (case_break)",
        preferredSourceLocationId: 211,
      });
      expect(parsed.preferredSourceLocationId).toBe(211);
    });
  });

  describe("2. Queue-Mode Canonical Claim Task Discovery & Claim-Backed Execution", () => {
    it("creates a deduplicated pending queue replen_task when the sole Reserve case is reserved by an active Canonical Claim", async () => {
      const insertedValues: any[] = [];
      const mockTx = {
        execute: vi.fn().mockResolvedValue({ rows: [] }),
        select: vi.fn(() => ({
          from: () => ({
            where: () => ({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        })),
        insert: vi.fn(() => ({
          values: (vals: any) => {
            insertedValues.push(vals);
            return {
              returning: vi.fn().mockResolvedValue([{ id: 777 }]),
            };
          },
        })),
      };

      const mockDb = {
        execute: vi
          .fn()
          // 1. tableCheck
          .mockResolvedValueOnce({ rows: [{ ok: 1 }] })
          // 2. staleRes
          .mockResolvedValueOnce({ rows: [] })
          // 3. candidatesRes — 1 case in R-10 reserved by claim #901, 0 free packs in A-01
          .mockResolvedValueOnce({
            rows: [
              {
                claim_id: "901",
                order_id: 5001,
                order_number: "#ORD-5001",
                order_item_id: 6001,
                operation_key: "op:break:c20-to-p1",
                operation_type: "break_pack",
                warehouse_id: 1,
                output_location_id: 101,
                destination_variant_id: 11,
                output_qty: 20,
                committed_output_qty: 2,
                source_location_id: 210,
                source_variant_id: 12,
                claimed_source_qty: 1,
                dest_product_id: 5,
                dest_units_per_variant: 1,
                dest_hierarchy_level: 1,
                free_dest_qty: 0,
              },
            ],
          }),
        transaction: vi.fn((fn: any) => fn(mockTx)),
        select: vi.fn(() => ({
          from: () => ({
            where: () => ({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        })),
      };

      const transformationAuthority = {
        readRuntime: vi.fn().mockResolvedValue({
          authority: "canonical",
          authorityRevision: "1",
          activationRunId: "1",
        }),
      } as any;

      const replen = new ReplenishmentUseCases(
        mockDb as any,
        {} as any,
        () => new Date("2026-11-27T14:00:00Z"),
        transformationAuthority,
      );
      vi.spyOn(replen as any, "findRuleForVariant").mockResolvedValue({
        id: 33,
        autoReplen: 2, // Force queue (dedicated replenisher)
        priority: 2,
      });
      vi.spyOn(replen as any, "findTierDefaultForVariant").mockResolvedValue(null);
      vi.spyOn(replen, "getSettingsForWarehouse").mockResolvedValue({
        replenMode: "queue",
      } as any);

      const syncResult = await replen.syncQueuedClaimConversionTasks({ orderId: 5001 });
      expect(syncResult.createdTaskIds).toEqual([777]);
      expect(insertedValues).toHaveLength(1);
      expect(insertedValues[0]).toMatchObject({
        replenRuleId: 33,
        fromLocationId: 210,
        toLocationId: 101,
        productId: 5,
        orderId: 5001,
        orderItemId: 6001,
        sourceProductVariantId: 12,
        pickProductVariantId: 11,
        qtySourceUnits: 1,
        qtyTargetUnits: 20,
        status: "pending",
        executionMode: "queue",
        replenMethod: "case_break",
        triggeredBy: "canonical_claim_queue",
        blocksShipment: true,
      });
    });

    it("executes a queued claim-backed replen_task via claimPackageExecutor (including source-bin rebind R-10 -> R-11) without failing on reserved stock", async () => {
      const updatedTaskSets: any[] = [];
      const executePackageOperation = vi.fn().mockResolvedValue({
        claimId: "901",
        operationKey: "op:break:c20-to-p1",
        status: "completed",
      });

      const taskRow = {
        id: 777,
        status: "pending",
        fromLocationId: 211, // Worker switched from R-10 (210) to R-11 (211)!
        toLocationId: 101,
        sourceProductVariantId: 12,
        pickProductVariantId: 11,
        orderId: 5001,
        orderItemId: 6001,
        qtySourceUnits: 1,
        qtyTargetUnits: 20,
        qtyCompleted: 0,
        replenMethod: "case_break",
        executionMode: "queue",
        assignedTo: null,
      };

      const mockTx = {
        execute: vi.fn().mockResolvedValue({
          rows: [{ id: 777, status: "pending", qty_completed: 0, assigned_to: null }],
        }),
        update: vi.fn(() => ({
          set: (vals: any) => {
            updatedTaskSets.push(vals);
            return {
              where: vi.fn().mockResolvedValue([]),
            };
          },
        })),
        insert: vi.fn(() => ({
          values: () => ({
            onConflictDoUpdate: vi.fn().mockResolvedValue([]),
            onConflictDoNothing: vi.fn().mockResolvedValue([]),
          }),
        })),
      };

      const mockDb = {
        select: vi.fn(() => ({
          from: () => ({
            where: () => ({
              limit: vi.fn().mockResolvedValue([taskRow]),
            }),
          }),
        })),
        execute: vi
          .fn()
          // 1. tableCheck inside findOpenClaimOperationForReplenTask
          .mockResolvedValueOnce({ rows: [{ ok: 1 }] })
          // 2. matched claim op query
          .mockResolvedValueOnce({
            rows: [
              {
                claim_id: "901",
                order_id: 5001,
                order_item_id: 6001,
                operation_key: "op:break:c20-to-p1",
                source_location_id: 210,
                source_variant_id: 12,
                claimed_source_qty: 1,
                output_qty: 20,
                output_base_units: 100, // 20 packs * 5 units/pack
              },
            ],
          })
          // 3. post-complete sync check
          .mockResolvedValue({ rows: [] }),
        transaction: vi.fn((fn: any) => fn(mockTx)),
      };

      const transformationAuthority = {
        readRuntime: vi.fn().mockResolvedValue({
          authority: "canonical",
          authorityRevision: "1",
          activationRunId: "1",
        }),
      } as any;

      const replen = new ReplenishmentUseCases(
        mockDb as any,
        {} as any,
        () => new Date("2026-11-27T14:05:00Z"),
        transformationAuthority,
        { executePackageOperation },
      );
      vi.spyOn(replen as any, "recoverReplenishmentFollowup").mockResolvedValue(undefined);
      vi.spyOn(replen, "syncQueuedClaimConversionTasks").mockResolvedValue({
        createdTaskIds: [],
        existingTaskIds: [],
        cancelledRedundantTaskIds: [],
      });

      const result = await replen.executeTask(777, "user:replenisher-1");
      expect(result).toEqual({ moved: 100 });
      expect(executePackageOperation).toHaveBeenCalledTimes(1);
      expect(executePackageOperation).toHaveBeenCalledWith({
        claimId: "901",
        operationKey: "op:break:c20-to-p1",
        idempotencyKey: "replen-task-claim-op:777:901:op:break:c20-to-p1",
        actor: "user:replenisher-1",
        reason: "Replen task #777 (case_break)",
        preferredSourceLocationId: 211,
      });
      expect(updatedTaskSets[0]).toMatchObject({
        status: "completed",
        qtyCompleted: 100,
        executionMovedBaseUnits: 100,
        blocksShipment: false,
        assignedTo: "user:replenisher-1",
      });
    });
  });

  describe("3. PickingUseCases Queue-Mode Gate (No Inline Case-Break Prompt When Queued)", () => {
    it("does NOT prompt case_break_confirmation_required when claim conversion is in queue mode, and syncs queued replen task", async () => {
      const syncQueuedClaimConversionTasks = vi.fn().mockResolvedValue({
        createdTaskIds: [888],
        existingTaskIds: [],
        cancelledRedundantTaskIds: [],
      });
      const pickClaimLine = vi.fn().mockRejectedValue(
        Object.assign(new Error("This package conversion is configured for queued warehouse work, not inline picking."), {
          code: "CLAIM_PICK_REPLENISHMENT_REQUIRED",
        }),
      );

      const beforeItem = {
        id: 6001,
        orderId: 5001,
        sku: "SHLZ-P50",
        name: "Sleeves Pack 50",
        location: "A-01",
        productId: 11,
        catalogProductId: 5,
        inventoryTracking: true,
        quantity: 2,
        pickedQuantity: 0,
        fulfilledQuantity: 0,
        status: "pending",
        onHold: false,
        requiresShipping: 1,
      } as any;

      const storage = {
        getOrderItemById: vi.fn().mockResolvedValue(beforeItem),
        getProductVariantById: vi.fn().mockResolvedValue({
          id: 11,
          productId: 5,
          sku: "SHLZ-P50",
          requiresShipping: true,
          trackInventory: true,
        }),
        getAllWarehouseLocations: vi.fn().mockResolvedValue([
          { id: 101, code: "A-01", warehouseId: 1, locationType: "pick", isPickable: 1, isActive: 1, cycleCountFreezeId: null },
          { id: 210, code: "R-10", warehouseId: 1, locationType: "reserve", isPickable: 0, isActive: 1, cycleCountFreezeId: null },
        ]),
        getInventoryLevelsByProductVariantId: vi.fn().mockResolvedValue([
          { warehouseLocationId: 101, variantQty: 0, reservedQty: 0 },
        ]),
      };

      const inventoryCore = {
        getLevel: vi.fn().mockResolvedValue({
          productVariantId: 11,
          warehouseLocationId: 101,
          variantQty: 0,
          reservedQty: 0,
        }),
      };

      const replenishment = {
        loadActiveClaimConversionSource: vi.fn().mockResolvedValue({
          claimId: "901",
          operationKey: "op:break:c1000-to-p50",
          warehouseId: 1,
          outputLocationId: 101,
          committedOutputQty: 2,
          locationId: 210,
          locationCode: "R-10",
          variantId: 12,
          variantSku: "SHLZ-C1000",
          variantName: "Case of 1000",
          unitsPerVariant: 1000,
          destUnitsPerVariant: 50,
          destProductId: 5,
          claimedQty: 1,
          freeQty: 0,
          outputQty: 20,
          replenMethod: "case_break",
          executionMode: "queue",
          shouldAutoExecute: false,
        }),
        syncQueuedClaimConversionTasks,
        listEligibleReplenSources: vi.fn().mockResolvedValue([]),
        checkReplenNeeded: vi.fn().mockResolvedValue(null),
      };

      const context = {
        authority: "canonical" as const,
        authorityRevision: "1",
        activationRunId: "1",
        legacy: {} as any,
        canonical: { pickClaimLine } as any,
        getLatestClaim: vi.fn(async () => ({
          claimId: "901",
          revision: 1,
          status: "active" as const,
          plan: {
            lines: [{ lineKey: "order-item:6001", targetVariantId: 11, plannedQty: "2" }],
            resourceClaims: [
              {
                lineKey: "order-item:6001",
                consumerOperationKey: "op:break:c1000-to-p50",
                warehouseId: 1,
                warehouseLocationId: 210,
                sourceVariantId: 12,
                claimedQty: "1",
              },
            ],
            operations: [
              {
                lineKey: "order-item:6001",
                operationKey: "op:break:c1000-to-p50",
                operationType: "break_pack",
                destinationVariantId: 11,
                outputQty: "20",
                committedOutputQty: "2",
                outputLocationId: 101,
              },
            ],
          } as any,
        })),
        getClaimLinePickMovementCursor: vi.fn(async () => "cursor-1"),
        getVariantMetadata: vi.fn(async () => new Map()),
        getOrderIdByShopifyOrderId: vi.fn(async () => null),
      };

      const service = new PickingUseCases(
        { execute: vi.fn(async () => ({ rows: [] })) } as any,
        inventoryCore as any,
        replenishment as any,
        storage as any,
      );

      await expect(
        (service as any).applyCanonicalPickProgress(context, {
          itemId: 6001,
          beforeItem,
          status: "completed",
          effectivePickedQuantity: 2,
          warehouseId: 1,
          userId: "picker-1",
          pickMethod: "scan",
          confirmFoundOnShelf: false,
        }),
      ).rejects.toThrow(/queued warehouse work/i);

      expect(syncQueuedClaimConversionTasks).toHaveBeenCalledWith({
        orderId: 5001,
        orderItemId: 6001,
        toLocationId: 101,
        pickProductVariantId: 11,
      });

      // Now simulate Order #2 arriving after Order #1's replen task deposited 18 free packs in A-01:
      // PickingUseCases automatically sets skipPackageConversions=true (`reconcile_recorded_stock`)
      // so Order #2 fulfills from A-01's loose packs and releases its Reserve case reservation!
      inventoryCore.getLevel.mockResolvedValueOnce({
        productVariantId: 11,
        warehouseLocationId: 101,
        variantQty: 18,
        reservedQty: 0,
      });
      storage.getInventoryLevelsByProductVariantId.mockResolvedValueOnce([
        { warehouseLocationId: 101, variantQty: 18, reservedQty: 0 },
      ]);
      storage.getOrderItemById.mockResolvedValueOnce({
        ...beforeItem,
        pickedQuantity: 2,
        status: "completed",
      });
      pickClaimLine.mockResolvedValueOnce({
        outcome: "picked",
        warehouseLocationIds: [101],
      });

      const order2Res = await (service as any).applyCanonicalPickProgress(context, {
        itemId: 6001,
        beforeItem,
        status: "completed",
        effectivePickedQuantity: 2,
        warehouseId: 1,
        userId: "picker-1",
        pickMethod: "scan",
        confirmFoundOnShelf: false,
      });
      expect(order2Res.deductResult?.success).toBe(true);
      expect(pickClaimLine).toHaveBeenLastCalledWith(
        expect.objectContaining({
          locationStrategy: "reconcile_recorded_stock",
          skipPackageConversions: true,
        }),
      );
    });
  });

  describe("4. Surplus Reuse Across Concurrent Orders (No Redundant 2nd Case Break)", () => {
    it("returns false cleanly when pick bin does not yet have enough free stock to replace an untouched conversion", async () => {
      const client = {
        query: vi.fn(async (sqlText: string) => {
          if (sqlText.includes("SELECT level.id AS inventory_level_id")) {
            return { rows: [{ inventory_level_id: 50 }] };
          }
          if (sqlText.includes("FROM warehouse.warehouse_locations") && sqlText.includes("cycle_count_freeze_id")) {
            return {
              rows: [{ id: 101, warehouse_id: 1, is_active: 1, is_pickable: 1, cycle_count_freeze_id: null }],
            };
          }
          if (sqlText.includes("FROM inventory.availability_claim_operations") && sqlText.includes("FOR UPDATE")) {
            return {
              rows: [
                {
                  id: "301",
                  operation_key: "op:break:order2",
                  parent_operation_key: null,
                  warehouse_id: 1,
                  operation_type: "break_pack",
                  status: "pending",
                  destination_variant_id: 11,
                  planned_executions: "1",
                  executed_executions: "0",
                  released_executions: "0",
                  committed_output_qty: "3",
                },
              ],
            };
          }
          if (sqlText.includes("SELECT DISTINCT parent_operation_key")) return { rows: [] };
          if (sqlText.includes("FROM inventory.availability_claim_build_handoffs")) return { rows: [] };
          if (sqlText.includes("SELECT DISTINCT producer_operation_key")) return { rows: [] };
          if (sqlText.includes("FROM inventory.availability_claim_resources") && sqlText.includes("consumer_operation_key = ANY")) {
            return {
              rows: [
                {
                  id: "401",
                  consumer_operation_key: "op:break:order2",
                  inventory_level_id: 20,
                  warehouse_location_id: 210,
                  source_variant_id: 12,
                  claimed_qty: "1",
                  released_qty: "0",
                  consumed_qty: "0",
                  picked_qty: "0",
                },
              ],
            };
          }
          if (sqlText.includes("FROM inventory.availability_claim_lot_allocations")) {
            return {
              rows: [
                {
                  id: "501",
                  claim_resource_id: "401",
                  inventory_lot_id: 5,
                  claimed_qty: "1",
                  released_qty: "0",
                  consumed_qty: "0",
                  picked_qty: "0",
                },
              ],
            };
          }
          if (sqlText.includes("SELECT variant_qty, reserved_qty")) {
            // Only 1 free pack in A-01, while Order #2 needs 3!
            return { rows: [{ variant_qty: 1, reserved_qty: 0 }] };
          }
          return { rows: [] };
        }),
      } as any;

      const replaced = await tryReplaceUntouchedConversionWithAvailablePickBinStock(
        client,
        {} as any,
        {
          commandKey: "cmd:1",
          claim: { id: BigInt(902), orderId: 5002 } as any,
          line: {
            id: BigInt(702),
            orderItemId: 6002,
            targetVariantId: 11,
            plannedQty: BigInt(3),
            releasedTargetQty: BigInt(0),
            consumedTargetQty: BigInt(0),
            pickedTargetQty: BigInt(0),
            resources: [],
          },
          orderWarehouseId: 1,
          warehouseLocationId: 101,
          quantity: BigInt(3),
          actor: "user:picker-1",
          reason: "Pick order #2",
          occurredAt: new Date("2026-11-27T14:10:00Z"),
        },
      );

      expect(replaced).toBe(false);
    });

    it("replaces Order #2's untouched break_pack with loose surplus packs in A-01 and releases Order #2's Reserve case reservation", async () => {
      const releaseResources = vi.fn().mockResolvedValue(undefined);
      const reserveResource = vi.fn().mockResolvedValue([
        {
          inventoryLotId: 99,
          qty: "3",
          unitCostMills: BigInt(100),
          poUnitCostMills: BigInt(100),
          packagingUnitCostMills: BigInt(0),
          landedUnitCostMills: BigInt(0),
        },
      ]);

      const client = {
        query: vi.fn(async (sqlText: string) => {
          if (sqlText.includes("SELECT level.id AS inventory_level_id")) {
            return { rows: [{ inventory_level_id: 50 }] };
          }
          if (sqlText.includes("FROM warehouse.warehouse_locations") && sqlText.includes("cycle_count_freeze_id")) {
            return {
              rows: [{ id: 101, warehouse_id: 1, is_active: 1, is_pickable: 1, cycle_count_freeze_id: null }],
            };
          }
          if (sqlText.includes("FROM inventory.availability_claim_operations") && sqlText.includes("FOR UPDATE")) {
            return {
              rows: [
                {
                  id: "301",
                  operation_key: "op:break:order2",
                  parent_operation_key: null,
                  warehouse_id: 1,
                  operation_type: "break_pack",
                  status: "pending",
                  destination_variant_id: 11,
                  planned_executions: "1",
                  executed_executions: "0",
                  released_executions: "0",
                  committed_output_qty: "3",
                },
              ],
            };
          }
          if (sqlText.includes("SELECT DISTINCT parent_operation_key")) return { rows: [] };
          if (sqlText.includes("FROM inventory.availability_claim_build_handoffs")) return { rows: [] };
          if (sqlText.includes("SELECT DISTINCT producer_operation_key")) return { rows: [] };
          if (sqlText.includes("FROM inventory.availability_claim_resources") && sqlText.includes("consumer_operation_key = ANY")) {
            return {
              rows: [
                {
                  id: "401",
                  consumer_operation_key: "op:break:order2",
                  inventory_level_id: 20,
                  warehouse_location_id: 210,
                  source_variant_id: 12,
                  claimed_qty: "1",
                  released_qty: "0",
                  consumed_qty: "0",
                  picked_qty: "0",
                },
              ],
            };
          }
          if (sqlText.includes("FROM inventory.availability_claim_lot_allocations") && sqlText.includes("FOR UPDATE")) {
            return {
              rows: [
                {
                  id: "501",
                  claim_resource_id: "401",
                  inventory_lot_id: 5,
                  claimed_qty: "1",
                  released_qty: "0",
                  consumed_qty: "0",
                  picked_qty: "0",
                },
              ],
            };
          }
          if (sqlText.includes("SELECT variant_qty, reserved_qty")) {
            // 18 surplus free packs in A-01 from Order #1's case break!
            return { rows: [{ variant_qty: 18, reserved_qty: 0 }] };
          }
          if (sqlText.includes("SELECT id, variant_qty, reserved_qty")) {
            return {
              rows: [
                { id: 20, variant_qty: 1, reserved_qty: 1 },
                { id: 50, variant_qty: 18, reserved_qty: 0 },
              ],
            };
          }
          if (sqlText.includes("INSERT INTO inventory.availability_claim_resources")) {
            return { rows: [{ id: "499" }] };
          }
          if (sqlText.includes("INSERT INTO inventory.availability_claim_lot_allocations")) {
            return { rowCount: 1, rows: [{ id: "599" }] };
          }
          if (sqlText.includes("UPDATE inventory.availability_claim_")) {
            return { rowCount: 1, rows: [] };
          }
          return { rowCount: 1, rows: [] };
        }),
      } as any;

      const replaced = await tryReplaceUntouchedConversionWithAvailablePickBinStock(
        client,
        { releaseResources, reserveResource } as any,
        {
          commandKey: "cmd:surplus-order2",
          claim: { id: BigInt(902), orderId: 5002 } as any,
          line: {
            id: BigInt(702),
            orderItemId: 6002,
            targetVariantId: 11,
            plannedQty: BigInt(3),
            releasedTargetQty: BigInt(0),
            consumedTargetQty: BigInt(0),
            pickedTargetQty: BigInt(0),
            resources: [],
          },
          orderWarehouseId: 1,
          warehouseLocationId: 101,
          quantity: BigInt(3),
          actor: "user:picker-1",
          reason: "Pick order #2 from surplus packs",
          occurredAt: new Date("2026-11-27T14:12:00Z"),
        },
      );

      expect(replaced).toBe(true);
      expect(releaseResources).toHaveBeenCalledTimes(1);
      expect(releaseResources.mock.calls[0][0].resources[0]).toMatchObject({
        warehouseLocationId: 210,
        sourceVariantId: 12,
        releaseQty: BigInt(1),
      });
      expect(reserveResource).toHaveBeenCalledTimes(1);
      expect(reserveResource.mock.calls[0][0]).toMatchObject({
        warehouseLocationId: 101,
        sourceVariantId: 11,
        claimedQty: 3,
      });
    });
  });

  describe("5. Automatic Same-Product Packaging Hierarchy Transformation Model Sync & Diagnostics", () => {
    it("synthesizes exact-integer downward break_pack paths (Case -> Box, Box -> Pack, Case -> Pack) and is idempotent when up to date", () => {
      const variants = [
        {
          id: 101,
          productId: 42,
          unitsPerVariant: 50,
          hierarchyLevel: 1,
          isActive: true,
          requiresShipping: true,
          trackInventory: true,
          salesEligibility: "sellable" as const,
        },
        {
          id: 102,
          productId: 42,
          unitsPerVariant: 200,
          hierarchyLevel: 2,
          isActive: true,
          requiresShipping: true,
          trackInventory: true,
          salesEligibility: "sellable" as const,
        },
        {
          id: 103,
          productId: 42,
          unitsPerVariant: 1000,
          hierarchyLevel: 3,
          isActive: true,
          requiresShipping: true,
          trackInventory: true,
          salesEligibility: "internal_only" as const,
        },
      ];

      const plan = buildAutoSyncedPackagingModelDefinition({
        product: { id: 42, isActive: true },
        variants,
        activeRecipeCount: 0,
        existingActiveModel: null,
        hasUnappliedDraft: false,
      });

      expect(plan.kind).toBe("sync_needed");
      if (plan.kind !== "sync_needed") throw new Error("expected sync_needed");
      expect(plan.definition.inventoryBehavior).toBe("package_hierarchy");
      expect(plan.definition.paths).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceVariantId: 102,
            destinationVariantId: 101,
            inputQty: 1,
            outputQty: 4,
            operationType: "break_pack",
            authorityState: "allowed",
          }),
          expect.objectContaining({
            sourceVariantId: 103,
            destinationVariantId: 102,
            inputQty: 1,
            outputQty: 5,
            operationType: "break_pack",
            authorityState: "allowed",
          }),
          expect.objectContaining({
            sourceVariantId: 103,
            destinationVariantId: 101,
            inputQty: 1,
            outputQty: 20,
            operationType: "break_pack",
            authorityState: "allowed",
          }),
        ]),
      );

      // Re-running against the sealed active model returns `up_to_date` (zero DB writes)
      const secondPlan = buildAutoSyncedPackagingModelDefinition({
        product: { id: 42, isActive: true },
        variants,
        activeRecipeCount: 0,
        existingActiveModel: {
          definitionHash: plan.definitionHash,
          inventoryBehavior: plan.definition.inventoryBehavior,
          buildToPromiseEnabled: false,
          paths: plan.definition.paths,
          recipeBindings: [],
        },
        hasUnappliedDraft: false,
      });
      expect(secondPlan).toEqual({
        kind: "up_to_date",
        definitionHash: plan.definitionHash,
        pathCount: 3,
      });
    });

    it("preserves explicit blocked overrides and skips build_managed / unapplied-draft products", () => {
      const variants = [
        {
          id: 101,
          productId: 42,
          unitsPerVariant: 50,
          hierarchyLevel: 1,
          isActive: true,
          requiresShipping: true,
          trackInventory: true,
          salesEligibility: "sellable" as const,
        },
        {
          id: 102,
          productId: 42,
          unitsPerVariant: 200,
          hierarchyLevel: 2,
          isActive: true,
          requiresShipping: true,
          trackInventory: true,
          salesEligibility: "sellable" as const,
        },
      ];

      expect(
        buildAutoSyncedPackagingModelDefinition({
          product: { id: 42, isActive: true },
          variants,
          activeRecipeCount: 1,
          existingActiveModel: null,
          hasUnappliedDraft: false,
        }),
      ).toEqual({ kind: "skip", reason: "recipe_or_build_managed" });

      expect(
        buildAutoSyncedPackagingModelDefinition({
          product: { id: 42, isActive: true },
          variants,
          activeRecipeCount: 0,
          existingActiveModel: null,
          hasUnappliedDraft: true,
        }),
      ).toEqual({ kind: "skip", reason: "unapplied_draft_exists" });

      const withBlockedOverride = buildAutoSyncedPackagingModelDefinition({
        product: { id: 42, isActive: true },
        variants,
        activeRecipeCount: 0,
        existingActiveModel: {
          definitionHash: "0".repeat(64),
          inventoryBehavior: "physical_only",
          buildToPromiseEnabled: false,
          paths: [
            {
              sourceVariantId: 102,
              destinationVariantId: 101,
              inputQty: 1,
              outputQty: 4,
              sourceUnitsPerVariant: 200,
              destinationUnitsPerVariant: 50,
              operationType: "break_pack",
              authorityState: "blocked",
              transformationRecipeBindingKey: null,
            },
          ],
          recipeBindings: [],
        },
        hasUnappliedDraft: false,
      });
      expect(withBlockedOverride.kind).toBe("sync_needed");
      if (withBlockedOverride.kind === "sync_needed") {
        expect(withBlockedOverride.definition.paths[0]?.authorityState).toBe("blocked");
        expect(withBlockedOverride.definition.inventoryBehavior).toBe("physical_only");
      }
    });

    it("surfaces actionable setup diagnostic taskNotes when checkReplenNeeded skips on missing bin assignment", async () => {
      const mockDb = {
        select: vi
          .fn()
          // 1. inventoryLevels
          .mockReturnValueOnce({
            from: () => ({ where: () => ({ limit: vi.fn().mockResolvedValue([]) }) }),
          })
          // 2. warehouseLocations (pickable)
          .mockReturnValueOnce({
            from: () => ({
              where: () => ({
                limit: vi.fn().mockResolvedValue([{ id: 101, code: "A-01", isPickable: 1 }]),
              }),
            }),
          })
          // 3. productLocations -> missing!
          .mockReturnValueOnce({
            from: () => ({ where: () => ({ limit: vi.fn().mockResolvedValue([]) }) }),
          }),
      };

      const replen = new ReplenishmentUseCases(
        mockDb as any,
        {} as any,
        () => new Date("2026-11-27T14:15:00Z"),
        { readRuntime: vi.fn() } as any,
      );

      const guidance = await replen.checkReplenNeeded(11, 101);
      expect(guidance.needed).toBe(false);
      expect(guidance.skipReason).toBe("no_bin_assignment");
      expect(guidance.taskNotes).toContain("Setup required: no active pick-bin assignment");
    });
  });
});
