import {
  poFinancialEvidenceIdSchema,
  poFinancialEvidenceSchema,
  type PoFinancialEvidence,
} from "@shared/procurement/po-financial-evidence";
import {
  poFinancialWorkflowSchema,
  type PoFinancialWorkflow,
} from "@shared/procurement/po-financial-workflow";
import {
  buildPoFinancialEvidence,
  type PoFinancialEvidenceInput,
} from "./domain/po-financial-evidence";
import { buildPoFinancialWorkflow } from "./domain/po-financial-workflow";
import {
  readPoFinancialEvidenceSourcesWithClient,
  type PoFinancialEvidenceDatabase,
} from "./po-financial-evidence.repository";

export function createPoFinancialEvidenceService(
  database: PoFinancialEvidenceDatabase,
) {
  async function readSources(
    purchaseOrderIds: readonly number[],
  ): Promise<Map<number, PoFinancialEvidenceInput>> {
    const ids = poFinancialEvidenceIdSchema.array().parse(purchaseOrderIds);
    if (ids.length === 0) return new Map();
    return database.transaction(
      (tx) => readPoFinancialEvidenceSourcesWithClient(tx, ids),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async function readMany(
    purchaseOrderIds: readonly number[],
  ): Promise<Map<number, PoFinancialEvidence>> {
    const sources = await readSources(purchaseOrderIds);
    return new Map(
      [...sources].map(([id, source]) => [
        id,
        poFinancialEvidenceSchema.parse(buildPoFinancialEvidence(source)),
      ]),
    );
  }

  async function readManyWorkflows(
    purchaseOrderIds: readonly number[],
  ): Promise<Map<number, PoFinancialWorkflow>> {
    const sources = await readSources(purchaseOrderIds);
    return new Map(
      [...sources].map(([id, source]) => [
        id,
        poFinancialWorkflowSchema.parse(buildPoFinancialWorkflow(source)),
      ]),
    );
  }

  return {
    readMany,
    readManyWorkflows,
    async read(purchaseOrderId: number): Promise<PoFinancialEvidence | null> {
      return (await readMany([purchaseOrderId])).get(purchaseOrderId) ?? null;
    },
    async readWorkflow(
      purchaseOrderId: number,
    ): Promise<PoFinancialWorkflow | null> {
      return (
        (await readManyWorkflows([purchaseOrderId])).get(purchaseOrderId) ??
        null
      );
    },
  };
}
