import { describe, expect, it, vi } from "vitest";

import {
  PIECE_SKU_SUFFIX,
  PIECE_VARIANT_NAME,
  applyPieceVariantBackfill,
  buildProposedPieceVariant,
  classifyPieceVariantCandidate,
  previewPieceVariantBackfill,
} from "../../piece-variant-backfill.service";

const FIXED_CLOCK = () => new Date("2026-09-16T12:00:00.000Z");

function variant(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    sku: "SKU",
    name: "Pack of 25",
    uomType: "pack",
    unitsPerVariant: 25,
    hierarchyLevel: 1,
    parentVariantId: null,
    isBaseUnit: false,
    isActive: true,
    requiresShipping: true,
    trackInventory: true,
    salesEligibility: "sellable",
    ...overrides,
  };
}

function candidate(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    product_id: 1,
    product_sku: "SHLZ-TOP-35PT-BLU",
    product_name: "Toploader 35pt Blue",
    product_status: "active",
    inventory_strategy: "physical_fungible",
    existing_variants: [
      variant({ id: 11, sku: "SHLZ-TOP-35PT-BLU-P25" }),
      variant({
        id: 12,
        sku: "SHLZ-TOP-35PT-BLU-C1000",
        name: "Case of 1000",
        uomType: "case",
        unitsPerVariant: 1000,
        hierarchyLevel: 3,
        parentVariantId: 11,
        salesEligibility: "internal_only",
      }),
    ],
    sku_conflict_variant_id: null,
    sku_conflict_product_id: null,
    sku_conflict_is_active: null,
    ...overrides,
  };
}

const toploaderRow = candidate();
const missingSkuRow = candidate({
  product_id: 3,
  product_sku: "   ",
  product_name: "No SKU",
  existing_variants: [variant({ id: 31, sku: "P10", unitsPerVariant: 10 })],
});
const retiredPieceRow = candidate({
  product_id: 4,
  product_sku: "SHLZ-OLDPC",
  product_name: "Retired piece",
  existing_variants: [
    variant({ id: 41, sku: "SHLZ-OLDPC-P5", unitsPerVariant: 5 }),
    variant({
      id: 42,
      sku: "SHLZ-OLDPC-PC1",
      name: "Piece",
      uomType: "piece",
      unitsPerVariant: 1,
      isBaseUnit: true,
      isActive: false,
    }),
  ],
  sku_conflict_variant_id: 42,
  sku_conflict_product_id: 4,
  sku_conflict_is_active: false,
});
const misflaggedRow = candidate({
  product_id: 5,
  product_sku: "SHLZ-FLAG",
  product_name: "Mis-flagged pack",
  existing_variants: [variant({ id: 51, sku: "SHLZ-FLAG-P12", unitsPerVariant: 12, isBaseUnit: true })],
});
const conflictRow = candidate({
  product_id: 6,
  product_sku: "SHLZ-CONFLICT",
  product_name: "Conflict",
  existing_variants: [variant({ id: 61, sku: "SHLZ-CONFLICT-P4", unitsPerVariant: 4 })],
  sku_conflict_variant_id: 71,
  sku_conflict_product_id: 7,
  sku_conflict_is_active: true,
});
const recipeDraftRow = candidate({
  product_id: 11,
  product_sku: "SHLZ-KIT",
  product_name: "Kit",
  product_status: "draft",
  inventory_strategy: "recipe_managed",
  existing_variants: [variant({ id: 111, sku: "SHLZ-KIT-P5", unitsPerVariant: 5 })],
});

const ALL_ROWS = [toploaderRow, missingSkuRow, retiredPieceRow, misflaggedRow, conflictRow, recipeDraftRow];

function queryableFor(rows: unknown[]) {
  return { query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }) };
}

