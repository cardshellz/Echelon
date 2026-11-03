import { CustomerOrderPanel, type CustomerOrderPanelState } from "./CustomerOrderPanel";
import type { CustomerAccountTransport } from "./customer-account.transport";
import type { CustomerOrderTotalsState } from "./CustomerAccountOrderTotals";
import type { CustomerReturnCustomerOrder } from "@shared/returns/customer-return-access.contract";
import type { CustomerAccountAccessNotice } from "./customer-account-access";
import type { CustomerOrderActions } from "@shared/customer-account/order-actions";

/** Opening a panel renders the already-loaded page projection. No effect,
 * provider inspection, financial read or return lookup starts here. */
export function CustomerOrderPanelLoader(props: {
  row: HTMLElement;
  opener: HTMLButtonElement;
  api: CustomerAccountTransport;
  customerId: string;
  connectionId: number | null;
  enabled: boolean;
  summary?: CustomerOrderTotalsState;
  actions?: CustomerOrderActions;
  verifiedActions?: CustomerOrderActions;
  actionError: boolean;
  statusUnavailable: boolean;
  accessNotice: CustomerAccountAccessNotice | null;
  signInUrl: string;
  history: Awaited<ReturnType<ReturnType<CustomerAccountTransport["returns"]>["history"]>> | null;
  historyError: string | null;
  onClose(): void;
  onRefresh(): void;
  onActionRetry(): void;
  onAccessRetry(): void;
  onEdit(omsOrderId: number): void;
  onReturn(order: CustomerReturnCustomerOrder): void;
  onStartReturn(omsOrderId: number): void;
  onLabel(authorizationId: number, omsOrderId: number): Promise<boolean>;
}) {
  const summary = props.summary?.status === "verified" ? props.summary.order : null;
  const actions = props.actions;
  // A refresh invalidates command evidence, not the customer's menu. Commands
  // always recheck their owners; keep the same owned display until replaced.
  const retained = props.verifiedActions;
  const sameOwnedOrder = actions && retained && actions.state !== "not_managed" &&
    actions.externalOrderId === retained.externalOrderId && actions.orderReference === retained.orderReference &&
    actions.omsOrderId === retained.omsOrderId;
  const unverified = props.accessNotice ? null : sameOwnedOrder ? retained.snapshot
    : actions?.state === "ready" ? actions.snapshot : null;
  const mismatch = Boolean((unverified?.order && unverified.order.connectionId !== props.connectionId)
    || (summary?.omsOrderId != null && actions?.omsOrderId != null && summary.omsOrderId !== actions.omsOrderId));
  const snapshot = mismatch ? null : unverified;
  const state: CustomerOrderPanelState = {
    loading: !props.actionError && !snapshot && (!actions || actions.state === "refreshing"),
    error: props.actionError || mismatch || actions?.state === "failed" || (snapshot?.orderFailed && snapshot.returnFailed)
      ? "Some order options couldn’t be loaded. Try again to refresh them."
      : snapshot?.orderFailed ? snapshot.order ? "Order options couldn’t be refreshed. Your saved options are still available."
        : "Editing, address and cancellation options couldn’t be loaded."
        : snapshot?.returnFailed ? "Return options couldn’t be loaded. You can still open Return items."
          : props.historyError,
    order: snapshot?.order ?? null,
    omsOrderId: actions?.omsOrderId ?? summary?.omsOrderId ?? null,
    returnOrder: snapshot?.returnOrder ?? null,
    // This only opens the existing owned-order return lookup. A cache rebuild is
    // not a policy decision, and never authorizes intake or a label purchase.
    returnLookupAvailable: Boolean(props.enabled && props.connectionId && !props.accessNotice && !mismatch
      && (actions?.omsOrderId ?? summary?.omsOrderId) != null && props.row.dataset.cancelled !== "true"
      && (!snapshot || snapshot.returnFailed)),
  };
  return <CustomerOrderPanel {...props} state={state} summary={summary} onChanged={props.onRefresh}
    onRetry={() => {
      if (props.accessNotice || !props.connectionId || props.historyError) props.onAccessRetry();
      else props.onActionRetry();
    }} />;
}
