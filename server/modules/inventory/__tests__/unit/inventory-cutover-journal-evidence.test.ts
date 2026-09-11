import { describe, expect, it } from "vitest";
import { aggregateCutoverJournalEvidence, CutoverJournalAccumulator, type CutoverJournalRow, MAX_CUTOVER_JOURNAL_ROWS } from "../../domain/inventory-cutover-journal-evidence";
import { cutoverReconstructionJournalSchema } from "@shared/types/inventory-cutover-reconstruction";

function row(overrides: Partial<CutoverJournalRow> = {}): CutoverJournalRow {
  return { id: 1, orderId: 10, orderItemId: 20, productVariantId: 30, fromLocationId: null, toLocationId: 40,
    transactionType: "reserve", variantQtyDelta: 0, reservedQtyDelta: 3, sourceState: "on_hand",
    shipmentId: null, shipmentItemId: null, itemId: 20, itemOrderId: 10, itemOrderWarehouseId: 1,
    directShipmentId: null, directShipmentOrderId: null, directShipmentStatus: null,
    sourceId: null, sourceShipmentId: null, sourceOrderItemId: null, sourceItemId: null, sourceItemOrderId: null,
    sourceHeaderId: null, sourceHeaderOrderId: null, sourceOrderWarehouseId: null,
    sourceVariantId: null, sourceLocationId: null, sourceQty: null, sourcePurpose: null,
    sourceReplacementItemId: null, sourceCorrectionItemId: null, sourceStatus: null, sourceRequiresReview: null,
    fromWarehouseId: null, toWarehouseId: 1, journalHash: "a".repeat(64), linkHash: "b".repeat(64), ...overrides };
}
function sourceRow(overrides: Partial<CutoverJournalRow> = {}): CutoverJournalRow {
  return row({ orderId: null, orderItemId: null, itemId: null, itemOrderId: null, itemOrderWarehouseId: null,
    transactionType: "pick", variantQtyDelta: -2, reservedQtyDelta: -2, fromLocationId: 40, toLocationId: null,
    fromWarehouseId: 1, toWarehouseId: null, shipmentId: 50, shipmentItemId: 60,
    directShipmentId: 50, directShipmentOrderId: 10, directShipmentStatus: "planned",
    sourceId: 60, sourceShipmentId: 50, sourceOrderItemId: 20, sourceItemId: 20, sourceItemOrderId: 10,
    sourceHeaderId: 50, sourceHeaderOrderId: 10, sourceOrderWarehouseId: 1, sourceVariantId: 30,
    sourceLocationId: 40, sourceQty: 3, sourcePurpose: "customer_fulfillment", sourceStatus: "planned", sourceRequiresReview: false,
    ...overrides });
}
function issueCodes(input: CutoverJournalRow): string[] { return aggregateCutoverJournalEvidence([input])[0].issues!.map((issue) => issue.code); }

