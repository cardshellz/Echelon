import { createHash } from "node:crypto";

/** Certifies rendered supplier content only. This is not approval or send authority. */
export const PO_EMAIL_DOCUMENT_CONTRACT_VERSION = 1;
export const PO_EMAIL_DOCUMENT_PURPOSE = "current_copy";
const SHA256_HEX = /^[a-f0-9]{64}$/;

export interface PoEmailDocumentMetadata {
  contractVersion: number | null;
  documentHash: string | null;
  sourceRevision: string | null;
  documentPurpose: string | null;
  documentHoldReason?: string | null;
}

export type PoEmailDocumentHoldReason =
  | "LEGACY_DOCUMENT_UNVERIFIED"
  | "DOCUMENT_CONTRACT_UNSUPPORTED"
  | "DOCUMENT_METADATA_INVALID"
  | "DOCUMENT_PURPOSE_NOT_ISSUABLE"
  | "DOCUMENT_HASH_MISMATCH";

export function poEmailDocumentHash(html: string): string {
  return createHash("sha256").update(html, "utf8").digest("hex");
}

/** A held snapshot never becomes verified by editing metadata or replaying it. */
export function inspectPoEmailDocument(
  snapshot: PoEmailDocumentMetadata & { html: string },
): PoEmailDocumentHoldReason | null {
  if (snapshot.documentHoldReason) return "LEGACY_DOCUMENT_UNVERIFIED";
  if (snapshot.contractVersion == null) return "LEGACY_DOCUMENT_UNVERIFIED";
  if (snapshot.contractVersion !== PO_EMAIL_DOCUMENT_CONTRACT_VERSION) return "DOCUMENT_CONTRACT_UNSUPPORTED";
  if (
    typeof snapshot.documentHash !== "string" || !SHA256_HEX.test(snapshot.documentHash) ||
    typeof snapshot.sourceRevision !== "string" || !SHA256_HEX.test(snapshot.sourceRevision)
  ) return "DOCUMENT_METADATA_INVALID";
  if (snapshot.documentPurpose !== PO_EMAIL_DOCUMENT_PURPOSE) return "DOCUMENT_PURPOSE_NOT_ISSUABLE";
  if (typeof snapshot.html !== "string" || snapshot.html.length === 0 ||
      poEmailDocumentHash(snapshot.html) !== snapshot.documentHash) return "DOCUMENT_HASH_MISMATCH";
  return null;
}
