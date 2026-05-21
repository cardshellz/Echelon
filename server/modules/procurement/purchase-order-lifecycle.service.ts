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

export type PoLifecycleCommand =
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

export type PoNextAction = {
  id: PoLifecycleCommand;
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

export type PoAutoDraftActionPlanActionId =
  | PoLifecycleCommand
  | "open_lines"
  | "open_exceptions"
  | "create_invoice"
  | "record_payment"
  | "done"
  | "cancelled";

export type PoAutoDraftActionPlanStepStatus = "done" | "current" | "pending" | "blocked";

export type PoAutoDraftActionPlan = {
  kind: "auto_draft_po_next_action";
  primaryAction: {
    id: PoAutoDraftActionPlanActionId;
    label: string;
    detail: string;
    severity: "info" | "warning" | "critical" | "success";
    tab?: "lines" | "exceptions" | "receipts" | "invoices" | "payments" | "shipments";
    lifecycleActionId?: PoLifecycleCommand;
  };
  checklist: Array<{
    id: string;
    label: string;
    status: PoAutoDraftActionPlanStepStatus;
    detail?: string;
  }>;
  context: {
    lineCount: number | null;
    openExceptionCount: number;
    legacyStatus: string;
    physicalStatus: PoPhysicalStatus;
    financialStatus: PoFinancialStatus;
    availableLifecycleActionIds: PoLifecycleCommand[];
  };
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

export function buildPoAutoDraftActionPlan(
  po: Record<string, any>,
  context: {
    lineCount?: number | null;
    openExceptionCount?: number | null;
  } = {},
): PoAutoDraftActionPlan | null {
  if (po.source !== "auto_draft") return null;

  const lifecycle = buildPoLifecycleSummary(po);
  const actionIds = lifecycle.nextActions.map((action) => action.id);
  const hasAction = (...ids: PoLifecycleCommand[]) => ids.some((id) => actionIds.includes(id));
  const lineCount = context.lineCount ?? null;
  const openExceptionCount = Math.max(0, Number(context.openExceptionCount ?? 0) || 0);
  const hasLines = lineCount === null || lineCount > 0;
  const legacyStatus = lifecycle.legacyStatus;
  const physicalStatus = lifecycle.physicalStatus;
  const financialStatus = lifecycle.financialStatus;
  const sentToSupplier = ["sent", "acknowledged", "shipped", "in_transit", "arrived", "receiving", "received", "short_closed"].includes(physicalStatus);
  const receivedInventory = ["received", "short_closed"].includes(physicalStatus) || ["received", "closed"].includes(legacyStatus);
  const isCancelled = legacyStatus === "cancelled" || physicalStatus === "cancelled";
  const needsDraftReview = legacyStatus === "draft";

  const reviewStatus: PoAutoDraftActionPlanStepStatus =
    openExceptionCount > 0 ? "blocked" : hasLines && !needsDraftReview ? "done" : "current";
  const sendStatus: PoAutoDraftActionPlanStepStatus =
    isCancelled ? "blocked" : sentToSupplier ? "done" : hasAction("send", "send_to_vendor", "submit", "approve") ? "current" : "pending";
  const receivingStatus: PoAutoDraftActionPlanStepStatus =
    isCancelled ? "blocked" : receivedInventory ? "done" : sentToSupplier || hasAction("create_receipt") ? "current" : "pending";
  const apStatus: PoAutoDraftActionPlanStepStatus =
    isCancelled
      ? "blocked"
      : financialStatus === "paid"
        ? "done"
        : receivedInventory || ["invoiced", "partially_paid", "disputed"].includes(financialStatus)
          ? "current"
          : "pending";

  const checklist: PoAutoDraftActionPlan["checklist"] = [];
  if (openExceptionCount > 0) {
    checklist.push({
      id: "exceptions",
      label: "Resolve exceptions",
      status: "blocked",
      detail: `${openExceptionCount} open exception${openExceptionCount === 1 ? "" : "s"} must be cleared before this PO is safe to advance.`,
    });
  }
  checklist.push(
    {
      id: "review_lines",
      label: "Review drafted PO",
      status: reviewStatus,
      detail: lineCount === null
        ? "Confirm vendor, quantities, costs, and MOQ before sending."
        : `${lineCount} line${lineCount === 1 ? "" : "s"} on this PO. Confirm quantities, costs, and MOQ before sending.`,
    },
    {
      id: "send_supplier",
      label: "Send to supplier",
      status: sendStatus,
      detail: sentToSupplier ? "Supplier send has been recorded." : "Send the reviewed PO to the vendor.",
    },
    {
      id: "receive_inventory",
      label: "Receive inventory",
      status: receivingStatus,
      detail: receivedInventory ? "Receiving is complete." : "Track shipment movement and create the receiving record when goods arrive.",
    },
    {
      id: "ap_closeout",
      label: "AP closeout",
      status: apStatus,
      detail: financialStatus === "paid" ? "Invoice and payment are complete." : "Create the vendor invoice and record payment for landed-cost and financial reporting.",
    },
  );

  const makePrimary = (
    primaryAction: PoAutoDraftActionPlan["primaryAction"],
  ): PoAutoDraftActionPlan => ({
    kind: "auto_draft_po_next_action",
    primaryAction,
    checklist,
    context: {
      lineCount,
      openExceptionCount,
      legacyStatus,
      physicalStatus,
      financialStatus,
      availableLifecycleActionIds: actionIds,
    },
  });

  if (openExceptionCount > 0) {
    return makePrimary({
      id: "open_exceptions",
      label: "Resolve PO exceptions",
      detail: "Clear the open exception queue before advancing this auto-drafted PO.",
      severity: "critical",
      tab: "exceptions",
    });
  }

  if (isCancelled) {
    return makePrimary({
      id: "cancelled",
      label: "PO cancelled",
      detail: "This auto-drafted PO is terminal. Review history if the demand still needs a replacement PO.",
      severity: "warning",
    });
  }

  if (!hasLines || legacyStatus === "draft") {
    return makePrimary({
      id: "open_lines",
      label: "Review drafted quantities",
      detail: hasLines
        ? "Confirm vendor, quantities, costs, and MOQ, then use the available send action."
        : "This auto-drafted PO has no lines; review the recommendation source before sending.",
      severity: hasLines ? "info" : "warning",
      tab: "lines",
    });
  }

  if (hasAction("approve")) {
    return makePrimary({
      id: "approve",
      lifecycleActionId: "approve",
      label: "Approve PO",
      detail: "The reviewed auto-draft is waiting for approval before supplier send.",
      severity: "info",
    });
  }

  if (hasAction("send_to_vendor", "send")) {
    const actionId = hasAction("send_to_vendor") ? "send_to_vendor" : "send";
    return makePrimary({
      id: actionId,
      lifecycleActionId: actionId,
      label: actionId === "send_to_vendor" ? "Send to vendor" : "Mark as sent",
      detail: "The PO is approved and ready for supplier communication.",
      severity: "info",
    });
  }

  if (hasAction("acknowledge")) {
    return makePrimary({
      id: "acknowledge",
      lifecycleActionId: "acknowledge",
      label: "Record supplier acknowledgment",
      detail: "Capture the vendor reference or confirmed delivery date if available.",
      severity: "info",
    });
  }

  if (hasAction("mark_shipped")) {
    return makePrimary({
      id: "mark_shipped",
      lifecycleActionId: "mark_shipped",
      label: "Mark shipped",
      detail: "Update the PO once the supplier ships the goods.",
      severity: "info",
      tab: "shipments",
    });
  }

  if (hasAction("mark_in_transit")) {
    return makePrimary({
      id: "mark_in_transit",
      lifecycleActionId: "mark_in_transit",
      label: "Mark in transit",
      detail: "Update transit status or shipment tracking before receiving.",
      severity: "info",
      tab: "shipments",
    });
  }

  if (hasAction("mark_arrived")) {
    return makePrimary({
      id: "mark_arrived",
      lifecycleActionId: "mark_arrived",
      label: "Mark arrived",
      detail: "Record that goods have reached the warehouse, then receive them.",
      severity: "info",
      tab: "shipments",
    });
  }

  if (hasAction("create_receipt")) {
    return makePrimary({
      id: "create_receipt",
      lifecycleActionId: "create_receipt",
      label: "Create receipt",
      detail: "Start receiving so inventory, landed cost, and PO state stay aligned.",
      severity: "info",
      tab: "receipts",
    });
  }

  if (receivedInventory && financialStatus === "unbilled") {
    return makePrimary({
      id: "create_invoice",
      label: "Create vendor invoice",
      detail: "Receiving is complete; create the invoice so AP and landed cost can reconcile.",
      severity: "info",
      tab: "invoices",
    });
  }

  if (["invoiced", "partially_paid", "disputed"].includes(financialStatus)) {
    return makePrimary({
      id: "record_payment",
      label: "Record payment",
      detail: "Record payment against the linked invoice when it is paid.",
      severity: financialStatus === "disputed" ? "warning" : "info",
      tab: "payments",
    });
  }

  if (hasAction("close")) {
    return makePrimary({
      id: "close",
      lifecycleActionId: "close",
      label: "Close PO",
      detail: "The PO can be closed once receiving and finance review are complete.",
      severity: "info",
    });
  }

  return makePrimary({
    id: "done",
    label: "No next action",
    detail: "This auto-drafted PO has no open lifecycle, receiving, or AP action from the current state.",
    severity: financialStatus === "paid" ? "success" : "info",
  });
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
