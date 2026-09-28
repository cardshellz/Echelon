import { describe, expect, it } from "vitest";
import type { ChannelCatalogRow } from "@shared/types/channel-catalog";
import {
  listingDraftItemSchema,
  type ListingCatalogItem,
  type ListingOperation,
  type ListingOperationItem,
} from "@shared/types/channel-listing-publication";
import { buildListingFeedRows, type ListingFeedInput } from "../feed-model";

function catalog(
  variantId: number,
  sku = `SKU-${variantId}`,
): ListingCatalogItem {
  return {
    variantId,
    productId: 10,
    sku,
    name: "Card sleeves",
    variantName: "100 pack",
    unitLabel: "100 sleeves",
    productType: "sleeves",
    title: "Card sleeves",
    description: null,
    brand: null,
    images: [],
    identifier: null,
    priceCents: 499,
    basePriceCents: 499,
    priceSource: "catalog_variant",
    appliedRule: null,
    appliedRuleScope: null,
    eligible: true,
    alreadyLinked: false,
    sourceHash: "a".repeat(64),
  };
}
function remote(
  sku: string,
  overrides: Partial<ChannelCatalogRow> = {},
): ChannelCatalogRow {
  return {
    sku,
    title: "Account listing",
    externalProductId: `product-${sku}`,
    externalVariantId: sku,
    externalInventoryItemId: sku,
    lifecycleStatus: "ACTIVE",
    publishedStatus: "PUBLISHED",
    mappingStatus: "unmatched",
    variant: null,
    message: null,
    ...overrides,
  };
}
function item(
  variantId: number,
  sku = `SKU-${variantId}`,
): ListingOperationItem {
  return {
    variantId,
    sku,
    priceCents: 499,
    state: "verified",
    externalProductId: `product-${sku}`,
    error: null,
    stockState: "setup_required",
    canRetry: false,
  };
}
function operation(
  id: number,
  items: ListingOperationItem[],
  createdAt = "2026-09-28T12:00:00.000Z",
): ListingOperation {
  return {
    id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    channelId: 104,
    state: "completed",
    submissionId: `feed-${id}`,
    items,
    createdAt,
    updatedAt: createdAt,
    error: null,
  };
}
function input(overrides: Partial<ListingFeedInput> = {}): ListingFeedInput {
  return {
    draftItems: [],
    metadata: new Map(),
    operations: [],
    catalogItems: [],
    sku: "",
    ...overrides,
  };
}
const draft = (variantId: number, title: string | null = null) =>
  listingDraftItemSchema.parse({
    variantId,
    title,
    priceOverrideCents: 549,
    attributes: { color: "Blue" },
  });

