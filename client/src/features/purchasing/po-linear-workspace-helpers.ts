import { formatIntegerCents } from "@shared/utils/format-integer-cents";

export type ShipmentTransitionEndpoint =
  | "book"
  | "in-transit"
  | "at-port"
  | "customs-clearance"
  | "delivered";

/**
 * Returns the ordered sequence of POST endpoints on `/api/inbound-shipments/:id/<step>`
 * needed to fast-forward a shipment from its current status straight to `delivered`.
 * Uses the direct `in_transit -> delivered` transition allowed by the server state machine.
 */
export function computeShipmentDeliverySteps(
  currentStatus: string | null | undefined,
): ShipmentTransitionEndpoint[] {
  switch (currentStatus) {
    case "draft":
      return ["book", "in-transit", "delivered"];
    case "booked":
      return ["in-transit", "delivered"];
    case "in_transit":
      return ["delivered"];
    case "at_port":
      return ["customs-clearance", "delivered"];
    case "customs_clearance":
      return ["delivered"];
    default:
      return [];
  }
}

export type PoLinearStageState = "done" | "current" | "attention" | "upcoming";

export interface PoLinearStageSummary {
  id: "order" | "bills" | "shipping" | "receiving" | "cogs";
  stepNumber: 1 | 2 | 3 | 4 | 5;
  title: string;
  state: PoLinearStageState;
  badgeLabel: string;
}

export interface ComputePoLinearStagesInput {
  poStatus: string | null | undefined;
  physicalStatus: string | null | undefined;
  linesCount: number;
  totalOrderedPieces: number;
  totalReceivedPieces: number;
  linkedShipmentsCount: number;
  allShipmentsDeliveredOrLater: boolean;
  financialCompletionSupported: boolean;
  financialReviewRequired: boolean;
  linkedInvoicesCount: number;
  inventoryCostingStatus: string | null | undefined;
  costReviewLinesCount: number;
  unallocatedChargeCount: number;
}

function badgeForState(state: PoLinearStageState): string {
  switch (state) {
    case "done":
      return "Complete";
    case "current":
      return "Next Step";
    case "attention":
      return "Needs Review";
    case "upcoming":
      return "Upcoming";
  }
}

export function computePoLinearStageStates(
  input: ComputePoLinearStagesInput,
): PoLinearStageSummary[] {
  const status = input.poStatus ?? "draft";
  const phys = input.physicalStatus ?? "draft";
  const isDispatched =
    ["sent", "acknowledged", "shipped", "in_transit", "arrived", "receiving", "received", "short_closed"].includes(phys) ||
    ["sent", "acknowledged", "partially_received", "received", "closed"].includes(status);

  // 1. Order & Quote
  const orderState: PoLinearStageState =
    input.linesCount === 0 && !isDispatched
      ? "attention"
      : isDispatched
        ? "done"
        : "current";

  // 2. Bills & Payments
  const billsState: PoLinearStageState = input.financialReviewRequired
    ? "attention"
    : input.financialCompletionSupported
      ? "done"
      : isDispatched || input.linkedInvoicesCount > 0
        ? "current"
        : "upcoming";

  // 3. Shipping & Customs
  const goodsAtOrPastDock = ["arrived", "receiving", "received", "short_closed"].includes(phys) ||
    ["partially_received", "received", "closed"].includes(status) ||
    (input.linkedShipmentsCount > 0 && input.allShipmentsDeliveredOrLater);
  const shippingState: PoLinearStageState = goodsAtOrPastDock
    ? "done"
    : isDispatched
      ? "current"
      : "upcoming";

  // 4. Dock Receiving
  const fullyReceived =
    phys === "received" ||
    phys === "short_closed" ||
    status === "received" ||
    status === "closed" ||
    (input.totalOrderedPieces > 0 && input.totalReceivedPieces >= input.totalOrderedPieces && isDispatched);
  const receivingState: PoLinearStageState = fullyReceived
    ? "done"
    : goodsAtOrPastDock || input.totalReceivedPieces > 0
      ? "current"
      : "upcoming";

  // 5. Landed COGS
  const cogsNeedsAttention =
    input.costReviewLinesCount > 0 ||
    input.unallocatedChargeCount > 0 ||
    input.inventoryCostingStatus === "review_required";
  const cogsApplied =
    input.inventoryCostingStatus === "applied" ||
    (fullyReceived && input.inventoryCostingStatus === "no_costs" && !cogsNeedsAttention);
  const cogsState: PoLinearStageState = cogsNeedsAttention
    ? "attention"
    : cogsApplied
      ? "done"
      : input.totalReceivedPieces > 0 || input.linkedShipmentsCount > 0
        ? "current"
        : "upcoming";

  const stages: Array<Omit<PoLinearStageSummary, "badgeLabel">> = [
    { id: "order", stepNumber: 1, title: "Order & Quote", state: orderState },
    { id: "bills", stepNumber: 2, title: "Bills & Payments", state: billsState },
    { id: "shipping", stepNumber: 3, title: "Shipping & Customs", state: shippingState },
    { id: "receiving", stepNumber: 4, title: "Dock Receiving", state: receivingState },
    { id: "cogs", stepNumber: 5, title: "Landed COGS", state: cogsState },
  ];

  return stages.map((s) => ({ ...s, badgeLabel: badgeForState(s.state) }));
}

export type InvoiceSchedulePreset = "full" | "deposit_30" | "deposit_50" | "balance_70";

export function buildInvoiceSchedulePresetNote(
  preset: InvoiceSchedulePreset,
  poNumber: string,
  poTotalCents: number | null | undefined,
  currency = "USD",
): { label: string; targetCents: number; note: string } {
  const safeTotal = Math.max(0, Math.trunc(Number(poTotalCents) || 0));
  switch (preset) {
    case "deposit_30": {
      const targetCents = Math.round(safeTotal * 0.3);
      return {
        label: "30% Deposit",
        targetCents,
        note: `30% deposit schedule (${formatIntegerCents(targetCents, currency)} of ${formatIntegerCents(safeTotal, currency)}) for ${poNumber}`,
      };
    }
    case "deposit_50": {
      const targetCents = Math.round(safeTotal * 0.5);
      return {
        label: "50% Deposit",
        targetCents,
        note: `50% deposit schedule (${formatIntegerCents(targetCents, currency)} of ${formatIntegerCents(safeTotal, currency)}) for ${poNumber}`,
      };
    }
    case "balance_70": {
      const deposit30 = Math.round(safeTotal * 0.3);
      const targetCents = Math.max(0, safeTotal - deposit30);
      return {
        label: "70% Balance",
        targetCents,
        note: `70% balance schedule (${formatIntegerCents(targetCents, currency)} remaining of ${formatIntegerCents(safeTotal, currency)}) for ${poNumber}`,
      };
    }
    case "full":
    default:
      return {
        label: "100% Full PO",
        targetCents: safeTotal,
        note: "",
      };
  }
}
