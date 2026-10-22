import { useEffect, useState } from "react";
import {
  CustomerOrderPanel,
  loadingOrderPanelState,
  type CustomerOrderPanelState,
} from "./CustomerOrderPanel";
import type { CustomerAccountTransport } from "./customer-account.transport";
import type { CustomerOrderTotalsState } from "./CustomerAccountOrderTotals";
import type { CustomerReturnCustomerOrder } from "@shared/returns/customer-return-access.contract";
import type { OrderEditOrder } from "@shared/order-edits/order-edit.contract";
import type { CustomerAccountAccessNotice } from "./customer-account-access";

/** Eligibility is fetched only for the open order. Closing this panel does not
 * bootstrap the account again or discard other rows' verified financial facts. */
export function CustomerOrderPanelLoader(props: {
  row: HTMLElement;
  opener: HTMLButtonElement;
  api: CustomerAccountTransport;
  customerId: string;
  connectionId: number | null;
  enabled: boolean;
  sessionKey?: string;
  summary?: CustomerOrderTotalsState;
  statusUnavailable: boolean;
  accessNotice: CustomerAccountAccessNotice | null;
  signInUrl: string;
  history: Awaited<
    ReturnType<ReturnType<CustomerAccountTransport["returns"]>["history"]>
  > | null;
  historyError: string | null;
  onClose(): void;
  onRefresh(): void;
  onAccessRetry(): void;
  onVerified(row: HTMLElement, order: OrderEditOrder): void;
  onEdit(omsOrderId: number): void;
  onReturn(order: CustomerReturnCustomerOrder): void;
  onLabel(authorizationId: number, omsOrderId: number): Promise<boolean>;
}) {
  const [state, setState] = useState<CustomerOrderPanelState>(
    loadingOrderPanelState,
  );
  const [attempt, setAttempt] = useState(0);
  const summary =
    props.summary?.status === "verified" ? props.summary.order : null;
  const omsOrderId = summary?.omsOrderId ?? null;
  const { api, row, connectionId, sessionKey, onVerified } = props;
  const settledSummary = props.summary && props.summary.status !== "loading";
  useEffect(() => {
    if (!connectionId || !settledSummary) return;
    if (!omsOrderId) {
      setState({
        loading: false,
        error: props.statusUnavailable || props.summary?.status === "failed"
          ? "Order options couldn’t be loaded."
          : null,
        order: null,
        omsOrderId: null,
        returnOrder: null,
      });
      return;
    }
    const controller = new AbortController();
    setState(loadingOrderPanelState);
    const canHaveReturn =
      ["fulfilled", "partial"].includes(row.dataset.fulfillment ?? "") &&
      row.dataset.cancelled !== "true";
    void Promise.allSettled([
      api.edits.order(connectionId, omsOrderId, controller.signal),
      canHaveReturn && sessionKey
        ? api.returns(sessionKey).order(omsOrderId, controller.signal)
        : Promise.resolve(null),
    ]).then(([read, returns]) => {
      if (controller.signal.aborted) return;
      const order = read.status === "fulfilled" ? read.value : null;
      if (
        order &&
        (order.connectionId !== connectionId ||
          order.omsOrderId !== omsOrderId ||
          order.orderNumber !== row.dataset.orderReference ||
          (order.financials &&
            order.financials.totalCents !== order.totalCents))
      ) {
        setState({
          ...loadingOrderPanelState,
          loading: false,
          error: "Order details could not be verified.",
        });
        return;
      }
      if (order) onVerified(row, order);
      setState({
        loading: false,
        omsOrderId,
        order,
        returnOrder: returns.status === "fulfilled" ? returns.value : null,
        error:
          read.status === "rejected" || returns.status === "rejected"
            ? "Some order options couldn’t be loaded."
            : null,
      });
    });
    return () => controller.abort();
  }, [
    api,
    row,
    connectionId,
    sessionKey,
    omsOrderId,
    settledSummary,
    props.statusUnavailable,
    attempt,
    onVerified,
  ]);
  return (
    <CustomerOrderPanel
      {...props}
      state={{ ...state, error: state.error ?? props.historyError }}
      summary={summary}
      onChanged={props.onRefresh}
      onRetry={() => {
        if (props.accessNotice || !connectionId || props.historyError)
          props.onAccessRetry();
        else {
          setAttempt((value) => value + 1);
          if (!omsOrderId) props.onRefresh();
        }
      }}
    />
  );
}
