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

export function resolveCurrentPhysicalStatus(po: Record<string, any>): PoPhysicalStatus {
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

export type PoLifecycleTrack = "legacy" | "physical" | "financial" | "receiving";

export type PoNextAction = {
  id:
    | "submit"
    | "return_to_draft"
    | "approve"
    | "send"
    | "send_to_vendor"
    | "acknowledge"
    | "mark_shipped"
    | "mark_in_transit"
    | "mark_arrived"
    | "create_receipt"
    | "cancel"
    | "close"
    | "close_short";
  label: string;
  track: PoLifecycleTrack;
  method: "POST";
  endpoint: string;
  targetStatus?: string;
  requiresDialog?: boolean;
  destructive?: boolean;
  requiredPermission: {
    resource: string;
    action: string;
  };
};

export type PoLifecycleSummary = {
  legacyStatus: string;
  physicalStatus: PoPhysicalStatus;
  financialStatus: PoFinancialStatus;
  allowedLegacyTransitions: string[];
  allowedPhysicalTransitions: PoPhysicalStatus[];
  allowedFinancialTransitions: PoFinancialStatus[];
  isTerminal: boolean;
  nextActions: PoNextAction[];
};

const CANCELLABLE_LEGACY_STATUSES = new Set(["draft", "pending_approval", "approved", "sent", "acknowledged"]);

function action(
  po: Record<string, any>,
  values: Omit<PoNextAction, "endpoint" | "method"> & { endpointSuffix: string },
): PoNextAction {
  const base = po.id ? `/api/purchase-orders/${po.id}` : "/api/purchase-orders/:id";
  const { endpointSuffix, ...rest } = values;
  return {
    ...rest,
    method: "POST",
    endpoint: `${base}/${endpointSuffix}`,
  };
}

export function buildPoLifecycleSummary(po: Record<string, any>): PoLifecycleSummary {
  const legacyStatus = po.status ?? "draft";
  const physicalStatus = resolveCurrentPhysicalStatus(po);
  const financialStatus = (po.financialStatus ?? "unbilled") as PoFinancialStatus;
  const allowedLegacyTransitions = getAllowedLegacyTransitions(legacyStatus);
  const allowedPhysicalTransitions = getAllowedPhysicalTransitions(physicalStatus);
  const allowedFinancialTransitions = getAllowedFinancialTransitions(financialStatus);
  const nextActions: PoNextAction[] = [];

  if (legacyStatus === "draft") {
    nextActions.push(
      action(po, {
        id: "submit",
        label: "Submit",
        track: "legacy",
        endpointSuffix: "submit",
        targetStatus: "pending_approval",
        requiredPermission: { resource: "purchasing", action: "create" },
      }),
      action(po, {
        id: "send_to_vendor",
        label: "Send to vendor",
        track: "physical",
        endpointSuffix: "send-to-vendor",
        targetStatus: "sent",
        requiredPermission: { resource: "purchasing", action: "create" },
      }),
    );
  }

  if (allowedLegacyTransitions.includes("draft")) {
    nextActions.push(action(po, {
      id: "return_to_draft",
      label: "Return to draft",
      track: "legacy",
      endpointSuffix: "return-to-draft",
      targetStatus: "draft",
      requiredPermission: { resource: "purchasing", action: "edit" },
    }));
  }

  if (allowedLegacyTransitions.includes("approved")) {
    nextActions.push(action(po, {
      id: "approve",
      label: "Approve",
      track: "legacy",
      endpointSuffix: "approve",
      targetStatus: "approved",
      requiredPermission: { resource: "purchasing", action: "approve" },
    }));
  }

  if (legacyStatus === "approved" && allowedPhysicalTransitions.includes("sent")) {
    nextActions.push(
      action(po, {
        id: "send",
        label: "Mark as sent",
        track: "physical",
        endpointSuffix: "send",
        targetStatus: "sent",
        requiredPermission: { resource: "purchasing", action: "create" },
      }),
      action(po, {
        id: "send_to_vendor",
        label: "Send to vendor",
        track: "physical",
        endpointSuffix: "send-to-vendor",
        targetStatus: "sent",
        requiredPermission: { resource: "purchasing", action: "create" },
      }),
    );
  }

  if (allowedPhysicalTransitions.includes("acknowledged")) {
    nextActions.push(action(po, {
      id: "acknowledge",
      label: "Mark acknowledged",
      track: "physical",
      endpointSuffix: "acknowledge",
      targetStatus: "acknowledged",
      requiresDialog: true,
      requiredPermission: { resource: "purchasing", action: "edit" },
    }));
  }

  if (allowedPhysicalTransitions.includes("shipped")) {
    nextActions.push(action(po, {
      id: "mark_shipped",
      label: "Mark shipped",
      track: "physical",
      endpointSuffix: "mark-shipped",
      targetStatus: "shipped",
      requiredPermission: { resource: "purchasing", action: "edit" },
    }));
  }

  if (allowedPhysicalTransitions.includes("in_transit")) {
    nextActions.push(action(po, {
      id: "mark_in_transit",
      label: "Mark in transit",
      track: "physical",
      endpointSuffix: "mark-in-transit",
      targetStatus: "in_transit",
      requiredPermission: { resource: "purchasing", action: "edit" },
    }));
  }

  if (allowedPhysicalTransitions.includes("arrived")) {
    nextActions.push(action(po, {
      id: "mark_arrived",
      label: "Mark arrived",
      track: "physical",
      endpointSuffix: "mark-arrived",
      targetStatus: "arrived",
      requiredPermission: { resource: "purchasing", action: "edit" },
    }));
  }

  if (["sent", "acknowledged", "partially_received"].includes(legacyStatus)) {
    nextActions.push(action(po, {
      id: "create_receipt",
      label: "Create receipt",
      track: "receiving",
      endpointSuffix: "create-receipt",
      requiredPermission: { resource: "inventory", action: "receive" },
    }));
  }

  if (CANCELLABLE_LEGACY_STATUSES.has(legacyStatus) && allowedPhysicalTransitions.includes("cancelled")) {
    nextActions.push(action(po, {
      id: "cancel",
      label: ["sent", "acknowledged"].includes(legacyStatus) ? "Void" : "Cancel",
      track: "physical",
      endpointSuffix: "cancel",
      targetStatus: "cancelled",
      requiresDialog: true,
      destructive: true,
      requiredPermission: { resource: "purchasing", action: "cancel" },
    }));
  }

  if (allowedLegacyTransitions.includes("closed")) {
    nextActions.push(action(po, {
      id: "close",
      label: "Close PO",
      track: "legacy",
      endpointSuffix: "close",
      targetStatus: "closed",
      requiredPermission: { resource: "purchasing", action: "create" },
    }));
  }

  if (legacyStatus === "partially_received" && allowedPhysicalTransitions.includes("short_closed")) {
    nextActions.push(action(po, {
      id: "close_short",
      label: "Close short",
      track: "physical",
      endpointSuffix: "close-short",
      targetStatus: "short_closed",
      requiresDialog: true,
      destructive: true,
      requiredPermission: { resource: "purchasing", action: "approve" },
    }));
  }

  return {
    legacyStatus,
    physicalStatus,
    financialStatus,
    allowedLegacyTransitions,
    allowedPhysicalTransitions,
    allowedFinancialTransitions,
    isTerminal:
      allowedLegacyTransitions.length === 0 &&
      allowedPhysicalTransitions.length === 0 &&
      allowedFinancialTransitions.length === 0,
    nextActions,
  };
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
