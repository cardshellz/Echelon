import type { PoFinancialStatus, PoPhysicalStatus } from "@shared/schema/procurement.schema";

export class PoLifecycleError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
    public details?: unknown,
  ) {
    super(message);
    this.name = "PoLifecycleError";
  }
}

export const LEGACY_PO_TRANSITIONS: Record<string, string[]> = {
  draft: ["pending_approval", "approved", "cancelled"],
  pending_approval: ["draft", "approved", "cancelled"],
  approved: ["sent", "cancelled"],
  sent: ["acknowledged", "partially_received", "received", "cancelled"],
  acknowledged: ["partially_received", "received", "cancelled"],
  partially_received: ["received", "closed"],
  received: ["closed"],
};

export const PO_PHYSICAL_TRANSITIONS: Record<PoPhysicalStatus, PoPhysicalStatus[]> = {
  draft: ["sent", "cancelled"],
  sent: ["acknowledged", "cancelled"],
  acknowledged: ["shipped", "cancelled"],
  shipped: ["in_transit", "arrived", "cancelled"],
  in_transit: ["arrived", "cancelled"],
  arrived: ["receiving", "cancelled"],
  receiving: ["received", "short_closed"],
  received: [],
  short_closed: [],
  cancelled: [],
};

export const PO_FINANCIAL_TRANSITIONS: Record<PoFinancialStatus, PoFinancialStatus[]> = {
  unbilled: ["invoiced"],
  invoiced: ["partially_paid", "paid", "disputed"],
  partially_paid: ["paid", "disputed"],
  paid: [],
  disputed: ["partially_paid", "paid"],
};

// Maps physical movement to the legacy single-track status used by older callers.
export const PHYSICAL_TO_LEGACY_STATUS: Partial<Record<PoPhysicalStatus, string>> = {
  draft: "approved",
  sent: "sent",
  acknowledged: "acknowledged",
  shipped: "acknowledged",
  in_transit: "acknowledged",
  arrived: "acknowledged",
  receiving: "partially_received",
  received: "received",
  short_closed: "closed",
  cancelled: "cancelled",
};

const LEGACY_TO_PHYSICAL_STATUS: Partial<Record<string, PoPhysicalStatus>> = {
  draft: "draft",
  pending_approval: "draft",
  approved: "draft",
  sent: "sent",
  acknowledged: "acknowledged",
  partially_received: "receiving",
  received: "received",
  closed: "received",
  cancelled: "cancelled",
};

const PHYSICAL_TIMESTAMP_COLUMN: Partial<Record<PoPhysicalStatus, string>> = {
  sent: "sentToVendorAt",
  shipped: "firstShippedAt",
  arrived: "firstArrivedAt",
  received: "actualDeliveryDate",
  cancelled: "cancelledAt",
};

function resolveCurrentPhysicalStatus(po: Record<string, any>): PoPhysicalStatus {
  const physical = (po.physicalStatus ?? "draft") as PoPhysicalStatus;

  // Back-compat for pre-dual-track rows where legacy status had advanced but
  // physical_status still had its default draft value.
  if (physical === "draft") {
    return LEGACY_TO_PHYSICAL_STATUS[po.status] ?? physical;
  }

  return physical;
}

export function getAllowedLegacyTransitions(currentStatus: string): string[] {
  return LEGACY_PO_TRANSITIONS[currentStatus] ?? [];
}

export function getAllowedPhysicalTransitions(status: PoPhysicalStatus): PoPhysicalStatus[] {
  return PO_PHYSICAL_TRANSITIONS[status] ?? [];
}

export function getAllowedFinancialTransitions(status: PoFinancialStatus): PoFinancialStatus[] {
  return PO_FINANCIAL_TRANSITIONS[status] ?? [];
}

export type LifecycleChange = {
  patch: Record<string, unknown>;
  history: {
    fromStatus: string;
    toStatus: string;
    changedBy?: string;
    notes?: string;
  };
};

export function buildPhysicalTransitionChange(params: {
  po: Record<string, any>;
  target: PoPhysicalStatus;
  userId?: string;
  notes?: string;
  now?: Date;
  extraPatch?: Record<string, unknown>;
  historyFromStatus?: string;
}): LifecycleChange {
  const { po, target, userId, notes, extraPatch, historyFromStatus } = params;
  const current = resolveCurrentPhysicalStatus(po);
  const allowed = getAllowedPhysicalTransitions(current);

  if (!allowed.includes(target)) {
    throw new PoLifecycleError(
      `Cannot transition physical status from '${current}' to '${target}'`,
      400,
      { current, target, allowed },
    );
  }

  const now = params.now ?? new Date();
  const patch: Record<string, unknown> = {
    physicalStatus: target,
    updatedBy: userId,
  };

  const tsCol = PHYSICAL_TIMESTAMP_COLUMN[target];
  if (tsCol && !po[tsCol]) {
    patch[tsCol] = now;
  }

  const legacyStatus = PHYSICAL_TO_LEGACY_STATUS[target];
  if (legacyStatus) {
    patch.status = legacyStatus;
  }

  if (target === "cancelled" && !po.cancelledAt) {
    patch.cancelledAt = now;
    patch.cancelledBy = userId ?? null;
  }
  if (target === "short_closed" && !po.closedAt) {
    patch.closedAt = now;
    patch.closedBy = userId ?? null;
  }

  Object.assign(patch, extraPatch ?? {});

  return {
    patch,
    history: {
      fromStatus: historyFromStatus ?? po.status ?? current,
      toStatus: legacyStatus ?? po.status,
      changedBy: userId,
      notes: notes ?? `Physical status: ${current} -> ${target}`,
    },
  };
}

export function buildFinancialTransitionChange(params: {
  po: Record<string, any>;
  target: PoFinancialStatus;
  userId?: string;
  notes?: string;
  now?: Date;
  extraPatch?: Record<string, unknown>;
}): LifecycleChange {
  const { po, target, userId, notes, extraPatch } = params;
  const current = (po.financialStatus ?? "unbilled") as PoFinancialStatus;
  const allowed = getAllowedFinancialTransitions(current);

  if (!allowed.includes(target)) {
    throw new PoLifecycleError(
      `Cannot transition financial status from '${current}' to '${target}'`,
      400,
      { current, target, allowed },
    );
  }

  const now = params.now ?? new Date();
  const patch: Record<string, unknown> = {
    financialStatus: target,
    updatedBy: userId,
  };

  if (target === "invoiced" && !po.firstInvoicedAt) {
    patch.firstInvoicedAt = now;
  }
  if ((target === "partially_paid" || target === "paid") && !po.firstPaidAt) {
    patch.firstPaidAt = now;
  }
  if (target === "paid" && !po.fullyPaidAt) {
    patch.fullyPaidAt = now;
  }

  Object.assign(patch, extraPatch ?? {});

  return {
    patch,
    history: {
      fromStatus: po.status,
      toStatus: po.status,
      changedBy: userId,
      notes: notes ?? `Financial status: ${current} -> ${target}`,
    },
  };
}
