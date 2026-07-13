/**
 * PACKER INSTRUCTION v1 — unit tests for pack-plan.service.
 *
 * Injection style mirrors shadow-quote.test.ts: all loaders/writers are
 * injected fakes, no real DB. Coverage (Rule #9): happy path, instruction
 * rendering edge cases (multi-box, SIOC, riders, fallback, length cap),
 * input-hash stability/change detection, ensurePackPlan idempotency +
 * supersede flow, never-throws degradation, and the feature-flag gate on
 * maybeGetPackInstruction.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildBoxInstruction,
  computePackPlanInputHash,
  ensurePackPlan,
  maybeGetPackInstruction,
  PACK_INSTRUCTION_MAX_LENGTH,
  type PackPlanDeps,
  type PersistPlanInput,
} from "../../application/pack-plan.service";
import type {
  CartonizeBox,
  CartonizeItem,
  CartonParcel,
} from "../../domain/cartonize";
import type { ShippingPackPlan } from "@shared/schema";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function packingInput(overrides: Partial<CartonizeItem> = {}): CartonizeItem {
  return {
    productVariantId: 101,
    sku: "SLV-100",
    quantity: 0,
    weightGrams: 120,
    lengthMm: 100,
    widthMm: 70,
    heightMm: 20,
    shippingGroupCode: "protection",
    shipsInOwnContainer: false,
    riderEligible: false,
    riderVoidCm3: null,
    riderVoidMaxWeightGrams: null,
    riderVoidMaxItems: null,
    ...overrides,
  };
}

function box(overrides: Partial<CartonizeBox> = {}): CartonizeBox {
  return {
    id: 1,
    code: "BOX-S",
    kind: "box",
    lengthMm: 300,
    widthMm: 200,
    heightMm: 150,
    tareWeightGrams: 100,
    maxWeightGrams: null,
    costCents: 50,
    fillFactorBps: 8500,
    isActive: true,
    ...overrides,
  };
}

function boxedParcel(overrides: Partial<CartonParcel> = {}): CartonParcel {
  return {
    boxId: 1,
    boxCode: "M",
    siocProductVariantId: null,
    items: [{ productVariantId: 101, sku: "SLV-100", quantity: 2, isRider: false }],
    placements: [],
    estWeightGrams: 340,
    billableWeightGrams: 400,
    lengthMm: 300,
    widthMm: 200,
    heightMm: 150,
    shippingGroupCode: "protection",
    reason: "protection items packed fewest-parcels",
    ...overrides,
  };
}

function siocParcel(overrides: Partial<CartonParcel> = {}): CartonParcel {
  return {
    boxId: null,
    boxCode: null,
    siocProductVariantId: 201,
    items: [{ productVariantId: 201, sku: "QUAD-BOX", quantity: 1, isRider: false }],
    placements: [],
    estWeightGrams: 900,
    billableWeightGrams: 900,
    lengthMm: 250,
    widthMm: 250,
    heightMm: 250,
    shippingGroupCode: "storage",
    reason: "ships in own container (QUAD-BOX)",
    ...overrides,
  };
}

const PLAN_ROW: ShippingPackPlan = {
  id: 55,
  wmsOrderId: 42,
  shipmentRequestId: null,
  status: "active",
  engineVersion: "cardshellz-cartonizer@3.0.0",
  inputHash: "stale-hash",
  warnings: [],
  createdAt: new Date("2026-07-01T00:00:00Z"),
  updatedAt: new Date("2026-07-01T00:00:00Z"),
};

function fakeDeps(input: {
  order?: { id: number; warehouseId: number | null } | null;
  lines?: Array<{ sku: string; quantity: number }>;
  variantIdBySku?: Map<string, number>;
  packingInputs?: Map<number, CartonizeItem>;
  boxes?: CartonizeBox[];
  activePlan?: ShippingPackPlan | null;
}): {
  deps: PackPlanDeps;
  persisted: PersistPlanInput[];
} {
  const persisted: PersistPlanInput[] = [];
  const deps: PackPlanDeps = {
    loadOrder: async () => (input.order === undefined ? { id: 42, warehouseId: 2 } : input.order),
    loadOrderItems: async () => input.lines ?? [{ sku: "SLV-100", quantity: 2 }],
    resolveVariantIdsBySku: async () => input.variantIdBySku ?? new Map([["SLV-100", 101]]),
    loadPackingInputs: async () => input.packingInputs ?? new Map([[101, packingInput()]]),
    loadActiveBoxes: async () => input.boxes ?? [box()],
    findActivePlan: async () => input.activePlan ?? null,
    persistPlan: async (p) => {
      persisted.push(p);
      return { ...PLAN_ROW, inputHash: p.inputHash, warnings: p.warnings };
    },
  };
  return { deps, persisted };
}

// ---------------------------------------------------------------------------
// buildBoxInstruction (pure)
// ---------------------------------------------------------------------------

describe("buildBoxInstruction", () => {
  it("renders multi-box counts grouped by box code", () => {
    const instruction = buildBoxInstruction([
      boxedParcel({ boxCode: "M" }),
      boxedParcel({ boxCode: "M" }),
      boxedParcel({ boxCode: "S", boxId: 2 }),
    ]);
    expect(instruction).toBe("BOX: M x2 + S x1");
  });

  it("renders SIOC parcels as 'SIOC <sku> xN' alongside boxes", () => {
    const instruction = buildBoxInstruction([
      boxedParcel({ boxCode: "M" }),
      siocParcel(),
      siocParcel(),
    ]);
    expect(instruction).toBe("BOX: M x1 + SIOC QUAD-BOX x2");
  });

  it("is unchanged by rider items riding inside a host parcel", () => {
    const withoutRider = buildBoxInstruction([siocParcel()]);
    const withRider = buildBoxInstruction([
      siocParcel({
        items: [
          { productVariantId: 201, sku: "QUAD-BOX", quantity: 1, isRider: false },
          { productVariantId: 101, sku: "SLV-100", quantity: 3, isRider: true },
        ],
        reason: "ships in own container (QUAD-BOX); absorbed 3 rider item(s), eliminated a parcel",
      }),
    ]);
    expect(withRider).toBe(withoutRider);
    expect(withRider).toBe("BOX: SIOC QUAD-BOX x1");
  });

  it("returns null when ANY parcel is a fallback", () => {
    const instruction = buildBoxInstruction([
      boxedParcel(),
      boxedParcel({
        reason: "fallback: could not verify fit for SLV-999; assigned largest box",
      }),
    ]);
    expect(instruction).toBeNull();
  });

  it("returns null for an empty parcel list", () => {
    expect(buildBoxInstruction([])).toBeNull();
  });

  it("caps the instruction at the max length without cutting mid-token", () => {
    const parcels = Array.from({ length: 40 }, (_, i) =>
      boxedParcel({ boxId: i + 1, boxCode: `LONG-BOX-CODE-${String(i).padStart(3, "0")}` }),
    );
    const instruction = buildBoxInstruction(parcels);
    expect(instruction).not.toBeNull();
    expect(instruction!.length).toBeLessThanOrEqual(PACK_INSTRUCTION_MAX_LENGTH);
    expect(instruction).toMatch(/^BOX: /);
    expect(instruction).toMatch(/\+…$/); // omission is marked
  });
});

// ---------------------------------------------------------------------------
// computePackPlanInputHash (pure)
// ---------------------------------------------------------------------------

describe("computePackPlanInputHash", () => {
  const itemA = packingInput({ productVariantId: 101, sku: "SLV-100", quantity: 2 });
  const itemB = packingInput({ productVariantId: 202, sku: "TL-35", quantity: 1 });
  const boxes = [box({ id: 1 }), box({ id: 2, code: "BOX-M" })];

  it("is stable across item and box ordering", () => {
    const h1 = computePackPlanInputHash([itemA, itemB], boxes);
    const h2 = computePackPlanInputHash([itemB, itemA], [boxes[1], boxes[0]]);
    expect(h1).toBe(h2);
  });

  it("changes when a quantity changes", () => {
    const h1 = computePackPlanInputHash([itemA], boxes);
    const h2 = computePackPlanInputHash([{ ...itemA, quantity: 3 }], boxes);
    expect(h1).not.toBe(h2);
  });

  it("changes when a packing attribute changes", () => {
    const h1 = computePackPlanInputHash([itemA], boxes);
    const h2 = computePackPlanInputHash([{ ...itemA, shipsInOwnContainer: true }], boxes);
    expect(h1).not.toBe(h2);
  });

  it("changes when the box suite changes", () => {
    const h1 = computePackPlanInputHash([itemA], boxes);
    const h2 = computePackPlanInputHash([itemA], [boxes[0]]);
    expect(h1).not.toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// ensurePackPlan (injected fakes — no DB)
// ---------------------------------------------------------------------------

describe("ensurePackPlan", () => {
  it("persists a new active plan and returns the instruction (happy path)", async () => {
    const { deps, persisted } = fakeDeps({});
    const result = await ensurePackPlan({ wmsOrderId: 42 }, deps);

    expect(result).not.toBeNull();
    expect(result!.complete).toBe(true);
    expect(result!.instruction).toBe("BOX: BOX-S x1");
    expect(result!.parcels).toHaveLength(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].wmsOrderId).toBe(42);
    expect(persisted[0].shipmentRequestId).toBeNull();
    expect(persisted[0].engineVersion).toBe("cardshellz-cartonizer@3.0.0");
    expect(persisted[0].inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is idempotent: same input_hash on the active plan → returns it, no write", async () => {
    // First run against empty state to learn the hash for these inputs.
    const first = fakeDeps({});
    const firstResult = await ensurePackPlan({ wmsOrderId: 42 }, first.deps);
    const currentHash = first.persisted[0].inputHash;

    const second = fakeDeps({
      activePlan: { ...PLAN_ROW, inputHash: currentHash },
    });
    const result = await ensurePackPlan({ wmsOrderId: 42 }, second.deps);

    expect(result).not.toBeNull();
    expect(result!.plan.id).toBe(PLAN_ROW.id); // the EXISTING row, unchanged
    expect(result!.instruction).toBe(firstResult!.instruction);
    expect(second.persisted).toHaveLength(0); // no supersede, no insert
  });

  it("supersedes when the active plan's input_hash differs", async () => {
    const { deps, persisted } = fakeDeps({
      activePlan: { ...PLAN_ROW, inputHash: "different-hash" },
    });
    const result = await ensurePackPlan({ wmsOrderId: 42 }, deps);

    expect(result).not.toBeNull();
    expect(persisted).toHaveLength(1); // persistPlan owns supersede+insert transactionally
    expect(result!.plan.inputHash).toBe(persisted[0].inputHash);
  });

  it("supersedes a plan produced by an older cartonizer version", async () => {
    const first = fakeDeps({});
    await ensurePackPlan({ wmsOrderId: 42 }, first.deps);
    const currentHash = first.persisted[0].inputHash;
    const next = fakeDeps({
      activePlan: {
        ...PLAN_ROW,
        engineVersion: "cardshellz-cartonizer@2.0.0",
        inputHash: currentHash,
      },
    });

    const result = await ensurePackPlan({ wmsOrderId: 42 }, next.deps);

    expect(result).not.toBeNull();
    expect(next.persisted).toHaveLength(1);
    expect(next.persisted[0].engineVersion).toBe("cardshellz-cartonizer@3.0.0");
  });

  it("returns null and persists nothing when the packing degrades to fallback", async () => {
    // SKU resolves to nothing → stub item with no dims → fallback parcel.
    const { deps, persisted } = fakeDeps({
      variantIdBySku: new Map(),
      packingInputs: new Map(),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await ensurePackPlan({ wmsOrderId: 42 }, deps);
    warn.mockRestore();

    expect(result).toBeNull();
    expect(persisted).toHaveLength(0);
  });

  it("returns null for a missing order / empty lines / invalid id (never throws)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const missingOrder = fakeDeps({ order: null });
    expect(await ensurePackPlan({ wmsOrderId: 42 }, missingOrder.deps)).toBeNull();

    const noLines = fakeDeps({ lines: [] });
    expect(await ensurePackPlan({ wmsOrderId: 42 }, noLines.deps)).toBeNull();

    expect(await ensurePackPlan({ wmsOrderId: 0 }, fakeDeps({}).deps)).toBeNull();
    expect(await ensurePackPlan({ wmsOrderId: 1.5 }, fakeDeps({}).deps)).toBeNull();
    warn.mockRestore();
  });

  it("returns null instead of throwing when a loader rejects", async () => {
    const { deps, persisted } = fakeDeps({});
    deps.loadActiveBoxes = async () => {
      throw new Error("db down");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await ensurePackPlan({ wmsOrderId: 42 }, deps);
    warn.mockRestore();

    expect(result).toBeNull();
    expect(persisted).toHaveLength(0);
  });

  it("returns null instead of throwing when persistPlan rejects", async () => {
    const { deps } = fakeDeps({});
    deps.persistPlan = async () => {
      throw new Error("constraint violation");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await ensurePackPlan({ wmsOrderId: 42 }, deps);
    warn.mockRestore();

    expect(result).toBeNull();
  });

  it("stores the caller's shipmentRequestId on the plan", async () => {
    const { deps, persisted } = fakeDeps({});
    await ensurePackPlan({ wmsOrderId: 42, shipmentRequestId: 777 }, deps);
    expect(persisted[0].shipmentRequestId).toBe(777);
  });
});

// ---------------------------------------------------------------------------
// maybeGetPackInstruction (feature flag gate)
// ---------------------------------------------------------------------------

describe("maybeGetPackInstruction", () => {
  const FLAG = "SHIPPING_PACK_INSTRUCTION_ENABLED";
  let originalFlag: string | undefined;

  beforeEach(() => {
    originalFlag = process.env[FLAG];
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = originalFlag;
  });

  it("returns null immediately (no loader calls) when the flag is off", async () => {
    delete process.env[FLAG];
    const { deps } = fakeDeps({});
    const loadOrder = vi.fn(deps.loadOrder);
    deps.loadOrder = loadOrder;

    expect(await maybeGetPackInstruction(42, 9001, deps)).toBeNull();
    expect(loadOrder).not.toHaveBeenCalled();

    process.env[FLAG] = "false";
    expect(await maybeGetPackInstruction(42, 9001, deps)).toBeNull();
    expect(loadOrder).not.toHaveBeenCalled();
  });

  it("returns the instruction when the flag is on", async () => {
    process.env[FLAG] = "true";
    const { deps } = fakeDeps({});
    expect(await maybeGetPackInstruction(42, 9001, deps)).toBe("BOX: BOX-S x1");
  });

  it("degrades to null (never throws) when the pipeline fails with the flag on", async () => {
    process.env[FLAG] = "true";
    const { deps } = fakeDeps({});
    deps.loadOrder = async () => {
      throw new Error("db down");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(maybeGetPackInstruction(42, 9001, deps)).resolves.toBeNull();
    warn.mockRestore();
  });
});
