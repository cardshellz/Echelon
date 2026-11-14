import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "../../db";
import { renderPoHtml } from "./po-document";
import { buildSupplierPoDocument, SupplierPoDocumentError } from "./supplier-po-document";
import { loadSupplierPoDocumentSource } from "./supplier-po-document.repository";

export interface PurchaseOrderEmailSnapshot {
  subject: string;
  html: string;
  text: string;
  poNumber: string;
  contractVersion: 1;
  documentHash: string;
  sourceRevision: string;
  documentPurpose: "draft_preview" | "current_copy";
}

const purchaseOrderEmailInput = z.object({
  poId: z.number().int().positive().max(2_147_483_647),
  message: z.string().trim().max(10_000).optional(),
}).strict();

export async function buildPurchaseOrderEmail(opts: {
  poId: number;
  message?: string;
}): Promise<PurchaseOrderEmailSnapshot> {
  const parsed = purchaseOrderEmailInput.safeParse(opts);
  if (!parsed.success) {
    throw new SupplierPoDocumentError("INVALID_EMAIL_REQUEST", "The supplier email request is invalid.", 400);
  }
  const document = buildSupplierPoDocument(await loadSupplierPoDocumentSource(db, parsed.data.poId));
  if (document.purpose !== "current_copy") {
    throw new SupplierPoDocumentError(
      "PURCHASE_ORDER_DOCUMENT_NOT_ISSUABLE",
      "This PO is a draft preview. Complete the purchasing approval workflow before emailing a supplier copy.",
    );
  }
  let html = renderPoHtml(document);

  const personalMessage = parsed.data.message ?? "";
  if (personalMessage) {
    const msgHtml = `<div style="font-family:-apple-system,Arial,sans-serif;font-size:14px;color:#111;margin-bottom:24px;padding:16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;">
      <p style="white-space:pre-wrap;">${escHtml(personalMessage)}</p>
    </div>`;
    html = html.replace("<body>", `<body>${msgHtml}`);
  }

  const companyName = document.company.name;
  const subject = `Purchase Order ${document.poNumber} — revision ${document.revisionNumber} — ${companyName}`;
  const text = [
    personalMessage,
    `Purchase Order ${document.poNumber} from ${companyName}, revision ${document.revisionNumber}.`,
    document.notice,
    "The complete purchase order is included in the HTML version of this email.",
  ].filter(Boolean).join("\n\n");

  return {
    subject,
    html,
    text,
    poNumber: document.poNumber,
    contractVersion: document.contractVersion,
    documentHash: createHash("sha256").update(html).digest("hex"),
    sourceRevision: document.sourceRevision,
    documentPurpose: document.purpose,
  };
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
