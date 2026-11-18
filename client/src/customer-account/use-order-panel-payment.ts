import { useRef, useState } from "react";
import type { OrderEditOrder } from "@shared/order-edits/order-edit.contract";
import type { CustomerAccountTransport } from "./customer-account.transport";
import { orderEditPaymentDestination } from "./order-edit-payment-handoff";
import {
  orderEditPaymentReturnStorage,
  saveOrderEditPaymentReturn,
} from "./order-edit-payment-return";
import {
  orderEditWatchesStatus,
  useOrderEditStatus,
} from "./use-order-edit-status";

interface PaymentScope {
  operationId: string;
  omsOrderId: number;
  orderNumber: string;
  connectionId: number;
}

/** Explicit Pay observes the owned edit and navigates directly. It never opens
 * another approval form or sends an edit, reconciliation or payment command. */
export function useOrderPanelPayment(options: {
  api: CustomerAccountTransport;
  order: OrderEditOrder | null;
  customerId: string;
  connectionId: number | null;
  disabled: boolean;
  onChanged?(): void;
}) {
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [resolvedOperationId, setResolvedOperationId] = useState<string | null>(
    null,
  );
  const revision = useRef(0);
  const opened = useRef<string | null>(null);
  const scope = useRef<PaymentScope | null>(null);
  const observation = useOrderEditStatus({
    operationId: paymentId,
    watching: paymentId !== null && !options.disabled,
    readImmediately: true,
    read: (id, signal) => options.api.edits.operation(id, signal),
    busy: () => false,
    revision: () => revision.current,
    received: (value) => {
      if (options.disabled) {
        setPaymentId(null);
        return;
      }
      const target = scope.current;
      if (
        !target ||
        value.operationId !== target.operationId ||
        value.orderNumber !== target.orderNumber
      )
        throw new Error("The payment does not belong to this order update.");
      setProcessing(value.error?.code === "ORDER_EDIT_PAYMENT_PENDING");
      const destination = orderEditPaymentDestination(
        value,
        target.operationId,
      );
      if (destination) {
        if (opened.current === target.operationId) return;
        opened.current = target.operationId;
        const storage = orderEditPaymentReturnStorage();
        if (storage)
          saveOrderEditPaymentReturn(
            { owner: options.customerId, ...target },
            storage,
            Date.now,
          );
        try {
          window.location.assign(destination);
        } catch {
          console.warn(JSON.stringify({ event: "customer_order_payment_navigation", code: "PAYMENT_NAVIGATION_FAILED", operationId: target.operationId }));
          setPaymentId(null);
          setNavigationError("We couldn’t open checkout. Please try again.");
        }
        return;
      }
      if (
        value.commandInProgress ||
        value.error?.code === "ORDER_EDIT_PAYMENT_PENDING" ||
        (orderEditWatchesStatus(value.status) &&
          value.balanceDueCents > 0 &&
          !value.error)
      ) {
        setNotice(
          value.error?.code === "ORDER_EDIT_PAYMENT_PENDING"
            ? "Your payment is processing. This page will update automatically."
            : "Preparing your payment…",
        );
        return;
      }
      setPaymentId(null);
      setResolvedOperationId(target.operationId);
      setNotice(
        value.status === "recovered"
          ? "Those changes expired and your original order was restored."
          : value.status === "completed"
            ? "No additional payment is due."
            : value.status === "ready" ||
                value.status === "preparing" ||
                value.status === "expired"
              ? "These changes haven’t been applied. Open your order update to review them."
              : value.status === "review_required" ||
                  value.status === "failed" ||
                  value.error
                ? "We couldn’t open payment. View your order update for details."
                : "No additional payment is due.",
      );
      options.onChanged?.();
    },
  });
  function pay(): void {
    if (paymentId) {
      if (observation.error) {
        opened.current = null;
        observation.retry();
      }
      return;
    }
    const { order, connectionId } = options;
    if (!order?.activeOperationId || !connectionId || options.disabled) return;
    revision.current += 1;
    opened.current = null;
    scope.current = {
      operationId: order.activeOperationId,
      omsOrderId: order.omsOrderId,
      orderNumber: order.orderNumber,
      connectionId,
    };
    setNavigationError(null);
    setProcessing(false);
    setNotice("Opening payment…");
    setPaymentId(order.activeOperationId);
  }
  return {
    pay,
    busy: paymentId !== null && !observation.error,
    failed: Boolean(observation.error || navigationError),
    processing,
    message: observation.error
      ? "We couldn’t load payment. Please try again."
      : (navigationError ?? notice),
    resolvedOperationId,
  };
}
