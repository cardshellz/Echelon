import { describe, expect, it } from "vitest";
import { createOpeningWorksheet, OPENING_DOCUMENT_LIMIT_BYTES, parseOpeningDocument, prepareOpeningSave } from "../../inventory-cutover-opening-document";
import { openingAssessment, openingSource, openingVerification } from "../../../../../server/modules/inventory-planning/__tests__/fixtures/inventory-cutover-opening-interface.fixture";

describe("independent opening verification document", () => {
  it("exports recorded references separately while every verification quantity remains blank", () => {
    const source = openingSource(); const before = structuredClone(source);
    const worksheet = JSON.parse(createOpeningWorksheet(source));
    expect(worksheet.recordedReference.levels[0].variantQty).toBe("20");
    expect(worksheet.recordedReference.labels).toContainEqual({ kind: "order", id: "1", label: "Order #CS-1001" });
    expect(worksheet.verification).toMatchObject({ verificationReference: "", verificationEvidenceHash: "", verifiedAt: "",
      levels: [{ variantQty: "", reservedQty: "", pickedQty: "", packedQty: "" }],
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
