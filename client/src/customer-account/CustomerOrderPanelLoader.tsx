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
  onLabel(authorizationId: number, omsOrderId: number): Promise<boolean>;
}) {
  const summary = props.summary?.status === "verified" ? props.summary.order : null;
  const actions = props.actions;
  const unverified = actions?.state === "ready" ? actions.snapshot : null;
  const mismatch = Boolean(unverified?.order && (unverified.order.connectionId !== props.connectionId
    || (summary?.omsOrderId !== null && summary?.omsOrderId !== undefined && summary.omsOrderId !== unverified.order.omsOrderId)));
  const snapshot = mismatch ? null : unverified;
  const state: CustomerOrderPanelState = {
    loading: !props.actionError && (!actions || actions.state === "refreshing"),
    error: props.actionError || mismatch || actions?.state === "failed" || snapshot?.orderFailed || snapshot?.returnFailed
      ? "Some order options couldn’t be loaded." : props.historyError,
    order: snapshot?.order ?? null,
    omsOrderId: actions?.omsOrderId ?? summary?.omsOrderId ?? null,
    returnOrder: snapshot?.returnOrder ?? null,
  };
  return <CustomerOrderPanel {...props} state={state} summary={summary} onChanged={props.onRefresh}
    onRetry={() => {
      if (props.accessNotice || !props.connectionId || props.historyError) props.onAccessRetry();
      else props.onActionRetry();
    }} />;
}