describe("piece variant backfill preview", () => {
  it("uses the product page's piece conventions", () => {
    expect(PIECE_SKU_SUFFIX).toBe("-PC1");
    expect(PIECE_VARIANT_NAME).toBe("Piece");
    expect(buildProposedPieceVariant("SHLZ-TOP-35PT-BLU")).toEqual({
      sku: "SHLZ-TOP-35PT-BLU-PC1",
      name: "Piece",
      uomType: "piece",
      unitsPerVariant: 1,
      hierarchyLevel: 1,
      parentVariantId: null,
      isBaseUnit: true,
      salesEligibility: "internal_only",
      requiresShipping: true,
      trackInventory: true,
      isActive: true,
      dropshipEligible: false,
    });
  });

  it("proposes one internal-only piece for a pack-only product", () => {
    const target = classifyPieceVariantCandidate(toploaderRow);
    expect(target).toMatchObject({
      productId: 1,
      productSku: "SHLZ-TOP-35PT-BLU",
      action: "create_piece_variant",
      warnings: [],
      blockers: [],
      skuConflict: null,
    });
    expect(target.proposedVariant?.sku).toBe("SHLZ-TOP-35PT-BLU-PC1");
    expect(target.existingVariants.map((entry) => entry.id)).toEqual([11, 12]);
  });

  it("blocks rather than guesses when the SKU, a retired piece, a mis-flag, or a collision is in the way", () => {
    expect(classifyPieceVariantCandidate(missingSkuRow)).toMatchObject({
      action: "blocked",
      productSku: null,
      proposedVariant: null,
      blockers: ["product_sku_missing"],
    });
    expect(classifyPieceVariantCandidate(retiredPieceRow)).toMatchObject({
      action: "blocked",
      blockers: ["proposed_sku_already_used", "inactive_single_unit_variant_exists"],
      skuConflict: { variantId: 42, productId: 4, isActive: false },
    });
    expect(classifyPieceVariantCandidate(misflaggedRow)).toMatchObject({
      action: "blocked",
      blockers: ["base_unit_flag_on_multi_unit_variant"],
    });
    expect(classifyPieceVariantCandidate(conflictRow)).toMatchObject({
      action: "blocked",
      blockers: ["proposed_sku_already_used"],
      skuConflict: { variantId: 71, productId: 7, isActive: true },
    });
    expect(classifyPieceVariantCandidate(candidate({
      product_sku: "X".repeat(97),
    }))).toMatchObject({
      action: "blocked",
      blockers: ["proposed_sku_too_long"],
    });
  });

  it("warns, but still proposes, for recipe-managed and non-active-status products", () => {
    expect(classifyPieceVariantCandidate(recipeDraftRow)).toMatchObject({
      action: "create_piece_variant",
      warnings: ["recipe_managed_product", "product_status_not_active"],
      blockers: [],
    });
  });

  it("refuses a row that already carries an active one-piece variant", () => {
    expect(() => classifyPieceVariantCandidate(candidate({
      existing_variants: [variant({ id: 1, unitsPerVariant: 1, isBaseUnit: true, uomType: "each" })],
    }))).toThrow("candidate query drift");
  });

  it("summarizes every candidate and fingerprints them independently of the clock", async () => {
    const first = await previewPieceVariantBackfill(queryableFor(ALL_ROWS) as any, { clock: FIXED_CLOCK });
    const second = await previewPieceVariantBackfill(queryableFor(ALL_ROWS) as any, {
      clock: () => new Date("2027-01-01T00:00:00.000Z"),
    });

    expect(first.generatedAt).toBe("2026-09-16T12:00:00.000Z");
    expect(first.previewHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.previewHash).toBe(first.previewHash);
    expect(first.pieceSkuSuffix).toBe("-PC1");
    expect(first.summary).toEqual({
      candidateProducts: 6,
      productsToCreate: 2,
      blockedProducts: 4,
      blockerCounts: {
        product_sku_missing: 1,
        proposed_sku_too_long: 0,
        proposed_sku_already_used: 2,
        inactive_single_unit_variant_exists: 1,
        base_unit_flag_on_multi_unit_variant: 1,
      },
      warningCounts: {
        recipe_managed_product: 1,
        product_status_not_active: 1,
      },
    });
    const queryable = queryableFor(ALL_ROWS);
    await previewPieceVariantBackfill(queryable as any, { clock: FIXED_CLOCK });
    expect(queryable.query).toHaveBeenCalledWith(expect.stringContaining("sku_conflict_variant_id"), ["-PC1"]);
  });

  it("changes the fingerprint when a candidate changes", async () => {
    const before = await previewPieceVariantBackfill(queryableFor([toploaderRow]) as any, { clock: FIXED_CLOCK });
    const after = await previewPieceVariantBackfill(queryableFor([
      candidate({ product_sku: "SHLZ-TOP-35PT-BLK" }),
    ]) as any, { clock: FIXED_CLOCK });
    expect(after.previewHash).not.toBe(before.previewHash);
  });
});

