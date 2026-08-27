import { describe, expect, it } from "vitest";
import type {
  CreateTransformationModelDraftRequest,
  SupplyTransformationsAdminView,
} from "@shared/types/inventory-availability-admin";

import {
  InventoryAvailabilityMasterDataService,
  type InventoryAvailabilityMasterDataAdminStore,
} from "../../application/inventory-availability-master-data.service";
import {
  type InventoryAvailabilityMasterDataReplay,
  calculateRecipeDefinitionHash,
  InventoryAvailabilityMasterDataError,
} from "../../domain/inventory-availability-master-data.contracts";

const NOW = new Date("2026-08-27T12:00:00.000Z");

describe("InventoryAvailabilityMasterDataService", () => {
  it("hydrates immutable catalog and recipe snapshots before persistence", async () => {
    const store = new FakeStore(editorView());
    const service = createService(store);

    const result = await service.createTransformationModelDraft({
      ...baseRequest(),
      buildToPromiseEnabled: true,
      paths: [{
        sourceVariantId: 11,
        destinationVariantId: 12,
        inputQty: 5,
        outputQty: 1,
        operationType: "directed_conversion",
        authorityState: "allowed",
        transformationRecipeBindingKey: "recipe:31:network",
      }],
      recipeBindings: [
        {
          bindingKey: "recipe:30:network",
          recipeId: 30,
          relationshipRole: "component_build",
          warehouseId: null,
        },
        {
          bindingKey: "recipe:31:network",
          recipeId: 31,
          relationshipRole: "directional_conversion",
          warehouseId: null,
        },
      ],
    }, "operator-1");

    expect(result).toMatchObject({ modelId: 90, version: 1, alreadyApplied: false });
    const command = store.transformationCommands[0]!;
    expect(command).toMatchObject({
      actorId: "operator-1",
      changeReason: "Explicit reviewed authority",
      occurredAt: NOW,
      definition: {
        productId: 10,
        buildToPromiseEnabled: true,
        paths: [{
          sourceProductId: 10,
          sourceVariantId: 11,
          sourceUnitsPerVariant: 1,
          destinationProductId: 10,
          destinationVariantId: 12,
          destinationUnitsPerVariant: 5,
        }],
      },
    });
    const assembly = command.definition.recipeBindings[0]!;
    expect(assembly).toMatchObject({
      recipeId: 30,
      recipeCodeSnapshot: "ASSEMBLE-QUAD",
      recipeVersionSnapshot: 3,
      outputProductIdSnapshot: 10,
      outputVariantIdSnapshot: 11,
      outputUnitsPerVariantSnapshot: 1,
      outputQtySnapshot: 1,
      components: [{
        componentVariantId: 201,
        componentProductId: 200,
        componentUnitsPerVariant: 1,
        componentQty: 1,
      }],
    });
    expect(assembly.recipeDefinitionHash).toBe(calculateRecipeDefinitionHash(assembly));
    expect(command.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects an allowed non-conserving path without explicit recipe authority", async () => {
    const service = createService(new FakeStore(editorView()));
    await expect(service.createTransformationModelDraft({
      ...baseRequest(),
      paths: [{
        sourceVariantId: 11,
        destinationVariantId: 12,
        inputQty: 1,
        outputQty: 1,
        operationType: "assemble_pack",
        authorityState: "allowed",
        transformationRecipeBindingKey: null,
      }],
    }, "operator-1")).rejects.toMatchObject({
      status: 400,
      code: "INVENTORY_AVAILABILITY_INVALID_INPUT",
      details: expect.arrayContaining([
        expect.stringContaining("requires an explicit recipe binding"),
      ]),
    });
  });

  it("allows a blocked malformed path without granting executable authority", async () => {
    const store = new FakeStore(editorView());
    const service = createService(store);
    await service.createTransformationModelDraft({
      ...baseRequest(),
      paths: [{
        sourceVariantId: 11,
        destinationVariantId: 12,
        inputQty: 1,
        outputQty: 1,
        operationType: "directed_conversion",
        authorityState: "blocked",
        transformationRecipeBindingKey: null,
      }],
    }, "operator-1");

    expect(store.transformationCommands[0]?.definition.paths[0]).toMatchObject({
      authorityState: "blocked",
      sourceUnitsPerVariant: 1,
      destinationUnitsPerVariant: 5,
    });
  });

  it("rejects inactive or cross-product path variants", async () => {
    const view = editorView();
    view.variants[1]!.isActive = false;
    const service = createService(new FakeStore(view));

    await expect(service.createTransformationModelDraft({
      ...baseRequest(),
      paths: [{
        sourceVariantId: 11,
        destinationVariantId: 12,
        inputQty: 5,
        outputQty: 1,
        operationType: "assemble_pack",
        authorityState: "allowed",
        transformationRecipeBindingKey: null,
      }],
    }, "operator-1")).rejects.toMatchObject({
      status: 400,
      code: "INVENTORY_AVAILABILITY_REFERENCE_INVALID",
    });
  });

  it("returns an explicit not-found error instead of inventing product context", async () => {
    const service = createService(new FakeStore(null));
    await expect(service.getSupplyTransformationsAdminView(999)).rejects.toEqual(
      expect.objectContaining({
        status: 404,
        code: "INVENTORY_AVAILABILITY_PRODUCT_NOT_FOUND",
      }),
    );
  });

  it("requires an authenticated actor and an active product", async () => {
    const inactive = editorView();
    inactive.product.isActive = false;
    const service = createService(new FakeStore(inactive));

    await expect(service.createTransformationModelDraft(baseRequest(), " "))
      .rejects.toBeInstanceOf(InventoryAvailabilityMasterDataError);
    await expect(service.createTransformationModelDraft(baseRequest(), "operator-1"))
      .rejects.toMatchObject({
        status: 409,
        code: "INVENTORY_AVAILABILITY_PRODUCT_INACTIVE",
      });
  });

  it("constructs location-policy and safety-policy commands from strict definitions", async () => {
    const store = new FakeStore(editorView());
    const service = createService(store);

    const location = await service.createLocationPromisePolicyDraft({
      warehouseLocationId: 7,
      eligibilityMode: "eligible",
      changeReason: "Reserve bins may promise",
      idempotencyKey: "location-draft-1",
    }, "operator-1");
    const safety = await service.createPromiseSafetyPolicyDraft({
      scope: {
        scopeType: "warehouse_variant",
        warehouseId: 3,
        productVariantId: 11,
      },
      value: {
        policyMode: "days_of_cover",
        daysOfCoverMilliDays: 2_500,
        untrustedDemandFallbackUnits: 4,
        demandMethodVersion: "irreversible-demand-v1",
      },
      changeReason: "Warehouse-specific cover",
      idempotencyKey: "safety-draft-1",
    }, "operator-1");

    expect(location).toMatchObject({ policyId: 91, alreadyApplied: false });
    expect(store.locationCommands[0]).toMatchObject({
      actorId: "operator-1",
      warehouseLocationId: 7,
      eligibilityMode: "eligible",
      occurredAt: NOW,
    });
    expect(store.locationCommands[0]?.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(safety).toMatchObject({
      policyId: 92,
      scopeKey: "warehouse:3:variant:11",
      alreadyApplied: false,
    });
    expect(store.safetyCommands[0]).toMatchObject({
      actorId: "operator-1",
      scope: {
        scopeType: "warehouse_variant",
        warehouseId: 3,
        productVariantId: 11,
      },
      value: {
        policyMode: "days_of_cover",
        daysOfCoverMilliDays: 2_500,
      },
      occurredAt: NOW,
    });
    expect(store.safetyCommands[0]?.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("replays a matching create intent before reading a drifted catalog", async () => {
    const firstStore = new FakeStore(editorView());
    await createService(firstStore).createTransformationModelDraft(baseRequest(), "operator-1");
    const firstCommand = firstStore.transformationCommands[0]!;
    const replayStore = new FakeStore(null);
    replayStore.replay = {
      commandType: "transformation_model",
      requestHash: firstCommand.requestHash,
      result: {
        modelId: 90,
        version: 1,
        definitionHash: "a".repeat(64),
        alreadyApplied: false,
      },
    };

    await expect(createService(replayStore).createTransformationModelDraft(
      baseRequest(),
      "operator-1",
    )).resolves.toMatchObject({ modelId: 90, alreadyApplied: true });
    expect(replayStore.viewLoads).toBe(0);
  });

  it("rejects changed caller intent and cross-command key reuse before catalog hydration", async () => {
    const firstStore = new FakeStore(editorView());
    await createService(firstStore).createTransformationModelDraft(baseRequest(), "operator-1");
    const requestHash = firstStore.transformationCommands[0]!.requestHash;
    const changedIntentStore = new FakeStore(null);
    changedIntentStore.replay = {
      commandType: "transformation_model",
      requestHash,
      result: {
        modelId: 90,
        version: 1,
        definitionHash: "a".repeat(64),
        alreadyApplied: false,
      },
    };
    await expect(createService(changedIntentStore).createTransformationModelDraft({
      ...baseRequest(),
      buildToPromiseEnabled: true,
    }, "operator-1")).rejects.toMatchObject({
      status: 409,
      code: "INVENTORY_AVAILABILITY_IDEMPOTENCY_KEY_REUSED",
    });
    expect(changedIntentStore.viewLoads).toBe(0);

    const crossCommandStore = new FakeStore(null);
    crossCommandStore.replay = {
      commandType: "location_promise_policy",
      requestHash: "b".repeat(64),
      result: { policyId: 1, version: 1, alreadyApplied: false },
    };
    await expect(createService(crossCommandStore).createTransformationModelDraft(
      baseRequest(),
      "operator-1",
    )).rejects.toMatchObject({
      status: 409,
      code: "INVENTORY_AVAILABILITY_IDEMPOTENCY_KEY_REUSED",
    });
    expect(crossCommandStore.viewLoads).toBe(0);
  });

  it("forwards optimistic draft-edit evidence without changing draft identity", async () => {
    const store = new FakeStore(editorView());
    const service = createService(store);
    const result = await service.updateTransformationModelDraft(10, 90, {
      expectedVersion: 1,
      expectedDefinitionHash: "a".repeat(64),
      expectedHeadRevision: "0",
      buildToPromiseEnabled: false,
      paths: [],
      recipeBindings: [],
      changeReason: "Correct reviewed authority",
      idempotencyKey: "draft-edit-1",
    }, "operator-1");

    expect(result).toMatchObject({ modelId: 90, version: 1, alreadyApplied: false });
    expect(store.updateCommands[0]).toMatchObject({
      productId: 10,
      draftModelId: 90,
      expectedVersion: 1,
      expectedDefinitionHash: "a".repeat(64),
      expectedHeadRevision: "0",
      actorId: "operator-1",
      occurredAt: NOW,
      definition: { productId: 10, paths: [], recipeBindings: [] },
    });
  });
});

function createService(store: FakeStore) {
  return new InventoryAvailabilityMasterDataService(store, { now: () => NOW });
}

function baseRequest(): CreateTransformationModelDraftRequest {
  return {
    productId: 10,
    buildToPromiseEnabled: false,
    paths: [],
    recipeBindings: [],
    changeReason: "Explicit reviewed authority",
    idempotencyKey: "test-draft-1",
  };
}

function editorView(): SupplyTransformationsAdminView {
  return {
    product: {
      id: 10,
      sku: "QUAD",
      name: "Quad Box",
      isActive: true,
      legacyInventoryStrategy: "recipe_managed",
    },
    variants: [
      {
        id: 11,
        productId: 10,
        sku: "QUAD-EA",
        name: "Quad Each",
        unitsPerVariant: 1,
        uomType: "each",
        isActive: true,
      },
      {
        id: 12,
        productId: 10,
        sku: "QUAD-P5",
        name: "Quad Pack 5",
        unitsPerVariant: 5,
        uomType: "pack",
        isActive: true,
      },
    ],
    recipes: [
      {
        id: 30,
        code: "ASSEMBLE-QUAD",
        name: "Assemble Quad",
        version: 3,
        status: "active",
        recipeType: "assembly",
        outputProductId: 10,
        outputVariantId: 11,
        outputUnitsPerVariant: 1,
        outputQty: 1,
        components: [{
          componentVariantId: 201,
          componentProductId: 200,
          componentUnitsPerVariant: 1,
          componentQty: 1,
          sku: "BASE-EA",
          name: "Base",
        }],
      },
      {
        id: 31,
        code: "EA-TO-P5",
        name: "Pack five",
        version: 2,
        status: "active",
        recipeType: "conversion",
        outputProductId: 10,
        outputVariantId: 12,
        outputUnitsPerVariant: 5,
        outputQty: 1,
        components: [{
          componentVariantId: 11,
          componentProductId: 10,
          componentUnitsPerVariant: 1,
          componentQty: 5,
          sku: "QUAD-EA",
          name: "Quad Each",
        }],
      },
    ],
    head: null,
    activeModel: null,
    draftModel: null,
    runtimeAuthority: {
      kind: "legacy_inventory_strategy",
      value: "recipe_managed",
      draftAffectsRuntime: false,
    },
  };
}

class FakeStore implements InventoryAvailabilityMasterDataAdminStore {
  readonly transformationCommands: Array<
    Parameters<InventoryAvailabilityMasterDataAdminStore["createTransformationModelDraft"]>[0]
  > = [];
  readonly updateCommands: Array<
    Parameters<InventoryAvailabilityMasterDataAdminStore["updateTransformationModelDraft"]>[0]
  > = [];
  readonly locationCommands: Array<
    Parameters<InventoryAvailabilityMasterDataAdminStore["createLocationPromisePolicyDraft"]>[0]
  > = [];
  readonly safetyCommands: Array<
    Parameters<InventoryAvailabilityMasterDataAdminStore["createPromiseSafetyPolicyDraft"]>[0]
  > = [];

  viewLoads = 0;
  replay: InventoryAvailabilityMasterDataReplay | null = null;

  async findMasterDataDraftReplay() {
    return this.replay ? structuredClone(this.replay) : null;
  }

  async listProductOptions() {
    return [{ id: 10, sku: "QUAD", name: "Quad Box" }];
  }

  async updateTransformationModelDraft(
    command: Parameters<InventoryAvailabilityMasterDataAdminStore["updateTransformationModelDraft"]>[0],
  ) {
    this.updateCommands.push(command);
    return { modelId: command.draftModelId, version: 1, definitionHash: "b".repeat(64), alreadyApplied: false };
  }

  constructor(private readonly view: SupplyTransformationsAdminView | null) {}

  async getSupplyTransformationsAdminView(productId: number) {
    this.viewLoads += 1;
    return this.view?.product.id === productId ? structuredClone(this.view) : null;
  }

  async createTransformationModelDraft(
    command: Parameters<
      InventoryAvailabilityMasterDataAdminStore["createTransformationModelDraft"]
    >[0],
  ) {
    this.transformationCommands.push(command);
    return {
      modelId: 90,
      version: 1,
      definitionHash: "a".repeat(64),
      alreadyApplied: false,
    };
  }

  async createLocationPromisePolicyDraft(
    command: Parameters<
      InventoryAvailabilityMasterDataAdminStore["createLocationPromisePolicyDraft"]
    >[0],
  ) {
    this.locationCommands.push(command);
    return { policyId: 91, version: 1, alreadyApplied: false };
  }

  async createPromiseSafetyPolicyDraft(
    command: Parameters<
      InventoryAvailabilityMasterDataAdminStore["createPromiseSafetyPolicyDraft"]
    >[0],
  ) {
    this.safetyCommands.push(command);
    return {
      policyId: 92,
      version: 1,
      scopeKey: "warehouse:3:variant:11",
      alreadyApplied: false,
    };
  }
}
