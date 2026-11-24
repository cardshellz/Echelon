import {
  poLineStatusEnum,
  type PoPhysicalStatus,
} from "@shared/schema/procurement.schema";
import { isPoLineType } from "@shared/procurement/po-line-type";
import {
  buildPhysicalTransitionChange,
  canOrdinarilyClosePurchaseOrder,
  resolveCurrentPhysicalStatus,
  PoLifecycleError,
  type LifecycleChange,
} from "./purchase-order-lifecycle.service";

export interface PoCloseLine {
  id: number;
  lineType?: string | null;
  status: string;
  orderQty: number;
  receivedQty: number | null;
  cancelledQty: number | null;
}

function closeTimestamp(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new PoLifecycleError(
      "Closing could not obtain a valid command timestamp",
      500,
      {
        code: "PO_CLOSE_CLOCK_INVALID",
      },
    );
  }
  return new Date(value.getTime());
}

export function normalizePoCloseShortReason(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PoLifecycleError("Close-short reason is required", 400, {
      code: "PO_CLOSE_SHORT_REASON_REQUIRED",
    });
  }
  return value.trim();
}

function assertProductLinesReceived(
  poId: unknown,
  lines: readonly PoCloseLine[],
): void {
  const activeProductLines: PoCloseLine[] = [];
  for (const line of lines) {
    if (!(poLineStatusEnum as readonly string[]).includes(line.status)) {
      throw new PoLifecycleError(
        "Review the purchase line status before closing the PO",
        409,
        {
          code: "PO_CLOSE_RECEIPT_EVIDENCE_INVALID",
          purchaseOrderId: poId,
          lineId: line.id,
        },
      );
    }
    // The legacy receipt owner treats a missing line type as product. Keep that
    // compatibility, but never interpret an unrecognized type as a financial line.
    const lineType = line.lineType ?? "product";
    if (!isPoLineType(lineType)) {
      throw new PoLifecycleError(
        "Review the purchase line type before closing the PO",
        409,
        {
          code: "PO_CLOSE_RECEIPT_EVIDENCE_INVALID",
          purchaseOrderId: poId,
          lineId: line.id,
        },
      );
    }
    if (lineType === "product" && line.status !== "cancelled")
      activeProductLines.push(line);
  }
  if (activeProductLines.length === 0) {
    throw new PoLifecycleError(
      "No active product receipt evidence is available to close this PO",
      409,
      {
        code: "PO_CLOSE_RECEIPT_EVIDENCE_INVALID",
        purchaseOrderId: poId,
      },
    );
  }
  const incompleteLineIds: number[] = [];
  for (const line of activeProductLines) {
    // Nullable legacy counters use the same zero semantics as receipt reconciliation.
    const received = line.receivedQty ?? 0;
    const cancelled = line.cancelledQty ?? 0;
    if (
      ![line.orderQty, received, cancelled].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    ) {
      throw new PoLifecycleError(
        "Review invalid purchase receipt quantities before closing the PO",
        409,
        {
          code: "PO_CLOSE_RECEIPT_EVIDENCE_INVALID",
          purchaseOrderId: poId,
          lineId: line.id,
        },
      );
    }
    // Preserve receipt reconciliation's remaining-quantity rule, including
    // explicitly cancelled quantities and legitimate overreceipts, without overflow.
    if (
      BigInt(line.orderQty) - BigInt(received) - BigInt(cancelled) >
      BigInt(0)
    )
      incompleteLineIds.push(line.id);
  }
  if (incompleteLineIds.length > 0) {
    throw new PoLifecycleError(
      "Receive the outstanding goods, or use close-short with an approval and reason",
      409,
      {
        code: "PO_CLOSE_RECEIPT_INCOMPLETE",
        purchaseOrderId: poId,
        lineIds: incompleteLineIds,
      },
    );
  }
}

export function buildPoCloseChange(params: {
  po: Record<string, any>;
  lines: readonly PoCloseLine[];
  userId?: string;
  notes?: string;
  now: Date;
}): LifecycleChange {
  const { po, userId, notes } = params;
  const current = po.status;
  if (!canOrdinarilyClosePurchaseOrder(po)) {
    throw new PoLifecycleError(
      "Ordinary close requires a fully received PO. Use close-short with an approval and reason for incomplete receipts.",
      409,
      {
        code: "PO_CLOSE_RECEIPT_INCOMPLETE",
        purchaseOrderId: po.id,
        current,
        physicalStatus: resolveCurrentPhysicalStatus(po),
        target: "closed",
      },
    );
  }
  assertProductLinesReceived(po.id, params.lines);
  const now = closeTimestamp(params.now);
  return {
    patch: {
      status: "closed",
      closedAt: now,
      closedBy: userId,
      updatedBy: userId,
    },
    history: {
      fromStatus: current,
      toStatus: "closed",
      changedBy: userId,
      notes: notes || "PO closed",
    },
  };
}

export function buildPoCloseShortLinePatch(
  line: Record<string, any>,
  reason: string,
): Record<string, unknown> | null {
  if (line.status !== "open" && line.status !== "partially_received") {
    return null;
  }

  return {
    status: "closed",
    closeShortReason: normalizePoCloseShortReason(reason),
  };
}

export function buildPoCloseShortChange(params: {
  po: Record<string, any>;
  reason: string;
  userId?: string;
  now: Date;
}): LifecycleChange {
  const { po, userId } = params;
  const reason = normalizePoCloseShortReason(params.reason);
  const now = closeTimestamp(params.now);

  if (po.status !== "partially_received") {
    throw new PoLifecycleError(
      "Can only close-short a partially received PO",
      400,
      {
        current: po.status,
        target: "closed",
        physicalTarget: "short_closed" as PoPhysicalStatus,
      },
    );
  }

  return buildPhysicalTransitionChange({
    po,
    target: "short_closed",
    userId,
    notes: `Closed short: ${reason}`,
    now,
    extraPatch: { closedAt: now, closedBy: userId ?? null },
  });
}
