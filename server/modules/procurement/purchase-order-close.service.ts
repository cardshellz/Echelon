import type { PoPhysicalStatus } from "@shared/schema/procurement.schema";
import {
  buildPhysicalTransitionChange,
  getAllowedLegacyTransitions,
  PoLifecycleError,
  type LifecycleChange,
} from "./purchase-order-lifecycle.service";

export function buildPoCloseChange(params: {
  po: Record<string, any>;
  userId?: string;
  notes?: string;
  now?: Date;
}): LifecycleChange {
  const { po, userId, notes } = params;
  const current = po.status;
  const allowed = getAllowedLegacyTransitions(current);

  if (!allowed.includes("closed")) {
    throw new PoLifecycleError(
      `Cannot transition from '${current}' to 'closed'`,
      400,
      { current, target: "closed", allowed },
    );
  }

  const now = params.now ?? new Date();
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
    closeShortReason: reason,
  };
}

export function buildPoCloseShortChange(params: {
  po: Record<string, any>;
  reason: string;
  userId?: string;
  now?: Date;
}): LifecycleChange {
  const { po, reason, userId, now } = params;

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
  });
}