type RecordedCall = { sql: string; values?: unknown[] };

function stubbedApplyClient(options: {
  candidateRows: unknown[];
  insertRowCount?: number;
  actorRows?: number;
}) {
  const calls: RecordedCall[] = [];
  let nextVariantId = 1000;
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes("SELECT id FROM public.users")) {
        const rowCount = options.actorRows ?? 1;
        return { rows: rowCount ? [{ id: values?.[0] }] : [], rowCount };
      }
      if (sql.includes("FOR UPDATE OF p")) {
        return {
          rows: (options.candidateRows as Array<{ product_id: number }>).map((row) => ({ product_id: row.product_id })),
          rowCount: options.candidateRows.length,
        };
      }
      if (sql.includes("product_id = ANY($1::int[])")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("sku_conflict_variant_id")) {
        return { rows: options.candidateRows, rowCount: options.candidateRows.length };
      }
      if (sql.includes("INSERT INTO catalog.product_variants")) {
        const rowCount = options.insertRowCount ?? 1;
        nextVariantId += 1;
        return {
          rows: rowCount
            ? [{ row: { id: nextVariantId, product_id: values?.[0], sku: values?.[1], uom_type: values?.[3] } }]
            : [],
          rowCount,
        };
      }
      if (sql.includes("INSERT INTO public.audit_events")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: null };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn().mockResolvedValue(client) };
  return { calls, client, pool };
}

