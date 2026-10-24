import { useEffect, useRef, useState } from "react";
import { ChevronRight, X } from "lucide-react";
import type { OrderEditOrder } from "@shared/order-edits/order-edit.contract";
import type { CustomerReturnCustomerOrder } from "@shared/returns/customer-return-access.contract";
import type { CustomerAccountTransport } from "./customer-account.transport";
import type { CustomerAccountAccessNotice } from "./customer-account-access";
import { CustomerOrderCancellation } from "./CustomerOrderCancellation";
import { formatOrderEditMoney } from "@/lib/order-edits";
import { knownCustomerOrderFulfillment } from "@shared/customer-account/order-fulfillment";
import type { CustomerAccountOrderSummary } from "@shared/customer-account/customer-account-orders";
import { CustomerOrderDetails } from "./CustomerOrderDetails";

export interface CustomerOrderPanelState {
  loading: boolean;
  error: string | null;
  order: OrderEditOrder | null;
  omsOrderId: number | null;
  returnOrder: CustomerReturnCustomerOrder | null;
}
export const loadingOrderPanelState: CustomerOrderPanelState = {
  loading: true,
  error: null,
  order: null,
  omsOrderId: null,
  returnOrder: null,
};
type ReturnHistory = Awaited<
  ReturnType<ReturnType<CustomerAccountTransport["returns"]>["history"]>
>;