describe("cutover exact foreign-key journal identity and unknown causes", () => {
  it("produces identical groups and hashes across bounded batches and rejects boundary duplicates", () => {
    const rows = Array.from({length:1001},(_,index)=>row({id:index+1, reservedQtyDelta:index%2?null:3}));
    const accumulator = new CutoverJournalAccumulator();
    for (const offset of [0,500,1000]) for (const item of rows.slice(offset,offset+500)) accumulator.add(item);
    expect(accumulator.finish()).toEqual(aggregateCutoverJournalEvidence(rows));
    const duplicate = new CutoverJournalAccumulator(); duplicate.add(rows[500]);
    expect(()=>duplicate.add(rows[500])).toThrow(expect.objectContaining({code:"CUTOVER_JOURNAL_DUPLICATE_ID"}));
  });
  it("completes only a NULL order through its directly recorded item, without mutation", () => {
    const input = row({ orderId: null }); const before = structuredClone(input);
    expect(aggregateCutoverJournalEvidence([input])[0]).toMatchObject({ orderId: 10, orderItemId: 20, reservedQty: "3",
      pickedQty: "0", identityCompletedCount: "1", unknownCount: "0", issues: [] });
    expect(input).toEqual(before);
  });
  it("merges a source-FK-completed pick with the exact reserve owner", () => {
    expect(aggregateCutoverJournalEvidence([row(), sourceRow({ id: 2 })])).toMatchObject([
      { orderId: 10, orderItemId: 20, reservedQty: "1", pickedQty: "2", journalCount: "2", identityCompletedCount: "1", issues: [] },
    ]);
  });
  it.each([
    ["recorded order conflict", { orderId: 11 }, "OWNER_FOREIGN_KEY_CONFLICT"],
    ["missing source", { sourceId: null }, "OWNER_FOREIGN_KEY_MISSING"],
    ["missing source item", { sourceItemId: null }, "OWNER_FOREIGN_KEY_MISSING"],
    ["missing header", { sourceHeaderId: null }, "OWNER_FOREIGN_KEY_MISSING"],
    ["header item mismatch", { sourceHeaderOrderId: 11 }, "OWNER_FOREIGN_KEY_CONFLICT"],
    ["recorded shipment conflict", { shipmentId: 51, directShipmentId: 51 }, "OWNER_FOREIGN_KEY_CONFLICT"],
    ["source variant mismatch", { sourceVariantId: 31 }, "OWNER_FOREIGN_KEY_CONFLICT"],
    ["missing variant", { productVariantId: null }, "OWNER_FOREIGN_KEY_CONFLICT"],
    ["replacement purpose", { sourcePurpose: "replacement" }, "SOURCE_PURPOSE_UNSUPPORTED"],
    ["replacement lineage", { sourceReplacementItemId: 20 }, "SOURCE_PURPOSE_UNSUPPORTED"],
    ["correction lineage", { sourceCorrectionItemId: 60 }, "SOURCE_PURPOSE_UNSUPPORTED"],
    ["zero source", { sourceQty: 0 }, "SOURCE_PURPOSE_UNSUPPORTED"],
    ["negative source", { sourceQty: -1 }, "SOURCE_PURPOSE_UNSUPPORTED"],
    ["voided source", { sourceStatus: "voided" }, "SOURCE_LIFECYCLE_UNSAFE"],
    ["review source", { sourceRequiresReview: true }, "SOURCE_LIFECYCLE_UNSAFE"],
    ["source location conflict", { sourceLocationId: 41 }, "LOCATION_IDENTITY_UNRESOLVED"],
    ["warehouse conflict", { sourceOrderWarehouseId: 2 }, "LOCATION_IDENTITY_UNRESOLVED"],
    ["dual location", { toLocationId: 41, toWarehouseId: 1 }, "LOCATION_IDENTITY_UNRESOLVED"],
    ["missing source bin", { sourceLocationId: null }, "LOCATION_IDENTITY_UNRESOLVED"],
  ] as const)("does not complete %s", (_name, changes, code) => {
    const input = sourceRow(changes); const result = aggregateCutoverJournalEvidence([input])[0];
    expect(result).toMatchObject({ orderId: input.orderId, orderItemId: null, identityCompletedCount: "0", unknownCount: "1" });
    expect(issueCodes(input)).toContain(code);
  });
  it("does not prefer a direct item FK over a conflicting source FK", () => {
    const input = sourceRow({ orderItemId: 21, itemId: 21, itemOrderId: 10, itemOrderWarehouseId: 1 });
    expect(aggregateCutoverJournalEvidence([input])[0]).toMatchObject({ orderId: null, orderItemId: 21, identityCompletedCount: "0" });
    expect(issueCodes(input)).toContain("OWNER_FOREIGN_KEY_CONFLICT");
  });
  it.each([10, null])("keeps a legacy replacement journal association unsupported without calling it a conflicting customer FK (order: %s)", (orderId) => {
    const input = sourceRow({ orderId, orderItemId: 20, itemId: 20, itemOrderId: 10, itemOrderWarehouseId: 1,
      transactionType: "ship", variantQtyDelta: -2, reservedQtyDelta: null, sourceState: "picked",
      sourceOrderItemId: null, sourceItemId: null, sourceItemOrderId: null,
      sourcePurpose: "replacement", sourceReplacementItemId: 20 });
    expect(aggregateCutoverJournalEvidence([input])[0]).toMatchObject({ orderId, orderItemId: 20,
      identityCompletedCount: "0", unknownCount: "1", pickedQty: "-2", shippedQty: "2",
      issues: [{ code: "SOURCE_PURPOSE_UNSUPPORTED", transactionCount: "1", transactionIds: [1] }] });
  });
  it.each([
    { sourcePurpose: "concession" },
    { sourceReplacementItemId: 20 },
    { sourceCorrectionItemId: 60 },
  ])("blocks noncustomer purpose or lineage even with a matching direct item FK: %#", (change) => {
    const input = sourceRow({ orderItemId: 20, itemId: 20, itemOrderId: 10, itemOrderWarehouseId: 1, ...change });
    expect(aggregateCutoverJournalEvidence([input])[0]).toMatchObject({ orderId: null,
      identityCompletedCount: "0", issues: [{ code: "SOURCE_PURPOSE_UNSUPPORTED" }] });
  });
  it.each([{ sourceId: null }, { sourceHeaderId: null }])("retains missing source/header evidence for replacement associations: %#", (change) => {
    const input = sourceRow({ orderItemId: 20, itemId: 20, itemOrderId: 10, itemOrderWarehouseId: 1,
      sourcePurpose: "replacement", sourceReplacementItemId: 20, ...change });
    expect(issueCodes(input)).toEqual(["OWNER_FOREIGN_KEY_MISSING"]);
  });
  it.each([
    ["other order", { directShipmentOrderId: 11 }, "OWNER_FOREIGN_KEY_CONFLICT"],
    ["missing header", { directShipmentId: null }, "OWNER_FOREIGN_KEY_MISSING"],
    ["voided header", { directShipmentStatus: "voided" }, "SOURCE_LIFECYCLE_UNSAFE"],
  ] as const)("does not complete a direct item against a recorded shipment with %s", (_name, changes, code) => {
    const input = row({ orderId: null, shipmentId: 50, directShipmentId: 50, directShipmentOrderId: 10, directShipmentStatus: "planned", ...changes });
    expect(aggregateCutoverJournalEvidence([input])[0]).toMatchObject({ orderId: null, orderItemId: 20, identityCompletedCount: "0" });
    expect(issueCodes(input)).toContain(code);
  });
  it("preserves an existing order/item conflict and an orphan instead of overwriting", () => {
    expect(aggregateCutoverJournalEvidence([row({ orderId: 11 })])[0]).toMatchObject({ orderId: 11, orderItemId: 20, unknownCount: "1" });
    expect(issueCodes(row({ itemId: null }))).toContain("OWNER_FOREIGN_KEY_MISSING");
  });
  it("leaves an unlinked missing owner unchanged, with its signed residual", () => {
    expect(aggregateCutoverJournalEvidence([row({ orderId: null, orderItemId: null, itemId: null, itemOrderId: null })])[0])
      .toMatchObject({ orderId: null, orderItemId: null, reservedQty: "3", identityCompletedCount: "0" });
  });
  it("never supplies a missing reservation quantity when the owner identity resolves", () => {
    expect(aggregateCutoverJournalEvidence([sourceRow({ reservedQtyDelta: null })])[0]).toMatchObject({
      orderId: 10, orderItemId: 20, reservedQty: "0", pickedQty: "2", unknownCount: "1",
      issues: [{ code: "RESERVATION_DELTA_MISSING", transactionCount: "1", transactionIds: [1] }],
    });
  });
  it("keeps mixed/direct shipment bucket and missing physical quantity distinct", () => {
    const result = aggregateCutoverJournalEvidence([sourceRow({ transactionType: "ship", variantQtyDelta: null })])[0];
    expect(result).toMatchObject({ pickedQty: "0", shippedQty: "0", unknownCount: "1" });
    expect(result.issues!.map((issue) => issue.code)).toEqual(["PHYSICAL_DELTA_MISSING", "SHIPMENT_BUCKET_SPLIT_UNRECORDED"]);
  });
  it("retains aggregate reserve_move at BOTH bins without assigning any owner delta", () => {
    const result = aggregateCutoverJournalEvidence([row({ transactionType: "reserve_move", fromLocationId: 41,
      variantQtyDelta: 3, reservedQtyDelta: null, orderId: null, orderItemId: null })]);
    expect(result).toHaveLength(2);
    for (const group of result) expect(group).toMatchObject({ reservedQty: "0", pickedQty: "0", unknownCount: "1",
      identityCompletedCount: "0", issues: [{ code: "RESERVATION_TRANSFER_OWNER_UNRECORDED", transactionIds: [1] }] });
    expect(result.map((group) => group.warehouseLocationId)).toEqual([40, 41]);
  });
  it("retains known signed ship/unpick arithmetic exactly without clamping", () => {
    const result = aggregateCutoverJournalEvidence([row({ transactionType: "ship", sourceState: "picked", variantQtyDelta: -2, reservedQtyDelta: null }),
      row({ id: 2, transactionType: "unpick", variantQtyDelta: 1, reservedQtyDelta: null })])[0];
    expect(result).toMatchObject({ pickedQty: "-3", shippedQty: "2", reservedQty: "0", unknownCount: "0" });
  });
  it("sorts deterministically and hashes every original/linked row fact", () => {
    const input = [row(), sourceRow({ id: 2 })]; const first = aggregateCutoverJournalEvidence(input);
    expect(aggregateCutoverJournalEvidence([...input].reverse())).toEqual(first);
    for (const change of [{ journalHash: "c".repeat(64) }, { linkHash: "c".repeat(64) }, { sourceQty: 2 }]) {
      expect(aggregateCutoverJournalEvidence([row(), sourceRow({ id: 2, ...change })])[0].journalHash).not.toBe(first[0].journalHash);
    }
  });
  it("bounds examples without truncating quantities, unknown counts or hashes", () => {
    const input = Array.from({ length: 15 }, (_, index) => row({ id: index + 1, reservedQtyDelta: null }));
    const result = aggregateCutoverJournalEvidence(input)[0];
    expect(result).toMatchObject({ unknownCount: "15", journalCount: "15", issues: [{ transactionCount: "15", transactionIds: [1,2,3,4,5,6,7,8,9,10] }] });
    expect(aggregateCutoverJournalEvidence(input.slice(0, 14))[0].journalHash).not.toBe(result.journalHash);
  });
  it("uses exact bigint aggregation beyond the integer counter range", () => {
    expect(aggregateCutoverJournalEvidence([row({ reservedQtyDelta: 2_147_483_647 }), row({ id: 2, reservedQtyDelta: 2_147_483_647 })])[0].reservedQty).toBe("4294967294");
  });
  it("rejects raw-row overflow before parsing any partial evidence", () => {
    expect(() => aggregateCutoverJournalEvidence(Array(MAX_CUTOVER_JOURNAL_ROWS + 1).fill(null))).toThrow(expect.objectContaining({ code: "CUTOVER_JOURNAL_ROW_LIMIT_EXCEEDED" }));
  });
  it("rejects group overflow without returning a partial owner census", () => {
    const input = Array.from({ length: 50_001 }, (_, index) => row({ id: index + 1, productVariantId: index + 1 }));
    expect(() => aggregateCutoverJournalEvidence(input)).toThrow(expect.objectContaining({ code: "CUTOVER_JOURNAL_GROUP_LIMIT_EXCEEDED" }));
  });
  it.each([{ id: 0 }, { reservedQtyDelta: 0.5 }, { reservedQtyDelta: 2_147_483_648 }, { journalHash: "invalid" }])("rejects invalid raw facts %j", (changes) => {
    expect(() => aggregateCutoverJournalEvidence([row(changes)])).toThrow();
  });
  it("rejects duplicate rows instead of counting a joined identity twice", () => {
    expect(() => aggregateCutoverJournalEvidence([row(), row()])).toThrow(expect.objectContaining({ code: "CUTOVER_JOURNAL_DUPLICATE_ID" }));
  });
  it.each(["missing causes", "extra cause count", "duplicate cause", "duplicate example", "extra completed identity"])(
    "rejects inconsistent diagnosis: %s", (kind) => {
      const journal = aggregateCutoverJournalEvidence([row({ reservedQtyDelta: null })])[0];
      if (kind === "missing causes") journal.issues = [];
      if (kind === "extra cause count") journal.issues![0].transactionCount = "2";
      if (kind === "duplicate cause") journal.issues!.push({ ...journal.issues![0] });
      if (kind === "duplicate example") journal.issues![0].transactionIds = [1, 1];
      if (kind === "extra completed identity") journal.identityCompletedCount = "2";
      expect(cutoverReconstructionJournalSchema.safeParse(journal).success).toBe(false);
    });
});