describe("piece variant backfill apply", () => {
  it("rejects a blank actor or malformed hash before touching the database", async () => {
    const pool = { connect: vi.fn() };
    await expect(applyPieceVariantBackfill({
      pool: pool as any,
      actorId: "   ",
      expectedPreviewHash: "a".repeat(64),
    })).rejects.toThrow("actorId is required");
    await expect(applyPieceVariantBackfill({
      pool: pool as any,
      actorId: "user-1",
      expectedPreviewHash: "nope",
    })).rejects.toThrow("SHA-256");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("locks, re-derives, inserts each reviewed piece, and audits inside one serializable transaction", async () => {
    const preview = await previewPieceVariantBackfill(queryableFor(ALL_ROWS) as any, { clock: FIXED_CLOCK });
    const { calls, client, pool } = stubbedApplyClient({ candidateRows: ALL_ROWS });

    const result = await applyPieceVariantBackfill({
      pool: pool as any,
      actorId: "user-1",
      expectedPreviewHash: preview.previewHash,
      clock: FIXED_CLOCK,
    });

    expect(result).toEqual({
      mode: "apply",
      contractVersion: 1,
      previewHash: preview.previewHash,
      actorId: "user-1",
      createdVariants: [
        { productId: 1, productSku: "SHLZ-TOP-35PT-BLU", variantId: 1001, sku: "SHLZ-TOP-35PT-BLU-PC1" },
        { productId: 11, productSku: "SHLZ-KIT", variantId: 1002, sku: "SHLZ-KIT-PC1" },
      ],
      blockedProducts: 4,
      auditedVariants: 2,
    });

    expect(calls[0].sql).toBe("BEGIN ISOLATION LEVEL SERIALIZABLE");
    expect(calls[1].sql).toContain("pg_advisory_xact_lock");
    expect(calls[2].sql).toContain("SELECT id FROM public.users");
    expect(calls[2].values).toEqual(["user-1"]);
    expect(calls[3].sql).toContain("FOR UPDATE OF p");
    expect(calls[4].sql).toContain("product_id = ANY($1::int[])");
    expect(calls[4].values).toEqual([[1, 3, 4, 5, 6, 11]]);

    const inserts = calls.filter((call) => call.sql.includes("INSERT INTO catalog.product_variants"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0].values).toEqual([
      1, "SHLZ-TOP-35PT-BLU-PC1", "Piece", "piece", 1, 1, true, "internal_only", true, true, true, false,
    ]);
    expect(inserts[0].sql).toContain("WHERE NOT EXISTS");

    const audits = calls.filter((call) => call.sql.includes("INSERT INTO public.audit_events"));
    expect(audits).toHaveLength(2);
    expect(audits[0].values?.[0]).toEqual(FIXED_CLOCK());
    expect(audits[0].values?.[1]).toBe("user:user-1");
    expect(audits[0].values?.[2]).toBe("product_variant:1001");
    expect(JSON.parse(audits[0].values?.[3] as string)).toEqual({
      before: null,
      after: { id: 1001, product_id: 1, sku: "SHLZ-TOP-35PT-BLU-PC1", uom_type: "piece" },
    });
    expect(JSON.parse(audits[0].values?.[4] as string)).toMatchObject({
      contractVersion: 1,
      source: "piece_variant_backfill",
      reason: "receiving_piece_variant_required",
      previewHash: preview.previewHash,
      productId: 1,
      productSku: "SHLZ-TOP-35PT-BLU",
      existingVariantIds: [11, 12],
      warnings: [],
    });
    expect(JSON.parse(audits[1].values?.[4] as string)).toMatchObject({
      productId: 11,
      warnings: ["recipe_managed_product", "product_status_not_active"],
    });

    expect(calls.at(-1)?.sql).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("writes nothing and rolls back when the catalog no longer matches the reviewed preview", async () => {
    const { calls, client, pool } = stubbedApplyClient({ candidateRows: ALL_ROWS });

    await expect(applyPieceVariantBackfill({
      pool: pool as any,
      actorId: "user-1",
      expectedPreviewHash: "b".repeat(64),
      clock: FIXED_CLOCK,
    })).rejects.toThrow("Catalog changed after preview");

    expect(calls.some((call) => call.sql.includes("INSERT INTO"))).toBe(false);
    expect(calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("aborts the whole run when a guarded insert finds a piece that appeared mid-transaction", async () => {
    const preview = await previewPieceVariantBackfill(queryableFor([toploaderRow]) as any, { clock: FIXED_CLOCK });
    const { calls, pool } = stubbedApplyClient({ candidateRows: [toploaderRow], insertRowCount: 0 });

    await expect(applyPieceVariantBackfill({
      pool: pool as any,
      actorId: "user-1",
      expectedPreviewHash: preview.previewHash,
      clock: FIXED_CLOCK,
    })).rejects.toThrow("changed during backfill");

    expect(calls.some((call) => call.sql.includes("INSERT INTO public.audit_events"))).toBe(false);
    expect(calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("requires the actor to be a real application user", async () => {
    const { calls, pool } = stubbedApplyClient({ candidateRows: [toploaderRow], actorRows: 0 });

    await expect(applyPieceVariantBackfill({
      pool: pool as any,
      actorId: "ghost",
      expectedPreviewHash: "a".repeat(64),
      clock: FIXED_CLOCK,
    })).rejects.toThrow("existing application user");

    expect(calls.some((call) => call.sql.includes("FOR UPDATE"))).toBe(false);
    expect(calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("is a no-op when only blocked products remain", async () => {
    const preview = await previewPieceVariantBackfill(queryableFor([missingSkuRow, conflictRow]) as any, { clock: FIXED_CLOCK });
    const { calls, pool } = stubbedApplyClient({ candidateRows: [missingSkuRow, conflictRow] });

    const result = await applyPieceVariantBackfill({
      pool: pool as any,
      actorId: "user-1",
      expectedPreviewHash: preview.previewHash,
      clock: FIXED_CLOCK,
    });

    expect(result).toMatchObject({ createdVariants: [], blockedProducts: 2, auditedVariants: 0 });
    expect(calls.some((call) => call.sql.includes("INSERT INTO"))).toBe(false);
    expect(calls.at(-1)?.sql).toBe("COMMIT");
  });
});
