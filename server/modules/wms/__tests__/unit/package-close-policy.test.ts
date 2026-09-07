import { describe, expect, it } from "vitest";
import {
  packageCloseCommandSchema, packageCloseEvidenceSchema,
  type PackageCloseActor, type PackageCloseCommand, type PackageCloseEvidence,
} from "@shared/warehouse-package-close";
import { evaluatePackageClose, previewPackageClose } from "../../package-close-policy";

function actor(): PackageCloseActor {
  return { actorId: "assembler", assignedActorId: "assembler", warehouseId: 1,
    canPack: true, stationEnabled: true, stationSupportsPacking: true };
}
function evidence(): PackageCloseEvidence {
  return {
    contractVersion: 1, packageId: "501", packageVersion: 2, warehouseId: 1,
    provider: "shipstation", providerAccountId: "account-1", providerPackageId: "external-package-1",
    authorityMode: "live", contentsComplete: true, cancelled: false,
    carrierPossessionConfirmed: false, currentCloseReceiptId: null,
    labels: [{ id: "601", provider: "shipstation", providerAccountId: "account-1",
      providerPackageId: "external-package-1", revision: 1, status: "active", direction: "outbound",
      normalizedTrackingNumber: "TRACK1234" }],
    lines: [{ sourceShipmentItemId: 101, orderId: 70, orderItemId: 71, warehouseId: 1,
      productVariantId: 90, sku: "P5", quantity: 2, authorizedSourceQuantity: 2,
      pickedQuantity: 2, otherClosedQuantity: 0, held: false, cancelled: false, requiresShipping: true }],
  };
}
function command(facts = evidence()): PackageCloseCommand {
  return {
    commandId: "e7b47ec4-b47d-48cb-af38-ae6b219080bb", packageId: facts.packageId,
    expectedEvidenceHash: previewPackageClose(facts, actor()).evidenceHash,
    labelId: "601", expectedLabelRevision: 1, scannedTrackingNumber: "track-1234",
    confirmExactContents: true, confirmLabelApplied: true, reason: "Verified exact contents and applied the existing label",
  };
}
describe("package close policy (not a runtime close command)", () => {
  it("accepts exact fully picked contents and the current label without emitting a receipt or shipment", () => {
    const facts = evidence();
    expect(evaluatePackageClose(facts, actor(), command(facts))).toEqual({ contractVersion: 1, packageId: "501",
      evidenceHash: command(facts).expectedEvidenceHash, eligible: true, blockers: [] });
  });
  it.each([
    ["shadow", (e: PackageCloseEvidence) => { e.authorityMode = "shadow_only"; }, "PACKAGE_AUTHORITY_UNAVAILABLE"],
    ["unavailable", (e: PackageCloseEvidence) => { e.authorityMode = "unavailable"; }, "PACKAGE_AUTHORITY_UNAVAILABLE"],
    ["incomplete", (e: PackageCloseEvidence) => { e.contentsComplete = false; }, "PACKAGE_CONTENTS_UNPROVEN"],
    ["empty", (e: PackageCloseEvidence) => { e.lines = []; }, "PACKAGE_CONTENTS_UNPROVEN"],
    ["cancelled", (e: PackageCloseEvidence) => { e.cancelled = true; }, "PACKAGE_CANCELLED"],
    ["closed", (e: PackageCloseEvidence) => { e.currentCloseReceiptId = "901"; }, "PACKAGE_ALREADY_CLOSED"],
    ["carrier", (e: PackageCloseEvidence) => { e.carrierPossessionConfirmed = true; }, "CARRIER_ALREADY_HAS_PACKAGE"],
    ["held", (e: PackageCloseEvidence) => { e.lines[0].held = true; }, "PACKAGE_LINE_INELIGIBLE"],
    ["line cancelled", (e: PackageCloseEvidence) => { e.lines[0].cancelled = true; }, "PACKAGE_LINE_INELIGIBLE"],
    ["digital", (e: PackageCloseEvidence) => { e.lines[0].requiresShipping = false; }, "PACKAGE_LINE_INELIGIBLE"],
    ["unpicked", (e: PackageCloseEvidence) => { e.lines[0].pickedQuantity = 0; }, "PACKAGE_QUANTITY_NOT_PICKED"],
    ["already packed", (e: PackageCloseEvidence) => { e.lines[0].otherClosedQuantity = 1; }, "PACKAGE_QUANTITY_NOT_PICKED"],
    ["excess", (e: PackageCloseEvidence) => { e.lines[0].authorizedSourceQuantity = 1; }, "PACKAGE_QUANTITY_EXCEEDS_AUTHORITY"],
    ["line warehouse", (e: PackageCloseEvidence) => { e.lines[0].warehouseId = 2; }, "PACKAGE_SCOPE_MISMATCH"],
    ["no label", (e: PackageCloseEvidence) => { e.labels = []; }, "PACKAGE_LABEL_MISSING"],
    ["unknown label", (e: PackageCloseEvidence) => { e.labels[0].status = "unknown"; }, "PACKAGE_LABEL_MISSING"],
    ["void label", (e: PackageCloseEvidence) => { e.labels[0].status = "voided"; }, "PACKAGE_LABEL_MISSING"],
    ["superseded label", (e: PackageCloseEvidence) => { e.labels[0].status = "superseded"; }, "PACKAGE_LABEL_MISSING"],
    ["return", (e: PackageCloseEvidence) => { e.labels[0].direction = "return"; }, "PACKAGE_LABEL_NOT_OUTBOUND"],
    ["unknown direction", (e: PackageCloseEvidence) => { e.labels[0].direction = "unknown"; }, "PACKAGE_LABEL_NOT_OUTBOUND"],
    ["provider", (e: PackageCloseEvidence) => { e.labels[0].provider = "other"; }, "PACKAGE_LABEL_IDENTITY_MISMATCH"],
    ["account", (e: PackageCloseEvidence) => { e.labels[0].providerAccountId = "account-2"; }, "PACKAGE_LABEL_IDENTITY_MISMATCH"],
    ["provider package", (e: PackageCloseEvidence) => { e.labels[0].providerPackageId = "other"; }, "PACKAGE_LABEL_IDENTITY_MISMATCH"],
    ["ambiguous labels", (e: PackageCloseEvidence) => { e.labels.push({ ...e.labels[0], id: "602" }); }, "PACKAGE_LABEL_AMBIGUOUS"],
    ["duplicate source", (e: PackageCloseEvidence) => { e.lines.push({ ...e.lines[0] }); }, "PACKAGE_SOURCE_DUPLICATE"],
    ["ambiguous line", (e: PackageCloseEvidence) => { e.lines.push({ ...e.lines[0], sourceShipmentItemId: 102 }); }, "PACKAGE_ORDER_LINE_AMBIGUOUS"],
  ] as const)("rejects %s", (_name, change, blocker) => {
    const facts = evidence(); change(facts);
    expect(previewPackageClose(facts, actor())).toMatchObject({ eligible: false, blockers: expect.arrayContaining([blocker]) });
    expect(evaluatePackageClose(facts, actor(), command(facts))).toMatchObject({ eligible: false, blockers: expect.arrayContaining([blocker]) });
  });
  it.each([
    { canPack: false }, { assignedActorId: "other" }, { assignedActorId: null },
    { stationEnabled: false }, { stationSupportsPacking: false }, { warehouseId: 2 },
  ])("rechecks current worker scope: %j", (change) => {
    expect(evaluatePackageClose(evidence(), { ...actor(), ...change }, command()).eligible).toBe(false);
  });
  it("allows disjoint quantities from one source across packages, never duplicate picked stock", () => {
    const facts = evidence(); facts.lines[0].authorizedSourceQuantity = 4;
    facts.lines[0].pickedQuantity = 4; facts.lines[0].otherClosedQuantity = 2;
    expect(evaluatePackageClose(facts, actor(), command(facts)).eligible).toBe(true);
    facts.lines[0].otherClosedQuantity = 3;
    expect(previewPackageClose(facts, actor()).blockers).toContain("PACKAGE_QUANTITY_NOT_PICKED");
  });
  it("accepts mixed contents without requiring unrelated held lines outside this package", () => {
    const facts = evidence();
    facts.lines.push({ ...facts.lines[0], sourceShipmentItemId: 102, orderItemId: 72, sku: "C25", productVariantId: 91 });
    expect(evaluatePackageClose(facts, actor(), command(facts)).eligible).toBe(true);
  });
  it("accepts a current replacement label but rejects the old void label or revision", () => {
    const facts = evidence(); facts.labels[0].status = "voided";
    facts.labels.push({ ...facts.labels[0], id: "602", status: "active", revision: 2, normalizedTrackingNumber: "NEW12345" });
    const close = { ...command(facts), labelId: "602", expectedLabelRevision: 2, scannedTrackingNumber: "NEW12345" };
    expect(evaluatePackageClose(facts, actor(), close).eligible).toBe(true);
    expect(evaluatePackageClose(facts, actor(), { ...close, labelId: "601" }).blockers).toContain("PACKAGE_LABEL_CHANGED");
    expect(evaluatePackageClose(facts, actor(), { ...close, expectedLabelRevision: 1 }).blockers).toContain("PACKAGE_LABEL_CHANGED");
  });
  it.each(["---", "abc", "WRONG12345"])("rejects invalid or mismatched scan %j", (scan) => {
    expect(evaluatePackageClose(evidence(), actor(), { ...command(), scannedTrackingNumber: scan }).blockers).toContain("PACKAGE_TRACKING_MISMATCH");
  });
  it("requires a fresh preview after a quantity, label, or package revision changes", () => {
    const close = command();
    for (const change of [
      (e: PackageCloseEvidence) => { e.packageVersion += 1; },
      (e: PackageCloseEvidence) => { e.lines[0].otherClosedQuantity += 1; },
      (e: PackageCloseEvidence) => { e.labels[0].revision += 1; },
    ]) {
      const facts = evidence(); change(facts);
      expect(evaluatePackageClose(facts, actor(), close).blockers).toContain("PACKAGE_EVIDENCE_CHANGED");
    }
  });
  it("rejects the wrong internal package even when tracking matches", () => {
    expect(evaluatePackageClose(evidence(), actor(), { ...command(), packageId: "502" }).blockers).toContain("PACKAGE_COMMAND_IDENTITY_MISMATCH");
  });
  it("is deterministic under row reordering and does not mutate evidence", () => {
    const facts = evidence(); facts.lines.push({ ...facts.lines[0], sourceShipmentItemId: 102, orderItemId: 72 });
    facts.labels.push({ ...facts.labels[0], id: "602", status: "voided" });
    const original = structuredClone(facts);
    const reordered = structuredClone(facts); reordered.lines.reverse(); reordered.labels.reverse();
    expect(previewPackageClose(reordered, actor())).toEqual(previewPackageClose(facts, actor()));
    expect(facts).toEqual(original);
  });
  it("retains bigint identities and checks maximum quantities exactly", () => {
    const facts = evidence(); facts.packageId = "9223372036854775807";
    facts.lines[0].quantity = 2_147_483_647; facts.lines[0].authorizedSourceQuantity = 2_147_483_647;
    facts.lines[0].pickedQuantity = 2_147_483_647;
    expect(previewPackageClose(facts, actor())).toMatchObject({ packageId: facts.packageId, eligible: true });
    facts.lines[0].otherClosedQuantity = 2_147_483_647;
    expect(previewPackageClose(facts, actor()).blockers).toContain("PACKAGE_QUANTITY_EXCEEDS_AUTHORITY");
  });
  it.each([-1, 0, 0.5, 2_147_483_648, Infinity, NaN])("rejects malformed quantity %s", (value) => {
    const facts = evidence(); facts.lines[0].quantity = value;
    expect(() => previewPackageClose(facts, actor())).toThrow();
  });
  it("rejects injected authority, quantities, actors, and missing physical acknowledgments", () => {
    for (const extra of [{ actorId: "admin" }, { lines: evidence().lines }, { authorityMode: "live" }, { anything: true }])
      expect(packageCloseCommandSchema.safeParse({ ...command(), ...extra }).success).toBe(false);
    expect(packageCloseCommandSchema.safeParse({ ...command(), confirmLabelApplied: false }).success).toBe(false);
    expect(packageCloseCommandSchema.safeParse({ ...command(), confirmExactContents: false }).success).toBe(false);
    expect(packageCloseCommandSchema.safeParse({ ...command(), scannedTrackingNumber: "" }).success).toBe(false);
    expect(packageCloseEvidenceSchema.safeParse({ ...evidence(), labels: [{ ...evidence().labels[0], providerAccountId: "" }] }).success).toBe(false);
    expect(packageCloseEvidenceSchema.safeParse({ ...evidence(), packageId: "9223372036854775808" }).success).toBe(false);
  });
});
