import { z } from "zod";
import { poFinancialWorkflowStateSchema } from "@shared/procurement/po-financial-workflow";
import { buildPoFinancialWorkflow } from "./domain/po-financial-workflow";
import { createPurchaseOrderListRepository } from "./purchase-order-list.repository";

const statuses = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional();
const filtersSchema = z.object({
  status: statuses,
  physicalStatus: statuses,
  financialStatus: statuses,
  financialWorkflow: poFinancialWorkflowStateSchema.optional(),
  vendorId: z.number().int().positive().max(2_147_483_647).optional(),
  search: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(1_000).default(50),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
}).strict();

// Bound evidence reads while retaining exact filtering/counting before pagination.
const FINANCIAL_SELECTION_BATCH_SIZE = 200;

export class PurchaseOrderListQueryError extends Error {
  constructor() { super("Invalid purchase order list filters or page"); this.name = "PurchaseOrderListQueryError"; }
}

export function createPurchaseOrderListService(repository = createPurchaseOrderListRepository()) {
  return async (input: unknown) => {
    const parsed = filtersSchema.safeParse(input);
    if (!parsed.success) throw new PurchaseOrderListQueryError();
    const { financialWorkflow, limit, offset, ...filters } = parsed.data;
    return repository.snapshot(filters, async source => {
      const enrich = async (rows: Awaited<ReturnType<typeof source.rows>>) => {
        const sources = await source.evidence(rows.map(row => row.id));
        return rows.map(row => {
          const evidence = sources.get(row.id);
          if (!evidence) throw new Error("Purchase order financial evidence source is missing");
          return { ...row, financialWorkflow: buildPoFinancialWorkflow(evidence) };
        });
      };
      if (financialWorkflow === undefined) {
        const total = await source.count();
        return { purchaseOrders: await enrich(await source.rows(limit, offset)), total };
      }
      let total = 0;
      const selected: Awaited<ReturnType<typeof enrich>> = [];
      for (let cursor = 0; ; cursor += FINANCIAL_SELECTION_BATCH_SIZE) {
        const rows = await source.rows(FINANCIAL_SELECTION_BATCH_SIZE, cursor);
        for (const row of await enrich(rows)) {
          if (row.financialWorkflow.state !== financialWorkflow) continue;
          if (total >= offset && selected.length < limit) selected.push(row);
          total++;
        }
        if (rows.length < FINANCIAL_SELECTION_BATCH_SIZE) break;
      }
      return { purchaseOrders: selected, total };
    });
  };
}

export const getPurchaseOrderList = createPurchaseOrderListService();
