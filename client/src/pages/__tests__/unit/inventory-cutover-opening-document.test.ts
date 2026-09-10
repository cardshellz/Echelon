import { describe, expect, it } from "vitest";
import { createOpeningWorksheet, OPENING_DOCUMENT_LIMIT_BYTES, parseOpeningDocument, prepareOpeningSave } from "../../inventory-cutover-opening-document";
import { openingAssessment, openingSource, openingVerification } from "../../../../../server/modules/inventory-planning/__tests__/fixtures/inventory-cutover-opening-interface.fixture";

describe("independent opening verification document", () => {
  it("exports blank lot/owner observations and non-authoritative derived position placeholders", () => {
    const source = openingSource(); const before = structuredClone(source);
    const worksheet = JSON.parse(createOpeningWorksheet(source));
    expect(worksheet.recordedReference.levels[0].variantQty).toBe("20");
    expect(worksheet.recordedReference.labels).toContainEqual({ kind: "order", id: "1", label: "Order #CS-1001" });
    expect(worksheet.verification).toMatchObject({ verificationReference: "", verificationEvidenceHash: "", verifiedAt: "",
      contractVersion: "inventory_cutover_opening_v2",
      levels: [{ variantQty: "0", reservedQty: "0", pickedQty: "0", packedQty: "0" }],
      lots: [{ onHandQty: "", reservedQty: "", pickedQty: "", unitCostMills: "", poUnitCostMills: "", packagingUnitCostMills: "", landedUnitCostMills: "" }],
      owners: [{ remainingQty: "", reservedQty: "", pickedQty: "", allocations: [] }] });
    expect(source).toEqual(before);
    expect(() => parseOpeningDocument(JSON.stringify(worksheet), source)).toThrow("incomplete or invalid");
  });
  it("imports only completed verification and never adopts edited reference values", () => {
    const source = openingSource(); const verification = openingVerification();
    const worksheet = JSON.parse(createOpeningWorksheet(source));
    worksheet.verification = verification;
    worksheet.recordedReference = { forgedOrder: "MALICIOUS", levels: [{ variantQty: "999" }] };
    expect(parseOpeningDocument(JSON.stringify(worksheet), source)).toEqual(verification);
    expect(parseOpeningDocument(JSON.stringify(verification), source)).toEqual(verification);
  });
  it("keeps an empty-bin promise counter as recorded reference without pre-verifying physical owner holds", () => {
    const source = openingSource(); const level = source.evidence.levels[0]; const lot = source.evidence.lots[0];
    source.evidence.levels = [{ ...level, variantQty: "0", reservedQty: "6", pickedQty: "0", packedQty: "0" }];
    source.evidence.lots = [{ ...lot, onHandQty: "0", reservedQty: "0", pickedQty: "0" }];
    source.evidence.items[0].pickedQuantity = 0;
    const worksheet = JSON.parse(createOpeningWorksheet(source));
    expect(worksheet.recordedReference.levels[0]).toMatchObject({ variantQty: "0", reservedQty: "6" });
    expect(worksheet.verification.levels[0].reservedQty).toBe("0"); // Derived placeholder, not another count input.
    expect(worksheet.verification.owners[0]).toMatchObject({ remainingQty: "", reservedQty: "", pickedQty: "", allocations: [] });
    expect(() => parseOpeningDocument(JSON.stringify(worksheet), source)).toThrow("incomplete or invalid");
  });
  it("preserves an explicitly verified promise counter and full demand without inventing physical allocations", () => {
    const source = openingSource(); const verification = openingVerification();
    verification.levels[0] = { ...verification.levels[0], variantQty: "0", reservedQty: "6", pickedQty: "0", packedQty: "0" };
    verification.lots[0] = { ...verification.lots[0], onHandQty: "0", reservedQty: "0", pickedQty: "0" };
    verification.owners[0] = { ...verification.owners[0], remainingQty: "6", reservedQty: "0", pickedQty: "0", allocations: [] };
    source.evidence.levels = structuredClone(verification.levels); source.evidence.lots = structuredClone(verification.lots);
    source.evidence.items[0].pickedQuantity = 0;
    const parsed = parseOpeningDocument(JSON.stringify(verification), source);
    expect(parsed.levels[0].reservedQty).toBe("6"); expect(parsed.owners[0]).toEqual(verification.owners[0]);
    // Import only validates the packet. Eligibility is still decided by the
    // server preview; the client cannot turn these zeros into a handoff.
    expect(() => prepareOpeningSave(parsed, source, null, "Reviewed promise evidence", "promise-1")).toThrow("without blockers");
  });
  it.each(["expectedEvidenceHash", "expectedAuthorityRevision", "expectedConfigurationRunId"] as const)("rejects a different source %s", field => {
    const verification = openingVerification();
    const input = { ...verification, [field]: field === "expectedEvidenceHash" ? "e".repeat(64) : "2" };
    expect(() => parseOpeningDocument(JSON.stringify(input), openingSource())).toThrow("different source evidence");
  });
  it("rejects canonical authority, malformed JSON, unknown fields and absent explicit quantities", () => {
    const source = openingSource(); const verification = openingVerification();
    expect(() => parseOpeningDocument(JSON.stringify(verification), { ...source, runtimeAuthority: "canonical" })).toThrow("before inventory authority");
    expect(() => parseOpeningDocument("{bad", source)).toThrow("not valid JSON");
    expect(() => parseOpeningDocument(JSON.stringify({ ...verification, actor: "admin" }), source)).toThrow("incomplete or invalid");
    const missing = structuredClone(verification); delete (missing.levels[0] as Partial<typeof missing.levels[0]>).reservedQty;
    expect(() => parseOpeningDocument(JSON.stringify(missing), source)).toThrow("reservedQty");
  });
  it("enforces the byte ceiling without truncating multibyte evidence", () => {
    expect(() => parseOpeningDocument('"' + "é".repeat(OPENING_DOCUMENT_LIMIT_BYTES / 2) + '"', openingSource())).toThrow("exceeds 10MB");
  });
  it("keeps exact cost strings beyond Number precision", () => {
    expect(parseOpeningDocument(JSON.stringify(openingVerification()), openingSource()).lots[0].unitCostMills).toBe("9007199254740995");
  });
  it("requires ready same-source preview and explicit reason before an audit-only save", () => {
    expect(() => prepareOpeningSave(openingVerification(), openingSource(), null, "reason", "key")).toThrow("without blockers");
    expect(() => prepareOpeningSave(openingVerification(), openingSource(), { ...openingAssessment(), sourceEvidenceHash: "f".repeat(64) }, "reason", "key")).toThrow("without blockers");
    expect(() => prepareOpeningSave(openingVerification(), openingSource(), openingAssessment(), " ", "key")).toThrow();
    expect(prepareOpeningSave(openingVerification(), openingSource(), openingAssessment(), "reason", "same-key")).toEqual({
      verification: openingVerification(), reason: "reason", idempotencyKey: "same-key" });
  });
});
