import {
  poLandedCostCreateSchema,
  poLandedCostPatchSchema,
  poLandedCostsResponseSchema,
  type PoLandedCostsResponse,
} from "@shared/procurement/po-landed-cost";
import { COGSService } from "../../inventory/cogs.service.api";
import {
  applyCostRevision,
  costInteger,
  lockInventoryCostGraph,
  type CostApplicationOptions,
  type CostComponentWriter,
  type CostEvidenceTransaction,
  type CostRevisionApplicationResult,
  type RecordedCostRevision,
} from "../../inventory/cost-application-public.api";
import { recordCostRevision } from "../infrastructure/cost-source-revision.repository";
import {
  allocatePoLandedCostsAcrossLines,
  buildPoLandedCostRevisionInputs,
} from "../domain/po-landed-cost-allocation";
import {
  deletePoLandedCostRecord,
  hasActiveInboundShipmentForPo,
  hasPoLandedCostsTable,
  insertPoLandedCostRecord,
  lockPurchaseOrderForLandedCosts,
  readPoIdForPurchaseOrderLine,
  readPoLandedCostRecords,
  readPoProductLinesForLandedCosts,
  readPurchaseOrderHeaderForLandedCosts,
  updatePoLandedCostRecord,
} from "../infrastructure/po-landed-cost.repository";

export class PoLandedCostError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
    public readonly code: string = "PO_LANDED_COST_ERROR",
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PoLandedCostError";
  }
}

type TransactionalDb = CostEvidenceTransaction & {
  transaction<T>(fn: (tx: CostEvidenceTransaction) => Promise<T>): Promise<T>;
};

export async function recordPoLandedCostRevisionForLine(
  tx: CostEvidenceTransaction,
  purchaseOrderId: number,
  purchaseOrderLineId: number,
  actorId: string,
  now: Date,
): Promise<RecordedCostRevision | null> {
  if (!(await hasPoLandedCostsTable(tx))) return null;
  const shipmentCheck = await hasActiveInboundShipmentForPo(tx, purchaseOrderId);
  if (shipmentCheck.hasShipment) return null;
  const charges = await readPoLandedCostRecords(tx, purchaseOrderId);
  if (charges.length === 0) return null;
  const lines = await readPoProductLinesForLandedCosts(tx, purchaseOrderId);
  const proposals = buildPoLandedCostRevisionInputs(purchaseOrderId, lines, charges);
  const matching = proposals.find((p) => p.lineId === purchaseOrderLineId);
  if (!matching) return null;
  return recordCostRevision(tx, matching.input, actorId, now, matching.sourceEvidence);
}

export async function reconcilePoLandedCostForLine(
  tx: CostEvidenceTransaction,
  purchaseOrderLineId: number,
  writer: CostComponentWriter,
  actorId: string,
  now: Date,
  options: CostApplicationOptions = {},
): Promise<{ revision: RecordedCostRevision; application: CostRevisionApplicationResult } | null> {
  if (!(await hasPoLandedCostsTable(tx))) return null;
  const purchaseOrderId = await readPoIdForPurchaseOrderLine(tx, purchaseOrderLineId);
  if (purchaseOrderId === null) return null;
  const revision = await recordPoLandedCostRevisionForLine(
    tx,
    purchaseOrderId,
    purchaseOrderLineId,
    actorId,
    now,
  );
  if (!revision) return null;
  const application = await applyCostRevision(tx, revision, writer, actorId, now, options);
  return { revision, application };
}

async function applyAllPoLandedCostRevisionsInTx(
  tx: CostEvidenceTransaction,
  purchaseOrderId: number,
  actorId: string,
  now: Date,
): Promise<{
  lotsUpdated: number;
  cogsRowsUpdated: number;
  totalCogsDeltaCents: number;
  costApplications: CostRevisionApplicationResult[];
}> {
  const lines = await readPoProductLinesForLandedCosts(tx, purchaseOrderId);
  if (lines.length === 0) {
    return { lotsUpdated: 0, cogsRowsUpdated: 0, totalCogsDeltaCents: 0, costApplications: [] };
  }
  const charges = await readPoLandedCostRecords(tx, purchaseOrderId);
  const proposals = buildPoLandedCostRevisionInputs(purchaseOrderId, lines, charges);
  const writer = new COGSService(tx as any);
  const costApplications: CostRevisionApplicationResult[] = [];
  for (const proposal of proposals) {
    const revision = await recordCostRevision(
      tx,
      proposal.input,
      actorId,
      now,
      proposal.sourceEvidence,
    );
    const application = await applyCostRevision(tx, revision, writer, actorId, now);
    costApplications.push(application);
  }
  return {
    lotsUpdated: costApplications.reduce((sum, r) => sum + r.lotsUpdated, 0),
    cogsRowsUpdated: costApplications.reduce((sum, r) => sum + r.cogsRowsUpdated, 0),
    totalCogsDeltaCents: costInteger(
      costApplications
        .reduce((sum, r) => sum + BigInt(r.totalCogsDeltaCents), BigInt(0))
        .toString(),
      "totalCogsDeltaCents",
      -Number.MAX_SAFE_INTEGER,
    ),
    costApplications,
  };
}

