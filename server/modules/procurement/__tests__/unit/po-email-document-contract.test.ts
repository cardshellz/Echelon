import { describe, expect, it } from "vitest";
import { inspectPoEmailDocument, poEmailDocumentHash } from "../../po-email-document-contract";

describe("supplier email document content verification", () => {
  const html = "<html>Supplier quote — café 📦</html>";
  const verified = {
    html, contractVersion: 1, documentHash: poEmailDocumentHash(html),
    sourceRevision: "a".repeat(64), documentPurpose: "current_copy",
  };
  it("verifies exact UTF-8 HTML and rejects a changed amount", () => {
    expect(inspectPoEmailDocument(verified)).toBeNull();
    expect(inspectPoEmailDocument({ ...verified, html: html + "$0.00" })).toBe("DOCUMENT_HASH_MISMATCH");
  });
  it("does not accept a null version or an existing hold as current certification", () => {
    expect(inspectPoEmailDocument({ ...verified, contractVersion: null })).toBe("LEGACY_DOCUMENT_UNVERIFIED");
    expect(inspectPoEmailDocument({ ...verified, documentHoldReason: "LEGACY_DOCUMENT_UNVERIFIED" })).toBe("LEGACY_DOCUMENT_UNVERIFIED");
  });
});
