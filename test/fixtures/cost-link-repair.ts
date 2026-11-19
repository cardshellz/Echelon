import type { CostLinkRepairSummary } from "../../shared/procurement/cost-link-repair";

export const costLinkRepair: CostLinkRepairSummary = {
  evidenceVersion: "d".repeat(64),
  originsRestored: [
    {
      lotId: 501,
      lotNumber: "RECEIPT-LOT",
      receiptLineId: 32,
      receivedUnits: 2,
      piecesPerUnit: 1000,
    },
  ],
  operations: [
    {
      key: "historical_cost_link:801",
      kind: "transfer",
      occurredAt: "2026-07-23 10:00:01",
      sourceLotId: 501,
      sourceLotNumber: "RECEIPT-LOT",
      sourceSku: "CASE",
      sourceUnits: 2,
      sourcePiecesPerUnit: 1000,
      movementIds: [801],
      description: "Recorded warehouse transfer",
      outputs: [
        {
          lotId: 502,
          lotNumber: "STORAGE-LOT",
          sku: "CASE",
          units: 2,
          piecesPerUnit: 1000,
        },
      ],
    },
    {
      key: "historical_cost_link:802",
      kind: "conversion",
      occurredAt: "2026-07-23 10:00:02",
      sourceLotId: 502,
      sourceLotNumber: "STORAGE-LOT",
      sourceSku: "CASE",
      sourceUnits: 1,
      sourcePiecesPerUnit: 1000,
      movementIds: [802, 803],
      description: "Recorded case opened into packs",
      outputs: [
        {
          lotId: 503,
          lotNumber: "PACK-LOT",
          sku: "PACK",
          units: 10,
          piecesPerUnit: 100,
        },
      ],
    },
  ],
  lots: [
    {
      lotId: 503,
      lotNumber: "PACK-LOT",
      sku: "PACK",
      onHandUnits: 5,
      productMills: { before: 10000, after: 100000 },
      packagingMills: { before: 0, after: 0 },
      shipmentMills: { before: 0, after: 250000 },
      orderCostCents: { before: 100, after: 350 },
      linkedOrderRows: 1,
    },
  ],
  remainingIssues: [
    "STORAGE-LOT: 1 CASE unit has no linked stock or order destination. Its cost stays unassigned; no expense will be created.",
  ],
  stockUnitChange: 0,
  newExpensePostings: 0,
};
