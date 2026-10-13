import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supplierDocumentSource } from "../fixtures/supplier-po-document.fixture";
import { buildSupplierPoDocument } from "../../supplier-po-document";
import { renderPoHtml } from "../../po-document";

const dependencies = vi.hoisted(() => ({ loadSource: vi.fn(), sendMail: vi.fn() }));
vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../supplier-po-document.repository", () => ({ loadSupplierPoDocumentSource: dependencies.loadSource }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: dependencies.sendMail }) } }));
import { buildPurchaseOrderEmail } from "../../../notifications/email.service";

describe("supplier email uses the validated print document", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  function currentSource() {
    const source = supplierDocumentSource();
    source.po.status = "approved";
    return source;
  }
  it("snapshots exactly the print HTML, canonical amount and content identity without private fields", async () => {
    const source = currentSource();
    dependencies.loadSource.mockResolvedValue(source);
    const expected = buildSupplierPoDocument(source);
    const email = await buildPurchaseOrderEmail({ poId: 1 });
    expect(email.html).toBe(renderPoHtml(expected));
    expect(email.html).toContain("$123.45");
    expect(JSON.stringify(email)).not.toContain("PRIVATE_");
    expect(email).toMatchObject({ contractVersion: 1, documentPurpose: "current_copy", sourceRevision: expected.sourceRevision,
      documentHash: createHash("sha256").update(email.html).digest("hex") });
    expect(email.subject).toBe("Purchase Order PO-DOCUMENT-001 — revision 0 — Synthetic buyer");
    expect(email.text).toContain("not a new order");
    expect(dependencies.sendMail).not.toHaveBeenCalled();
  });
  it("escapes the personal message and hashes the final payload, preserving the source identity", async () => {
    dependencies.loadSource.mockResolvedValue(currentSource());
    const plain = await buildPurchaseOrderEmail({ poId: 1 });
    const message = await buildPurchaseOrderEmail({ poId: 1, message: ' <script>unsafe & private</script> ' });
    expect(message.html).toContain("&lt;script&gt;unsafe &amp; private&lt;/script&gt;");
    expect(message.html).not.toContain("<script>");
    expect(message.documentHash).toBe(createHash("sha256").update(message.html).digest("hex"));
    expect(message.documentHash).not.toBe(plain.documentHash);
    expect(message.sourceRevision).toBe(plain.sourceRevision);
    expect(message.text).toContain("<script>unsafe & private</script>");
  });
  it.each(["draft", "pending_approval"])("refuses %s email without invoking transport", async status => {
    const source = currentSource(); source.po.status = status;
    dependencies.loadSource.mockResolvedValue(source);
    await expect(buildPurchaseOrderEmail({ poId: 1 })).rejects.toMatchObject({ code: "PURCHASE_ORDER_DOCUMENT_NOT_ISSUABLE", statusCode: 409 });
    expect(dependencies.sendMail).not.toHaveBeenCalled();
  });
  it("refuses a cancelled record instead of reconstructing an original issue", async () => {
    const source = currentSource(); source.po.status = "cancelled";
    dependencies.loadSource.mockResolvedValue(source);
    await expect(buildPurchaseOrderEmail({ poId: 1 })).rejects.toMatchObject({ code: "PURCHASE_ORDER_DOCUMENT_CANCELLED" });
  });
  it("does not snapshot missing canonical economics", async () => {
    dependencies.loadSource.mockResolvedValue({ ...currentSource(), po: { ...currentSource().po, totalCents: null } });
    await expect(buildPurchaseOrderEmail({ poId: 1 })).rejects.toMatchObject({ code: "INVALID_SUPPLIER_DOCUMENT_SOURCE" });
  });
  it("propagates a failed consistent source read without creating content or calling transport", async () => {
    dependencies.loadSource.mockRejectedValue(new Error("database unavailable"));
    await expect(buildPurchaseOrderEmail({ poId: 1 })).rejects.toThrow("database unavailable");
    expect(dependencies.sendMail).not.toHaveBeenCalled();
  });
});