describe("unified channel listing feed projection", () => {
  it("combines a draft, submission and account listing into one exact-SKU row without replacing draft edits", () => {
    const selected = draft(1, "My edited title");
    const source = catalog(1);
    const accountItem = remote("SKU-1");
    const submitted = operation(1, [item(1)]);
    const rows = buildListingFeedRows(
      input({
        draftItems: [selected],
        metadata: new Map([[1, source]]),
        operations: [submitted],
        catalogItems: [accountItem],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sku: "SKU-1",
      draft: selected,
      catalog: source,
      remote: accountItem,
      operation: { id: submitted.id, item: submitted.items[0] },
    });
    expect(rows[0].draft).toBe(selected);
    expect(rows[0].draft?.title).toBe("My edited title");
    expect(rows[0].draft?.priceOverrideCents).toBe(549);
    expect(rows[0].issue).toContain("already has a listing");
  });

  it("never merges by a suggested or linked variant when seller SKUs differ", () => {
    for (const mappingStatus of ["matched", "linked"] as const) {
      const rows = buildListingFeedRows(
        input({
          draftItems: [draft(1)],
          metadata: new Map([[1, catalog(1)]]),
          catalogItems: [
            remote("OTHER-SKU", {
              mappingStatus,
              variant: {
                id: 1,
                sku: "SKU-1",
                name: "Suggested",
                eligible: true,
              },
            }),
          ],
        }),
      );
      expect(rows.map((row) => row.sku)).toEqual(["SKU-1", "OTHER-SKU"]);
      expect(rows[0].remote).toBeNull();
      expect(rows[1].draft).toBeNull();
    }
  });

  it("does not treat a suggested variant as an established conflicting mapping", () => {
    const rows = buildListingFeedRows(
      input({
        operations: [operation(1, [item(1)])],
        catalogItems: [
          remote("SKU-1", {
            mappingStatus: "matched",
            variant: {
              id: 2,
              sku: "SKU-1",
              name: "Suggestion",
              eligible: true,
            },
          }),
        ],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].issue).toBeNull();
    expect(rows[0].remote?.mappingStatus).toBe("matched");
  });

  it("keeps seller SKU case significant across all three sources", () => {
    const rows = buildListingFeedRows(
      input({
        draftItems: [draft(1)],
        metadata: new Map([[1, catalog(1, "Sku")]]),
        operations: [operation(1, [item(2, "SKU")])],
        catalogItems: [remote("sku")],
      }),
    );
    expect(rows.map((row) => row.sku)).toEqual(["Sku", "SKU", "sku"]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
  });

  it.each(["missing", "empty", "wrong-variant"] as const)(
    "retains an unknown draft identity when metadata is %s without inferring its SKU from an operation or remote variant",
    (state) => {
      const metadata =
        state === "missing"
          ? new Map<number, ListingCatalogItem>()
          : new Map([[1, state === "empty" ? catalog(1, "  ") : catalog(2)]]);
      const rows = buildListingFeedRows(
        input({
          draftItems: [draft(1)],
          metadata,
          operations: [operation(1, [item(1)])],
          catalogItems: [
            remote("SKU-1", {
              mappingStatus: "matched",
              variant: {
                id: 1,
                sku: "SKU-1",
                name: "Suggestion",
                eligible: true,
              },
            }),
          ],
        }),
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        key: "variant:1",
        sku: null,
        remote: null,
        operation: null,
      });
      expect(rows[0].draft?.variantId).toBe(1);
      expect(rows[0].issue).toContain("SKU is unavailable");
      expect(rows[1]).toMatchObject({ sku: "SKU-1", draft: null });
    },
  );

  it("chooses latest creation time per exact SKU and resolves equal times by stable ID regardless of input order", () => {
    const older = operation(9, [item(1)], "2026-09-27T12:00:00.000Z");
    older.updatedAt = "2026-09-29T12:00:00.000Z";
    const lowerId = operation(1, [item(1)], "2026-09-28T08:00:00-04:00");
    const newer = operation(2, [item(1)]);
    for (const operations of [
      [older, newer, lowerId],
      [lowerId, newer, older],
    ]) {
      const rows = buildListingFeedRows(input({ operations }));
      expect(rows).toHaveLength(1);
      expect(rows[0].operation?.id).toBe(newer.id);
    }
  });

  it("keeps invalid creation timestamps behind valid submissions and uses the same ID tie-break", () => {
    const valid = operation(1, [item(1)]);
    const unknownTime = operation(9, [item(1)], "invalid timestamp");
    expect(
      buildListingFeedRows(input({ operations: [unknownTime, valid] }))[0]
        .operation?.id,
    ).toBe(valid.id);
    const lowerId = operation(2, [item(1)], "");
    for (const operations of [
      [lowerId, unknownTime],
      [unknownTime, lowerId],
    ])
      expect(buildListingFeedRows(input({ operations }))[0].operation?.id).toBe(
        unknownTime.id,
      );
  });

  it("orders drafts first, recent submissions next and remote-only items last while retaining off-page submissions", () => {
    const rows = buildListingFeedRows(
      input({
        draftItems: [draft(2), draft(1)],
        metadata: new Map([
          [1, catalog(1)],
          [2, catalog(2)],
        ]),
        operations: [
          operation(1, [item(3)], "2026-09-27T12:00:00.000Z"),
          operation(2, [item(4), item(2)]),
        ],
        catalogItems: [remote("SKU-3"), remote("SKU-5"), remote("SKU-6")],
      }),
    );
    expect(rows.map((row) => row.sku)).toEqual([
      "SKU-2",
      "SKU-1",
      "SKU-4",
      "SKU-3",
      "SKU-5",
      "SKU-6",
    ]);
    expect(rows[2]).toMatchObject({ sku: "SKU-4", remote: null });
    expect(rows[3].remote?.sku).toBe("SKU-3");
  });

  it("applies explicit exact SKU search to drafts, submissions and remote rows, including trimming only the search input", () => {
    const source = input({
      draftItems: [draft(1), draft(2)],
      metadata: new Map([[1, catalog(1)]]),
      operations: [operation(1, [item(3)])],
      catalogItems: [remote("SKU-4"), remote("SKU-10")],
    });
    for (const sku of ["SKU-1", "SKU-3", "SKU-4"])
      expect(
        buildListingFeedRows({ ...source, sku: ` ${sku} ` }).map(
          (row) => row.sku,
        ),
      ).toEqual([sku]);
    expect(buildListingFeedRows({ ...source, sku: "SKU" })).toEqual([]);
    expect(buildListingFeedRows({ ...source, sku: "sku-1" })).toEqual([]);
    expect(buildListingFeedRows({ ...source, sku: " " })).toHaveLength(5);
  });

  it("preserves every conflicting draft variant and its edits with distinct keys", () => {
    const selected = [draft(1, "First title"), draft(2, "Second title")];
    const rows = buildListingFeedRows(
      input({
        draftItems: selected,
        metadata: new Map([
          [1, catalog(1, "SAME")],
          [2, catalog(2, "SAME")],
        ]),
        operations: [operation(1, [item(1, "SAME")])],
        catalogItems: [remote("SAME")],
      }),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.draft)).toEqual(selected);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
    expect(
      rows.every((row) => row.issue?.includes("Multiple draft variants")),
    ).toBe(true);
    expect(rows.every((row) => row.remote?.sku === "SAME")).toBe(true);
  });

  it("flags a latest submitted identity or established account mapping that belongs to another variant", () => {
    const source = input({
      draftItems: [draft(1)],
      metadata: new Map([[1, catalog(1)]]),
    });
    const submitted = buildListingFeedRows({
      ...source,
      operations: [operation(1, [item(2, "SKU-1")])],
    });
    expect(submitted[0].issue).toContain(
      "submitted for a different Echelon variant",
    );
    const linked = buildListingFeedRows({
      ...source,
      catalogItems: [
        remote("SKU-1", {
          mappingStatus: "linked",
          variant: {
            id: 2,
            sku: "SKU-1",
            name: "Linked variant",
            eligible: true,
          },
        }),
      ],
    });
    expect(linked[0].issue).toContain("linked to a different Echelon variant");
  });

  it("flags already-linked draft metadata even when its account listing is on another page", () => {
    const rows = buildListingFeedRows(
      input({
        draftItems: [draft(1)],
        metadata: new Map([[1, { ...catalog(1), alreadyLinked: true }]]),
      }),
    );
    expect(rows[0].remote).toBeNull();
    expect(rows[0].issue).toContain("already has a listing");
  });

  it("deduplicates repeated account SKUs and surfaces ambiguity instead of silently choosing an identity", () => {
    const rows = buildListingFeedRows(
      input({
        catalogItems: [
          remote("SKU-1"),
          remote("SKU-1", { externalProductId: "other-product" }),
        ],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].issue).toContain("duplicate records");
  });

  it("retains an account-reported identity conflict even without a local draft", () => {
    const rows = buildListingFeedRows(
      input({
        catalogItems: [
          remote("SKU-1", {
            mappingStatus: "conflict",
            message: "Two Echelon variants claim this seller SKU.",
          }),
        ],
      }),
    );
    expect(rows[0].issue).toBe("Two Echelon variants claim this seller SKU.");
  });

  it("does not mutate frozen drafts, metadata, submissions, or the account page", () => {
    const source = input({
      draftItems: [draft(1)],
      metadata: new Map([[1, catalog(1)]]),
      operations: [
        operation(1, [item(1)], "2026-09-27T12:00:00.000Z"),
        operation(2, [item(2)]),
      ],
      catalogItems: [remote("SKU-1")],
    });
    const before = structuredClone(source);
    function freeze(value: unknown): void {
      if (value === null || typeof value !== "object") return;
      if (value instanceof Map)
        for (const entry of value.values()) freeze(entry);
      else for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    freeze(source);
    expect(() => buildListingFeedRows(source)).not.toThrow();
    expect(source).toEqual(before);
  });
});
