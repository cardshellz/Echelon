import { describe, expect, it } from "vitest";
import {
  deriveLosslessPath,
  type PathDraft,
  type TransformationAdminBinding,
  type TransformationAdminModel,
  type TransformationAdminVariant,
} from "@/pages/supply-transformations-model";
import {
  buildPackageLadder,
  packageLadderModelEditIssues,
  updatePackageLadderDirection,
  type PackageDirection,
} from "../package-conversion-ladder";

const variants: TransformationAdminVariant[] = [variant(1, 1), variant(2, 5), variant(3, 25)];

describe("package conversion ladder", () => {
  it.each<PackageDirection>(["none", "break_down", "build_up", "reversible"])(
    "round-trips %s through explicit directed paths",
    (direction) => {
      const result = update([], direction);
      expect(buildPackageLadder(variants, result.paths).rows[0]?.direction).toBe(direction);
      expect(result.paths).toHaveLength(direction === "none" ? 0 : direction === "reversible" ? 2 : 1);
      expect(result.paths.every((path) => path.authorityState === "allowed")).toBe(true);
      if (direction === "break_down") expect(result.paths[0]).toMatchObject({
        sourceVariantId: 2, destinationVariantId: 1, operationType: "break_pack", inputQty: "1", outputQty: "5",
      });
      if (direction === "build_up") expect(result.paths[0]).toMatchObject({
        sourceVariantId: 1, destinationVariantId: 2, operationType: "assemble_pack", inputQty: "5", outputQty: "1",
      });
    },
  );

  it("computes the minimal exact GCD equation for non-divisible package sizes", () => {
    const nonDivisible = [variant(1, 6), variant(2, 10)];
    const result = update([], "reversible", nonDivisible);
    expect(result.paths).toMatchObject([
      { sourceVariantId: 1, inputQty: "5", outputQty: "3" },
      { sourceVariantId: 2, inputQty: "3", outputQty: "5" },
    ]);
    expect(buildPackageLadder(nonDivisible, result.paths).rows[0]?.equation).toBe("5 V1 = 3 V2");
  });

  it("sorts a copy by units and excludes inactive variants from adjacency", () => {
    const reordered = [variants[2]!, { ...variant(4, 3), isActive: false }, variants[0]!, variants[1]!];
    const before = structuredClone(reordered);
    expect(buildPackageLadder(reordered, []).rows.map((row) => [row.lower.id, row.upper.id]))
      .toEqual([[1, 2], [2, 3]]);
    expect(reordered).toEqual(before);
  });

  it("preserves nonadjacent and unrelated custom paths exactly", () => {
    const nonadjacent = deriveLosslessPath(1, variants[0]!, variants[2]!);
    const custom = { ...deriveLosslessPath(2, variants[1]!, variants[2]!),
      operationType: "directed_conversion", recipeId: 71, recipeBindingKey: "warehouse:4:recipe:71",
    } satisfies PathDraft;
    const unrelatedBlocked = deriveLosslessPath(3, variants[2]!, variants[1]!, "blocked");
    const original = [nonadjacent, custom, unrelatedBlocked];
    const before = structuredClone(original);
    const changed = update(original, "reversible");
    expect(changed.paths.slice(0, 3)).toEqual(original);
    expect(changed.paths[0]).toBe(nonadjacent);
    expect(changed.paths[1]).toBe(custom);
    expect(changed.paths[2]).toBe(unrelatedBlocked);
    expect(original).toEqual(before);
    expect(buildPackageLadder(variants, changed.paths).unmanagedPaths).toEqual(original);
  });

  it("None removes only the two selected directed rows", () => {
    const other = deriveLosslessPath(1, variants[1]!, variants[2]!);
    const reversible = update([other], "reversible");
    expect(updatePackageLadderDirection({
      variants, paths: reversible.paths, lowerVariantId: 1, upperVariantId: 2,
      direction: "none", nextRowId: reversible.nextRowId,
    }).paths).toEqual([other]);
  });

  it("retains existing identities and allocates only a missing direction", () => {
    const existing = deriveLosslessPath(4, variants[0]!, variants[1]!);
    expect(update([existing], "build_up")).toEqual({ paths: [existing], nextRowId: 100 });
    const reversible = update([existing], "reversible");
    expect(reversible.paths[0]).toBe(existing);
    expect(reversible.paths[1]?.rowId).toBe(100);
    expect(reversible.nextRowId).toBe(101);
    expect(update([existing], "reversible")).toEqual(reversible);
  });

  it.each<PackageDirection>(["none", "break_down", "build_up", "reversible"])(
    "can move from %s to every supported direction without duplicate paths",
    (initialDirection) => {
      const initial = update([], initialDirection);
      for (const direction of ["none", "break_down", "build_up", "reversible"] as const) {
        const result = updatePackageLadderDirection({
          variants, paths: initial.paths, nextRowId: initial.nextRowId,
          lowerVariantId: 1, upperVariantId: 2, direction,
        });
        expect(buildPackageLadder(variants, result.paths).rows[0]?.direction).toBe(direction);
        expect(new Set(result.paths.map(path => `${path.sourceVariantId}:${path.destinationVariantId}`)).size)
          .toBe(result.paths.length);
      }
    },
  );

  it.each([
    ["blocked authority", { authorityState: "blocked" }],
    ["recipe binding", { recipeBindingKey: "recipe:71", recipeId: 71 }],
    ["unresolved recipe binding", { recipeBindingKey: "missing-recipe" }],
    ["directed conversion", { operationType: "directed_conversion" }],
    ["nonminimal batch", { inputQty: "10", outputQty: "2" }],
    ["nonconserving batch", { inputQty: "6" }],
    ["wrong operation", { operationType: "break_pack" }],
    ["noncanonical input", { inputQty: "05" }],
  ] satisfies [string, Partial<PathDraft>][])("does not disguise or rewrite %s", (_label, patch) => {
    const path = { ...deriveLosslessPath(1, variants[0]!, variants[1]!), ...patch };
    const before = structuredClone(path);
    const ladder = buildPackageLadder(variants, [path]);
    expect(ladder.rows[0]?.direction).toBeNull();
    expect(ladder.rows[0]?.issue).toBeTruthy();
    expect(ladder.unmanagedPaths).toEqual([path]);
    expect(() => update([path], "none")).toThrow();
    expect(path).toEqual(before);
  });

  it("keeps explicit blocked authority distinct from an absent path", () => {
    const blocked = deriveLosslessPath(1, variants[0]!, variants[1]!, "blocked");
    expect(buildPackageLadder(variants, []).rows[0]?.direction).toBe("none");
    expect(buildPackageLadder(variants, [blocked]).rows[0]?.issue).toContain("not None");
  });

  it("rejects duplicate directed pairs without removing either row", () => {
    const original = [deriveLosslessPath(1, variants[0]!, variants[1]!), deriveLosslessPath(2, variants[0]!, variants[1]!)];
    expect(buildPackageLadder(variants, original).unmanagedPaths).toEqual(original);
    expect(() => update(original, "none")).toThrow("Duplicate directed paths");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe unit count %s before GCD",
    (units) => {
      const invalid = [variant(1, units), variants[1]!];
      expect(buildPackageLadder(invalid, []).issues[0]).toContain("positive exact integer");
      expect(() => update([], "build_up", invalid)).toThrow("positive exact integer");
    },
  );

  it("accepts the largest supported integer unit count", () => {
    const maximum = [variant(1, 1), variant(2, 2_147_483_647)];
    expect(update([], "build_up", maximum).paths[0]?.inputQty).toBe("2147483647");
  });

  it.each([
    ["duplicate ids", [variant(1, 1), variant(1, 5)]],
    ["equal sizes", [variant(1, 5), variant(2, 5)]],
    ["mixed products", [variant(1, 1), { ...variant(2, 5), productId: 99 }]],
    ["invalid identity", [variant(0, 1), variant(2, 5)]],
  ])("fails closed for %s", (_label, invalid) => {
    expect(buildPackageLadder(invalid, []).rows).toEqual([]);
    expect(() => update([], "build_up", invalid)).toThrow();
  });

  it("rejects nonadjacent or reversed pairs", () => {
    expect(() => updatePackageLadderDirection({
      variants, paths: [], lowerVariantId: 1, upperVariantId: 3, direction: "reversible", nextRowId: 1,
    })).toThrow("Only adjacent");
    expect(() => updatePackageLadderDirection({
      variants, paths: [], lowerVariantId: 2, upperVariantId: 1, direction: "reversible", nextRowId: 1,
    })).toThrow("Only adjacent");
  });

  it("rejects invalid direction and colliding or overflowing row identities", () => {
    expect(() => update([], "unexpected" as PackageDirection)).toThrow("supported package direction");
    const path = deriveLosslessPath(100, variants[1]!, variants[2]!);
    expect(() => update([path], "build_up")).toThrow("row identities");
    expect(() => updatePackageLadderDirection({
      variants, paths: [], lowerVariantId: 1, upperVariantId: 2,
      direction: "reversible", nextRowId: Number.MAX_SAFE_INTEGER,
    })).toThrow("row identities");
  });

  it("rejects exceeding the model path limit without mutating the existing graph", () => {
    const catalog = Array.from({ length: 502 }, (_, index) => variant(index + 1, index + 1));
    const paths = catalog.slice(2).map((target, index) => deriveLosslessPath(index + 1, catalog[0]!, target));
    const before = structuredClone(paths);
    expect(() => updatePackageLadderDirection({
      variants: catalog, paths, nextRowId: 501, lowerVariantId: 1, upperVariantId: 2, direction: "reversible",
    })).toThrow("more than 500 paths");
    expect(paths).toEqual(before);
  });

  it("supports a product with zero or one active variant without inventing paths", () => {
    expect(buildPackageLadder([], [])).toEqual({ rows: [], issues: [], unmanagedPaths: [] });
    expect(buildPackageLadder([variants[0]!], []).rows).toEqual([]);
  });
});

describe("package ladder full-definition save guard", () => {
  it("allows a new model and unchanged valid package snapshots", () => {
    expect(packageLadderModelEditIssues(variants, null)).toEqual([]);
    expect(packageLadderModelEditIssues(variants, model())).toEqual([]);
  });

  it.each([
    ["network directional", null, "directional_conversion"],
    ["warehouse build", 4, "component_build"],
    ["disassembly", null, "disassembly"],
  ] satisfies [string, number | null, TransformationAdminBinding["relationshipRole"]][])(
    "blocks saving %s bindings even when current snapshots would match",
    (_label, warehouseId, relationshipRole) => {
      const original = model({ bindings: [binding({ warehouseId, relationshipRole })] });
      const before = structuredClone(original);
      expect(packageLadderModelEditIssues(variants, original)[0]).toContain("cannot save it without re-snapshotting");
      expect(original).toEqual(before);
    },
  );

  it("blocks invalid model state and malformed existing quantities", () => {
    expect(packageLadderModelEditIssues(variants, model({ validationState: "invalid" }))[0]).toContain("existing model is invalid");
    const malformed = model();
    malformed.paths[0]!.inputQty = 0;
    expect(packageLadderModelEditIssues(variants, malformed)[0]).toContain("invalid shape");
  });

  it("blocks catalog snapshot drift before a whole-definition save", () => {
    const stale = model();
    stale.paths[0]!.sourceUnitsPerVariant = 2;
    expect(packageLadderModelEditIssues(variants, stale).some((issue) => issue.includes("snapshot drift"))).toBe(true);
  });

  it.each([
    ["unknown", [variants[0]!, variants[2]!]],
    ["inactive", variants.map((item) => item.id === 2 ? { ...item, isActive: false } : item)],
  ])("blocks %s path references", (_label, changed) => {
    expect(packageLadderModelEditIssues(changed, model())[0]).toContain("distinct active variants");
  });

  it("blocks duplicate paths, wrong operations, orphan bindings, and nonconserving authority", () => {
    const duplicate = model();
    duplicate.paths.push({ ...duplicate.paths[0]! });
    expect(packageLadderModelEditIssues(variants, duplicate)[0]).toContain("repeats directed path");
    const wrongOperation = model();
    wrongOperation.paths[0]!.operationType = "break_pack";
    expect(packageLadderModelEditIssues(variants, wrongOperation)[0]).toContain("inconsistent authority");
    const orphan = model();
    orphan.paths[0]!.transformationRecipeBindingKey = "missing";
    expect(packageLadderModelEditIssues(variants, orphan)[0]).toContain("inconsistent authority");
    const nonconserving = model();
    nonconserving.paths[0]!.inputQty = 6;
    expect(packageLadderModelEditIssues(variants, nonconserving)[0]).toContain("does not conserve");
  });

  it("permits preserving a valid nonminimal custom batch or blocked path outside the edited pair", () => {
    const custom = model();
    custom.paths[0]!.inputQty = 10;
    custom.paths[0]!.outputQty = 2;
    expect(packageLadderModelEditIssues(variants, custom)).toEqual([]);
    custom.paths[0]!.authorityState = "blocked";
    custom.paths[0]!.inputQty = 9;
    expect(packageLadderModelEditIssues(variants, custom)).toEqual([]);
  });

  it("proves conservation with exact integers when products exceed Number.MAX_SAFE_INTEGER", () => {
    const catalog = [variant(1, 2_147_483_646), variant(2, 2_147_483_647)];
    const large = model({ paths: [{
      sourceVariantId: 1, destinationVariantId: 2, sourceUnitsPerVariant: 2_147_483_646,
      destinationUnitsPerVariant: 2_147_483_647, inputQty: 2_147_483_647, outputQty: 2_147_483_646,
      operationType: "assemble_pack", authorityState: "allowed", transformationRecipeBindingKey: null,
    }] });
    expect(packageLadderModelEditIssues(catalog, large)).toEqual([]);
    large.paths[0]!.outputQty -= 1;
    expect(packageLadderModelEditIssues(catalog, large)[0]).toContain("does not conserve");
  });

  it("blocks retired models, unbound build promise, and mismatched product identity", () => {
    expect(packageLadderModelEditIssues(variants, model({ lifecycleStatus: "retired" }))[0]).toContain("retired");
    expect(packageLadderModelEditIssues(variants, model({ buildToPromiseEnabled: true }))[0]).toContain("without recipe authority");
    expect(packageLadderModelEditIssues(variants, model({ productId: 99, paths: [] }))[0]).toContain("model product");
  });
});

function variant(id: number, unitsPerVariant: number): TransformationAdminVariant {
  return { id, unitsPerVariant, productId: 10, sku: `V${id}`, name: `Variant ${id}`, uomType: "pack", isActive: true };
}

function update(paths: readonly PathDraft[], direction: PackageDirection, catalog = variants) {
  return updatePackageLadderDirection({
    variants: catalog, paths, direction, lowerVariantId: 1, upperVariantId: 2, nextRowId: 100,
  });
}

function model(patch: Partial<TransformationAdminModel> = {}): TransformationAdminModel {
  return {
    id: 501, productId: 10, version: 4, lifecycleStatus: "draft", buildToPromiseEnabled: false,
    definitionHash: "a".repeat(64), origin: "operator", originInputHash: null, originResultHash: null,
    validationState: "valid", validationErrors: [], changeReason: "Test definition",
    createdBy: "operator", createdAt: "2026-09-18T12:00:00.000Z", updatedAt: "2026-09-18T12:00:00.000Z",
    bindings: [], paths: [{
      sourceVariantId: 1, destinationVariantId: 2, sourceUnitsPerVariant: 1, destinationUnitsPerVariant: 5,
      inputQty: 5, outputQty: 1, operationType: "assemble_pack", authorityState: "allowed", transformationRecipeBindingKey: null,
    }], ...patch,
  };
}

function binding(patch: Partial<TransformationAdminBinding> = {}): TransformationAdminBinding {
  return {
    bindingKey: "recipe:71", recipeId: 71, relationshipRole: "directional_conversion", warehouseId: null,
    recipeCodeSnapshot: "ASSEMBLE-P5", recipeVersionSnapshot: 1, recipeDefinitionHash: "b".repeat(64),
    outputProductIdSnapshot: 10, outputVariantIdSnapshot: 2, outputUnitsPerVariantSnapshot: 5, outputQtySnapshot: 1,
    components: [{ componentVariantId: 1, componentProductId: 10, componentUnitsPerVariant: 1, componentQty: 5 }], ...patch,
  };
}