function safeLink(row: HTMLElement, selector: string): string | null {
  const anchor = row.querySelector<HTMLAnchorElement>(selector);
  if (!anchor) return null;
  try {
    const url = new URL(anchor.href, window.location.href);
    return ["https:", "http:"].includes(url.protocol) &&
      (url.protocol === "https:" || url.origin === window.location.origin)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function CustomerOrderPanel({
  row,
  opener,
  state,
  api,
  customerId,
  connectionId,
  enabled,
  accessNotice,
  signInUrl,
  history,
  onClose,
  onRetry,
  onEdit,
  onReturn,
  onLabel,
  summary,
  onChanged,
}: {
  row: HTMLElement;
  opener: HTMLButtonElement;
  state: CustomerOrderPanelState;
  summary?: OrderEditOrder | CustomerAccountOrderSummary | null;
  api: CustomerAccountTransport;
  customerId: string;
  connectionId: number | null;
  enabled: boolean;
  accessNotice: CustomerAccountAccessNotice | null;
  signInUrl: string;
  history: ReturnHistory | null;
  onClose(): void;
  onChanged?(): void;
  onRetry(): void;
  onEdit(omsOrderId: number): void;
  onReturn(order: CustomerReturnCustomerOrder): void;
  onLabel(authorizationId: number, omsOrderId: number): Promise<boolean>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState<"options" | "cancellation">("options");
  const [returnError, setReturnError] = useState<{
    authorizationId: number;
    omsOrderId: number;
  } | null>(null);
  const [loadingLabel, setLoadingLabel] = useState(false);
  const [reorderState, setReorderState] = useState({
    busy: false,
    added: false,
    error: null as string | null,
  });
  const order = state.order;
  const displayedOrder = order ?? summary;
  const fulfillmentLabel =
    knownCustomerOrderFulfillment(displayedOrder?.fulfillment)?.label ??
    (row
      .querySelector<HTMLElement>("[data-csz-order-fulfillment-native]")
      ?.textContent?.trim() ||
      "Status unavailable");
  const addressUrl = safeLink(row, "[data-csz-account-action='address']");
  const trackUrl = safeLink(row, "[data-csz-account-track]");
  const reorder = row.querySelector<HTMLButtonElement>(
    "[data-csz-account-reorder]",
  );
  useEffect(() => {
    if (!reorder) return;
    const update = () =>
      setReorderState((previous) => ({
        ...previous,
        busy: reorder.disabled || reorder.hasAttribute("data-loading"),
        added: reorder.hasAttribute("data-success"),
      }));
    const failed = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      const message =
        typeof detail === "object" &&
        detail !== null &&
        "message" in detail &&
        typeof detail.message === "string"
          ? detail.message.slice(0, 500)
          : "We couldn’t add these items to your cart. Please try again.";
      setReorderState({ busy: false, added: false, error: message });
    };
    const observer = new MutationObserver(update);
    observer.observe(reorder, {
      attributes: true,
      attributeFilter: ["disabled", "data-loading", "data-success"],
    });
    reorder.addEventListener("cardshellz:reorder-error", failed);
    update();
    return () => {
      observer.disconnect();
      reorder.removeEventListener("cardshellz:reorder-error", failed);
    };
  }, [reorder]);
  const returns =
    history?.returns.filter((item) => item.omsOrderId === state.omsOrderId) ??
    [];
  const editing = Boolean(
    order?.activeOperationId && order.activeOperationKind !== "cancel_order",
  );
  const reviewNotice =
    editing && order?.activeOperationStatus === "review_required";
  const canEdit =
    enabled &&
    order &&
    order.activeOperationKind !== "cancel_order" &&
    (editing || order.eligibility.editable);
  const isCancellation = order?.activeOperationKind === "cancel_order";
  const cancellationRequest = order?.cancellation?.requestKey ?? null;
  const showCancellation = Boolean(
    connectionId &&
      state.omsOrderId &&
      (cancellationRequest || (enabled && order?.cancellation?.canReview)),
  );
  const showChangeActions =
    row.dataset.cancelled !== "true" && row.dataset.fulfillment !== "fulfilled";
  const canChangeAddress = Boolean(
    enabled &&
      addressUrl &&
      order &&
      (order.addressEligibility?.editable ??
        (order.eligibility.editable && !order.activeOperationId)),
  );
  const addressReason =
    order?.addressEligibility?.reasons[0] ??
    order?.eligibility.reasons[0] ??
    (state.loading
      ? "Checking whether the address can be changed…"
      : "Contact us to change this order’s shipping address.");
  const cancellationReason =
    order?.cancellation?.reasons?.[0] ??
    (state.loading
      ? "Checking whether the order can be cancelled…"
      : "Contact us to cancel this order.");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      requestAnimationFrame(() => {
        if (opener.isConnected && !document.querySelector("dialog[open]"))
          opener.focus();
      });
    };
  }, [opener]);
  async function showLabel(
    authorizationId: number,
    omsOrderId: number,
  ): Promise<void> {
    if (loadingLabel) return;
    setLoadingLabel(true);
    setReturnError(null);
    try {
      if (!(await onLabel(authorizationId, omsOrderId)))
        setReturnError({ authorizationId, omsOrderId });
    } finally {
      setLoadingLabel(false);
    }
  }
  const option = (label: string, action: () => void, destructive = false) => (
    <button
      type="button"
      className={`csz-panel-option${destructive ? " csz-panel-cancel" : ""}`}
      onClick={action}
    >
      <span>{label}</span>
      <ChevronRight aria-hidden="true" size={16} />
    </button>
  );
  const restriction =
    !order || canEdit || isCancellation
      ? null
      : order.fulfillment?.code === "picking"
        ? "Your order is being picked. Contact us to request changes or cancellation."
        : order.fulfillment?.code === "preparing_shipment"
          ? "Your order is being prepared for shipping. Contact us to request changes or cancellation."
          : ["shipped", "partially_shipped", "cancelled"].includes(
                order.fulfillment?.code ?? "",
              )
            ? null
            : "Changes aren’t available online for this order. Contact us for help.";
  return (
    <dialog
      ref={dialog}
      id="csz-order-panel"
      className="csz-order-panel csz-account-ui"
      aria-labelledby="csz-order-panel-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="csz-order-panel-content">
        <header className="csz-panel-heading">
          <div>
            <p>Manage order</p>
            <h2 id="csz-order-panel-title">
              Order {order?.orderNumber ?? row.dataset.orderReference}
            </h2>
          </div>
          <button
            type="button"
            className="csz-panel-close"
            aria-label="Close order options"
            onClick={onClose}
          >
            <X aria-hidden="true" size={22} />
          </button>
        </header>
        {view === "options" &&
          (state.loading && !displayedOrder ? (
            <p role="status">Loading order details…</p>
          ) : (
            <div className="csz-panel-summary">
              <span>{fulfillmentLabel}</span>
              <strong>
                {displayedOrder
                  ? formatOrderEditMoney(
                      displayedOrder.totalCents,
                      displayedOrder.currency,
                    )
                  : "Total unavailable"}
              </strong>
              {displayedOrder && (
                <small>{displayedOrder.financialStatus}</small>
              )}
            </div>
          ))}
        {view === "cancellation" && connectionId && state.omsOrderId ? (
          <CustomerOrderCancellation
            api={api}
            scope={{ customerId, connectionId, omsOrderId: state.omsOrderId }}
            existingRequestKey={cancellationRequest}
            onBack={() => setView("options")}
            onDone={() => {
              onChanged?.();
              onClose();
            }}
          />
        ) : (
          <>
            {accessNotice && (
              <div className="csz-panel-error" role="alert">
                <p>{accessNotice.message}</p>
                {accessNotice.action === "sign_in" ? (
                  <a className="csz-action" href={signInUrl}>
                    Sign in again
                  </a>
                ) : (
                  <button
                    type="button"
                    className="csz-action"
                    onClick={onRetry}
                  >
                    Try again
                  </button>
                )}
              </div>
            )}
            {!accessNotice && state.loading && (
              <p role="status">Loading order options…</p>
            )}
            {!accessNotice && state.error && (
              <div className="csz-panel-error" role="alert">
                <p>Some order options couldn’t be loaded.</p>
                <button
                  type="button"
                  className="csz-action"
                  onClick={onRetry}
                  disabled={state.loading}
                >
                  Try again
                </button>
              </div>
            )}
            {editing && (order?.settlement?.outstandingCents ?? 0) > 0 && (
              <div className="csz-panel-payment">
                <p>Your order update is waiting for payment.</p>
                <button
                  type="button"
                  className="csz-action"
                  onClick={() => onEdit(order!.omsOrderId)}
                >
                  Pay the difference
                </button>
              </div>
            )}
            {reviewNotice && (
              <p
                id="csz-order-review-notice"
                className="csz-panel-explanation"
                role="status"
              >
                Your previous order update needs our review. Address changes and
                cancellation are unavailable until it is resolved.
              </p>
            )}
            <h3 className="csz-panel-group">Your order</h3>
            {row.dataset.externalOrderId && row.dataset.orderReference && (
              <CustomerOrderDetails
                api={api}
                row={row}
                ready={connectionId !== null}
                externalOrderId={row.dataset.externalOrderId}
                orderReference={row.dataset.orderReference}
              />
            )}
            {canEdit &&
              option(
                order?.activeOperationStatus === "review_required"
                  ? "View order update"
                  : editing
                    ? "Continue order update"
                    : "Edit order",
                () => onEdit(order!.omsOrderId),
              )}
            {showChangeActions &&
              addressUrl &&
              (canChangeAddress ? (
                <a className="csz-panel-option" href={addressUrl}>
                  <span>Change shipping address</span>
                  <ChevronRight aria-hidden="true" size={16} />
                </a>
              ) : (
                <div>
                  <button
                    type="button"
                    className="csz-panel-option"
                    disabled
                    aria-describedby={
                      reviewNotice
                        ? "csz-order-review-notice"
                        : "csz-address-restriction"
                    }
                  >
                    Change shipping address
                  </button>
                  {!reviewNotice && (
                    <p
                      id="csz-address-restriction"
                      className="csz-panel-restriction"
                    >
                      {addressReason}
                    </p>
                  )}
                </div>
              ))}
            {reorder && (
              <button
                type="button"
                className="csz-panel-option"
                disabled={reorderState.busy}
                aria-busy={reorderState.busy}
                onClick={() => {
                  setReorderState((previous) => ({ ...previous, error: null }));
                  reorder.click();
                }}
              >
                <span>
                  {reorderState.added
                    ? "Added to cart"
                    : reorderState.busy
                      ? "Adding to cart…"
                      : "Buy again"}
                </span>
                <ChevronRight aria-hidden="true" size={16} />
              </button>
            )}
            {reorderState.error && (
              <p role="alert" className="csz-panel-error">
                {reorderState.error}
              </p>
            )}
            {restriction && (
              <p className="csz-panel-explanation">{restriction}</p>
            )}
            {(trackUrl || state.returnOrder || returns.length > 0) && (
              <h3 className="csz-panel-group">Delivery and returns</h3>
            )}
            {trackUrl && (
              <a className="csz-panel-option" href={trackUrl}>
                <span>View shipment tracking</span>
                <ChevronRight aria-hidden="true" size={16} />
              </a>
            )}
            {state.returnOrder?.order.lines.some(
              (line) => line.eligibleQuantity > 0,
            ) && option("Return items", () => onReturn(state.returnOrder!))}
            {returns.map((item) => (
              <button
                type="button"
                className="csz-panel-option"
                key={item.authorizationId}
                disabled={loadingLabel}
                onClick={() =>
                  void showLabel(item.authorizationId, item.omsOrderId)
                }
              >
                <span>
                  View return and label
                  {returns.length > 1 ? ` · ${item.authorizationNumber}` : ""}
                </span>
                <ChevronRight aria-hidden="true" size={16} />
              </button>
            ))}
            {returnError && (
              <div className="csz-panel-error" role="alert">
                <p>We couldn’t load your return. Please try again.</p>
                <button
                  type="button"
                  className="csz-action"
                  disabled={loadingLabel}
                  onClick={() =>
                    void showLabel(
                      returnError.authorizationId,
                      returnError.omsOrderId,
                    )
                  }
                >
                  Try again
                </button>
              </div>
            )}
            {showCancellation
              ? option(
                  cancellationRequest ? "View cancellation" : "Cancel order",
                  () => setView("cancellation"),
                  !cancellationRequest,
                )
              : showChangeActions && (
                  <div>
                    <button
                      type="button"
                      className="csz-panel-option csz-panel-cancel"
                      disabled
                      aria-describedby={
                        reviewNotice
                          ? "csz-order-review-notice"
                          : "csz-cancellation-restriction"
                      }
                    >
                      Cancel order
                    </button>
                    {!reviewNotice && (
                      <p
                        id="csz-cancellation-restriction"
                        className="csz-panel-restriction"
                      >
                        {cancellationReason}
                      </p>
                    )}
                  </div>
                )}
            {isCancellation && !cancellationRequest && (
              <p>
                An order cancellation is being reviewed. Contact us for help.
              </p>
            )}
          </>
        )}
        <p className="csz-panel-help">
          Need help? <a href="/pages/contact-us">Contact us</a>
        </p>
      </div>
    </dialog>
  );
}