export function createPoLandedCostService(
  db: TransactionalDb,
  clock: () => Date = () => new Date(),
) {
  async function getPoLandedCosts(purchaseOrderId: number): Promise<PoLandedCostsResponse> {
    costInteger(purchaseOrderId, "purchaseOrderId", 1);
    return db.transaction(async (tx) => {
      const po = await readPurchaseOrderHeaderForLandedCosts(tx, purchaseOrderId);
      if (!po) {
        throw new PoLandedCostError("Purchase order not found.", 404, "PO_NOT_FOUND");
      }
      if (po.currency !== "USD") {
        throw new PoLandedCostError("PO landed costs require a USD purchase order.", 409, "PO_CURRENCY_UNSUPPORTED");
      }
      const shipmentInfo = await hasActiveInboundShipmentForPo(tx, purchaseOrderId);
      const charges = await readPoLandedCostRecords(tx, purchaseOrderId);
      const lines = await readPoProductLinesForLandedCosts(tx, purchaseOrderId);
      const allocated = allocatePoLandedCostsAcrossLines(purchaseOrderId, lines, charges);
      return poLandedCostsResponseSchema.parse({
        purchaseOrderId,
        currency: "USD",
        hasActiveInboundShipment: shipmentInfo.hasShipment,
        totalCents: allocated.totalCents,
        freightCents: allocated.freightCents,
        dutyCents: allocated.dutyCents,
        otherCents: allocated.otherCents,
        charges,
        lineAllocations: allocated.lineAllocations,
      });
    });
  }

  async function addPoLandedCost(
    purchaseOrderId: number,
    rawBody: unknown,
    actorId: string,
  ): Promise<PoLandedCostsResponse & { revaluation: { lotsUpdated: number; cogsRowsUpdated: number; totalCogsDeltaCents: number } }> {
    costInteger(purchaseOrderId, "purchaseOrderId", 1);
    if (!actorId || !actorId.trim()) {
      throw new PoLandedCostError("An authenticated user is required.", 401, "ACTOR_REQUIRED");
    }
    const input = poLandedCostCreateSchema.parse(rawBody);
    const now = clock();

    return db.transaction(async (tx) => {
      await lockInventoryCostGraph(tx);
      const po = await lockPurchaseOrderForLandedCosts(tx, purchaseOrderId);
      if (!po) {
        throw new PoLandedCostError("Purchase order not found.", 404, "PO_NOT_FOUND");
      }
      if (po.status === "cancelled") {
        throw new PoLandedCostError("Cannot add landed costs to a cancelled purchase order.", 409, "PO_CANCELLED");
      }
      if (po.currency !== "USD") {
        throw new PoLandedCostError("PO landed costs require a USD purchase order.", 409, "PO_CURRENCY_UNSUPPORTED");
      }
      const shipmentInfo = await hasActiveInboundShipmentForPo(tx, purchaseOrderId);
      if (shipmentInfo.hasShipment) {
        throw new PoLandedCostError(
          `This PO is linked to Inbound Shipment ${shipmentInfo.firstShipmentNumber || `#${shipmentInfo.firstShipmentId}`}. Attach freight or duty charges to that shipment so container allocations stay synchronized.`,
          409,
          "PO_HAS_ACTIVE_SHIPMENT",
          {
            shipmentId: shipmentInfo.firstShipmentId,
            shipmentNumber: shipmentInfo.firstShipmentNumber,
          },
        );
      }

      const lines = await readPoProductLinesForLandedCosts(tx, purchaseOrderId);
      if (lines.length === 0) {
        throw new PoLandedCostError("Add at least one product line to this PO before recording landed costs.", 409, "PO_NO_PRODUCT_LINES");
      }

      await insertPoLandedCostRecord(tx, purchaseOrderId, input, actorId, now);
      const revaluation = await applyAllPoLandedCostRevisionsInTx(tx, purchaseOrderId, actorId, now);
      const charges = await readPoLandedCostRecords(tx, purchaseOrderId);
      const allocated = allocatePoLandedCostsAcrossLines(purchaseOrderId, lines, charges);

      return {
        ...poLandedCostsResponseSchema.parse({
          purchaseOrderId,
          currency: "USD",
          hasActiveInboundShipment: false,
          totalCents: allocated.totalCents,
          freightCents: allocated.freightCents,
          dutyCents: allocated.dutyCents,
          otherCents: allocated.otherCents,
          charges,
          lineAllocations: allocated.lineAllocations,
        }),
        revaluation: {
          lotsUpdated: revaluation.lotsUpdated,
          cogsRowsUpdated: revaluation.cogsRowsUpdated,
          totalCogsDeltaCents: revaluation.totalCogsDeltaCents,
        },
      };
    });
  }

  async function updatePoLandedCost(
    purchaseOrderId: number,
    chargeId: number,
    rawBody: unknown,
    actorId: string,
  ): Promise<PoLandedCostsResponse & { revaluation: { lotsUpdated: number; cogsRowsUpdated: number; totalCogsDeltaCents: number } }> {
    costInteger(purchaseOrderId, "purchaseOrderId", 1);
    costInteger(chargeId, "chargeId", 1);
    if (!actorId || !actorId.trim()) {
      throw new PoLandedCostError("An authenticated user is required.", 401, "ACTOR_REQUIRED");
    }
    const patch = poLandedCostPatchSchema.parse(rawBody);
    const now = clock();

    return db.transaction(async (tx) => {
      await lockInventoryCostGraph(tx);
      const po = await lockPurchaseOrderForLandedCosts(tx, purchaseOrderId);
      if (!po) {
        throw new PoLandedCostError("Purchase order not found.", 404, "PO_NOT_FOUND");
      }
      if (po.status === "cancelled") {
        throw new PoLandedCostError("Cannot edit landed costs on a cancelled purchase order.", 409, "PO_CANCELLED");
      }
      const shipmentInfo = await hasActiveInboundShipmentForPo(tx, purchaseOrderId);
      if (shipmentInfo.hasShipment) {
        throw new PoLandedCostError(
          `This PO is linked to Inbound Shipment ${shipmentInfo.firstShipmentNumber || `#${shipmentInfo.firstShipmentId}`}. Manage freight and duty charges on that shipment.`,
          409,
          "PO_HAS_ACTIVE_SHIPMENT",
          { shipmentId: shipmentInfo.firstShipmentId },
        );
      }

      const updated = await updatePoLandedCostRecord(tx, purchaseOrderId, chargeId, patch, now);
      if (!updated) {
        throw new PoLandedCostError("PO landed cost charge not found.", 404, "CHARGE_NOT_FOUND");
      }

      const revaluation = await applyAllPoLandedCostRevisionsInTx(tx, purchaseOrderId, actorId, now);
      const lines = await readPoProductLinesForLandedCosts(tx, purchaseOrderId);
      const charges = await readPoLandedCostRecords(tx, purchaseOrderId);
      const allocated = allocatePoLandedCostsAcrossLines(purchaseOrderId, lines, charges);

      return {
        ...poLandedCostsResponseSchema.parse({
          purchaseOrderId,
          currency: "USD",
          hasActiveInboundShipment: false,
          totalCents: allocated.totalCents,
          freightCents: allocated.freightCents,
          dutyCents: allocated.dutyCents,
          otherCents: allocated.otherCents,
          charges,
          lineAllocations: allocated.lineAllocations,
        }),
        revaluation: {
          lotsUpdated: revaluation.lotsUpdated,
          cogsRowsUpdated: revaluation.cogsRowsUpdated,
          totalCogsDeltaCents: revaluation.totalCogsDeltaCents,
        },
      };
    });
  }

  async function removePoLandedCost(
    purchaseOrderId: number,
    chargeId: number,
    actorId: string,
  ): Promise<PoLandedCostsResponse & { revaluation: { lotsUpdated: number; cogsRowsUpdated: number; totalCogsDeltaCents: number } }> {
    costInteger(purchaseOrderId, "purchaseOrderId", 1);
    costInteger(chargeId, "chargeId", 1);
    if (!actorId || !actorId.trim()) {
      throw new PoLandedCostError("An authenticated user is required.", 401, "ACTOR_REQUIRED");
    }
    const now = clock();

    return db.transaction(async (tx) => {
      await lockInventoryCostGraph(tx);
      const po = await lockPurchaseOrderForLandedCosts(tx, purchaseOrderId);
      if (!po) {
        throw new PoLandedCostError("Purchase order not found.", 404, "PO_NOT_FOUND");
      }
      const deleted = await deletePoLandedCostRecord(tx, purchaseOrderId, chargeId);
      if (!deleted) {
        throw new PoLandedCostError("PO landed cost charge not found.", 404, "CHARGE_NOT_FOUND");
      }

      const revaluation = await applyAllPoLandedCostRevisionsInTx(tx, purchaseOrderId, actorId, now);
      const lines = await readPoProductLinesForLandedCosts(tx, purchaseOrderId);
      const charges = await readPoLandedCostRecords(tx, purchaseOrderId);
      const allocated = allocatePoLandedCostsAcrossLines(purchaseOrderId, lines, charges);

      return {
        ...poLandedCostsResponseSchema.parse({
          purchaseOrderId,
          currency: "USD",
          hasActiveInboundShipment: false,
          totalCents: allocated.totalCents,
          freightCents: allocated.freightCents,
          dutyCents: allocated.dutyCents,
          otherCents: allocated.otherCents,
          charges,
          lineAllocations: allocated.lineAllocations,
        }),
        revaluation: {
          lotsUpdated: revaluation.lotsUpdated,
          cogsRowsUpdated: revaluation.cogsRowsUpdated,
          totalCogsDeltaCents: revaluation.totalCogsDeltaCents,
        },
      };
    });
  }

  return {
    getPoLandedCosts,
    addPoLandedCost,
    updatePoLandedCost,
    removePoLandedCost,
  };
}
