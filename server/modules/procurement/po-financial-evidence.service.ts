import {
  poFinancialEvidenceIdSchema,
  poFinancialEvidenceSchema,
  type PoFinancialEvidence,
} from "@shared/procurement/po-financial-evidence";
import { buildPoFinancialEvidence } from "./domain/po-financial-evidence";
import {
  readPoFinancialEvidenceSource,
  type PoFinancialEvidenceDatabase,
} from "./po-financial-evidence.repository";

export function createPoFinancialEvidenceService(
  database: PoFinancialEvidenceDatabase,
) {
  return {
    async read(purchaseOrderId: number): Promise<PoFinancialEvidence | null> {
      const id = poFinancialEvidenceIdSchema.parse(purchaseOrderId);
      const source = await readPoFinancialEvidenceSource(database, id);
      return source === null
        ? null
        : poFinancialEvidenceSchema.parse(buildPoFinancialEvidence(source));
    },
  };
}
