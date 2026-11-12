import { useCallback, useEffect, useRef, useState } from "react";
import { OrderDraft, OrderEditOperationView } from "@/components/order-edits/OrderEditWorkspace";
import type { OrderEditCodeMessageCatalog } from "@shared/order-edits/order-edit-code-errors";
import {
  loadPendingOrderEditQuote,
  clearPendingOrderEditQuote,
  OrderEditRequestError,
} from "@/lib/order-edits";
import type {
  OrderEditOrder,
  OrderEditOperation,
  OrderEditQuoteInput,
} from "@shared/order-edits/order-edit.contract";
import type { CustomerAccountTransport } from "./customer-account.transport";
import {
  orderEditHasEditableDraft,
  orderEditNeedsPreparation,
} from "@/lib/order-edit-confirmation";
import { ClubRewardsWidget } from "./ClubRewardsWidget";
import {
  useOrderEditStatus,
  orderEditWatchesStatus,
} from "./use-order-edit-status";
import {
  saveOrderEditPaymentReturn,
  clearOrderEditPaymentReturn,
  orderEditPaymentReturnStorage,
} from "./order-edit-payment-return";
import { orderEditPaymentDestination } from "./order-edit-payment-handoff";
import { customerOrderEditUnavailable, customerOrderShippingCutoff } from "./order-edit-unavailability";

const closed = new Set<OrderEditOperation["status"]>([
  "completed",
  "recovered",
  "failed",
  "expired",
]);
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "We could not complete this edit. Please try again.";
export function CustomerOrderEditor({
  api,
  connectionId,
  omsOrderId,
  actorKey,
  enabled,
  onBusy,
  paymentOwner,
  returnOperationId,
  codeMessages,
  onDone,
}: {
  api: CustomerAccountTransport;
  connectionId: number;
  omsOrderId: number;
  actorKey: string;
  enabled: boolean;
  onBusy: (busy: boolean) => void;
  paymentOwner?: string;
  returnOperationId?: string;
  codeMessages?: OrderEditCodeMessageCatalog;
  onDone?: () => void;
}) {
  const [order, setOrder] = useState<OrderEditOrder | null>(null);
  const [operation, setOperation] = useState<OrderEditOperation | null>(null);
  const [initialOperation, setInitialOperation] =
    useState<OrderEditOperation | null>(null);
  const [discountCodes, setDiscountCodes] = useState<string[]>([]);
  const [pendingQuote, setPendingQuote] = useState<OrderEditQuoteInput | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rewardBusy, setRewardBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<
    "commit" | "reconcile" | "abandon"
  >();
  const [reloadRequired, setReloadRequired] = useState(false);
  const [reloadBusy, setReloadBusy] = useState(false);
  const reloadInFlight = useRef(false);
  const [locked, setLocked] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [observingCommand, setObservingCommand] = useState(false);
  const [checkoutIntent, setCheckoutIntent] = useState<string | null>(null);
  const paymentOpened = useRef<string | null>(null);
  const [draftVisible, setDraftVisible] = useState(true);
  const [closingQuote, setClosingQuote] = useState(false);
  const [closedOperationId, setClosedOperationId] = useState<string>();
  const [now, setNow] = useState(Date.now);
  const inFlight = useRef(false);
  const closeAfterAbandon = useRef(false);
  const statusRevision = useRef(0);
  const status = useOrderEditStatus({
    operationId: operation?.operationId ?? null,
    watching: Boolean(
      operation &&
        !draftVisible &&
        (observingCommand ||
          orderEditWatchesStatus(
            operation.status,
            operation.commandInProgress,
          )),
    ),
    readImmediately: observingCommand,
    read: (id, signal) => api.edits.operation(id, signal),
    busy: () => inFlight.current,
    revision: () => statusRevision.current,
    received: (value) => {
      if (order && value.orderNumber !== order.orderNumber)
        throw new Error("The saved edit does not belong to this order.");
      statusRevision.current += 1;
      setOperation(value);
      setError(null);
      setObservingCommand(value.commandInProgress === true);
      setUncertain(value.commandInProgress === true);
      if (closeAfterAbandon.current && !value.canAbandon && !value.commandInProgress) {
        // A concurrent command may have submitted or closed the operation.
        // Leave via an owned read rather than attempting to discard it again.
        finishUnavailableEdit();
        return;
      }
      if (closingQuote && value.status === "expired") {
        setClosedOperationId(value.operationId);
        setOperation(null);
        setClosingQuote(false);
        setDraftVisible(true);
        if (closeAfterAbandon.current) finishUnavailableEdit();
        else void reloadCancelledOrder();
      } else {
        setDraftVisible(orderEditHasEditableDraft(value));
        if (!value.commandInProgress) setClosingQuote(false);
      }
      if (
        closed.has(value.status) ||
        (value.status === "ready" && !value.commandInProgress)
      )
        setCheckoutIntent(null);
      if (observingCommand && value.status === "ready" && !value.commandInProgress)
        setNotice("Your changes have not been applied. Review the total below and try again.");
    },
  });
  const rememberPaymentReturn = useCallback(() => {
    const storage = orderEditPaymentReturnStorage();
    if (paymentOwner && operation && storage)
      saveOrderEditPaymentReturn(
        {
          owner: paymentOwner,
          connectionId,
          omsOrderId,
          operationId: operation.operationId,
          orderNumber: operation.orderNumber,
        },
        storage,
        Date.now,
      );
  }, [paymentOwner, operation, connectionId, omsOrderId]);
  useEffect(() => {
    if (!operation || uncertain || observingCommand) return;
    const destination = orderEditPaymentDestination(operation, checkoutIntent);
    if (!destination || paymentOpened.current === operation.operationId) return;
    paymentOpened.current = operation.operationId;
    rememberPaymentReturn();
    try {
      window.location.assign(destination);
    } catch {
      setError(
        "We couldn’t open payment. Use Pay the difference below to continue.",
      );
    }
  }, [
    operation,
    checkoutIntent,
    uncertain,
    observingCommand,
    rememberPaymentReturn,
  ]);
  useEffect(() => {
    onBusy(busy || locked || rewardBusy);
    return () => onBusy(false);
  }, [busy, locked, rewardBusy, onBusy]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        // A lost quote reply must be recovered with the original key. Never
        // silently overwrite a saved intent when another order is opened.
        const saved = loadPendingOrderEditQuote(actorKey, sessionStorage);
        if (saved) {
          if (!controller.signal.aborted) setPendingQuote(saved);
          return;
        }
        const current = await api.edits.order(
          connectionId,
          omsOrderId,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const operationToOpen = returnOperationId ?? current.activeOperationId;
        if (operationToOpen) {
          const active = await api.edits.operation(
            operationToOpen,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          if (active.orderNumber !== current.orderNumber)
            throw new Error("The saved edit does not belong to this order.");
          if (returnOperationId && paymentOwner) {
            const storage = orderEditPaymentReturnStorage();
            if (storage)
              clearOrderEditPaymentReturn(
                paymentOwner,
                returnOperationId,
                storage,
              );
          }
          setInitialOperation(active);
          setOperation(active);
          setDiscountCodes(active.requestedPlan?.discountCodes ?? []);
          setObservingCommand(active.commandInProgress === true);
          setUncertain(active.commandInProgress === true);
          setDraftVisible(orderEditHasEditableDraft(active));
          // Mount the draft only once its saved plan is available; mounting it
          // earlier would initialize quantities from the unchanged order.
          setOrder(current);
          if (
            !active.commandInProgress &&
            !customerOrderShippingCutoff(current) &&
            !customerOrderEditUnavailable(active) &&
            orderEditNeedsPreparation(active, Date.now())
          )
            await progress("resume", active);
        } else setOrder(current);
      } catch (cause) {
        if (!controller.signal.aborted) setError(message(cause));
      }
    })();
    return () => controller.abort();
  }, [
    api,
    connectionId,
    omsOrderId,
    actorKey,
    paymentOwner,
    returnOperationId,
  ]);

  async function received(
    result: OrderEditOperation,
    confirmDisplayedAmount = false,
  ) {
    statusRevision.current += 1;
    if (result.canAbandon && !result.requestedPlan) {
      setOperation(result);
      // Old quote responses can omit the saved plan. Hydrate it before exposing
      // editable controls; never guess quantities from the order baseline.
      result = await api.edits.operation(result.operationId);
      confirmDisplayedAmount = false;
    }
    if (result.requestedPlan?.discountCodes !== undefined)
      setDiscountCodes(result.requestedPlan.discountCodes);
    setOperation(result);
    setDraftVisible(orderEditHasEditableDraft(result));
    setLocked(false);
    setUncertain(false);
    setError(null);
    setNotice(null);
    try {
      clearPendingOrderEditQuote(actorKey, sessionStorage);
      setPendingQuote(null);
    } catch {
      setError(
        "Your edit is saved, but this browser could not clear its request reference. Keep this page open and contact us if you need help.",
      );
      return;
    }
    if (confirmDisplayedAmount) await progress("commit", result);
    else if (result.status === "ready")
      setNotice(
        "Your changes are verified. Confirm the total shown to apply them.",
      );
  }
  async function recoverQuote() {
    if (!pendingQuote || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await api.edits.quote(pendingQuote);
      if (!order) {
        const hydrated = result.requestedPlan
          ? result
          : await api.edits.operation(result.operationId);
        const current = await api.edits.order(connectionId, omsOrderId);
        setInitialOperation(hydrated);
        setOrder(current);
        await received(hydrated);
      } else await received(result);
    } catch (cause) {
      setError(message(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function reloadCancelledOrder() {
    if (reloadInFlight.current) return;
    reloadInFlight.current = true;
    setReloadRequired(true);
    setReloadBusy(true);
    setError(null);
    try {
      const current = await api.edits.order(connectionId, omsOrderId);
      setOrder(current);
      setReloadRequired(false);
      return current;
    } catch {
      setError(
        "Your edit was cancelled, but we couldn't reload your order. Please try again.",
      );
      return null;
    } finally {
      reloadInFlight.current = false;
      setReloadBusy(false);
    }
  }
  async function progress(
    action: "commit" | "reconcile" | "abandon" | "resume",
    target = operation,
  ): Promise<boolean> {
    if (!target || inFlight.current) return false;
    statusRevision.current += 1;
    inFlight.current = true;
    setBusy(true);
    setBusyAction(action === "resume" ? "reconcile" : action);
    if (action === "commit") setCheckoutIntent(target.operationId);
    setError(null);
    setNotice(action === "resume" ? "Recalculating your saved changes…" : null);
    if (action === "abandon") {
      setClosingQuote(true);
      // Show the retained draft immediately; another review waits for release.
      if (order) setDraftVisible(true);
    }
    try {
      const result = await api.edits[action](target.operationId);
      if (order && result.orderNumber !== order.orderNumber)
        throw new Error("The saved edit does not belong to this order.");
      setOperation(result);
      setUncertain(false);
      setObservingCommand(false);
      if (
        (action === "abandon" || closingQuote) &&
        result.status === "expired"
      ) {
        setClosedOperationId(result.operationId);
        setOperation(null);
        setClosingQuote(false);
        setDraftVisible(true);
        // Cancellation is confirmed. A failed read must not restore this edit
        // or permit a new review against stale eligibility/revision evidence.
        setBusy(false);
        if (closeAfterAbandon.current) {
          finishUnavailableEdit();
          return true;
        }
        return Boolean(await reloadCancelledOrder());
      } else if (action === "abandon" || closingQuote) {
        setDraftVisible(false);
        setClosingQuote(false);
      } else setDraftVisible(orderEditHasEditableDraft(result));
    } catch (cause) {
      if (
        closeAfterAbandon.current &&
        cause instanceof OrderEditRequestError &&
        cause.code === "ORDER_EDIT_ALREADY_SUBMITTED"
      ) {
        // Another command won the race. Return to the owned account read;
        // never discard, replay, or claim a result for that submitted command.
        finishUnavailableEdit();
        return false;
      }
      const recover =
        cause instanceof OrderEditRequestError &&
        (cause.uncertain || cause.code === "ORDER_EDIT_BUSY");
      setError(recover ? null : message(cause));
      setUncertain(recover);
      setObservingCommand(recover);
      // A busy guard rejects this attempt but another command owns the saved
      // edit. Recover that result using GET; never replay Apply or reconciliation.
      if (recover) setDraftVisible(false);
      else if (action === "commit") setCheckoutIntent(null);
    } finally {
      inFlight.current = false;
      setBusy(false);
      setBusyAction(undefined);
      if (action === "resume") setNotice(null);
      setLocked(false);
    }
    return false;
  }
  async function releaseForEditing(): Promise<boolean> {
    if (!operation) return !inFlight.current && !reloadRequired;
    if (!operation.canAbandon || uncertain) return false;
    return progress("abandon");
  }
  function finishUnavailableEdit() {
    if (onDone) onDone();
    else window.location.assign("/account");
  }
  const unsentShippingCutoff = Boolean(order && customerOrderShippingCutoff(order) &&
    (!operation || (operation.canAbandon && !operation.commandInProgress)));
  if (customerOrderEditUnavailable(operation) || unsentShippingCutoff || closeAfterAbandon.current)
    return (
      <section className="space-y-4" aria-label="Order changes unavailable">
        <h2>Order {operation?.orderNumber ?? order?.orderNumber}</h2>
        <h3>Online changes are no longer available</h3>
        <p>This order can no longer be changed online. Contact us if you need help.</p>
        {customerOrderEditUnavailable(operation) && (
          <p>No changes from this edit were applied.</p>
        )}
        {(error || status.error) && (
          <p role="alert">We couldn’t finish closing this edit. Please try again.</p>
        )}
        {(busy || uncertain || status.reading) && (
          <p role="status">Closing this edit…</p>
        )}
        <button
          type="button"
          className="csz-action"
          disabled={busy || status.reading || (observingCommand && !status.error)}
          onClick={() => {
            if (status.error) status.retry();
            else if (operation) {
              closeAfterAbandon.current = true;
              void progress("abandon");
            } else finishUnavailableEdit();
          }}
        >
          {busy || status.reading ? "Closing edit…" : error || status.error ? "Try again" : "Back to order"}
        </button>
        <a className="csz-account-link" href="/pages/contact-us">Contact us</a>
      </section>
    );
  if (pendingQuote && !operation)
    return (
      <div className="space-y-4">
        <p role="status">
          You have a saved edit request. Check it before starting another edit.
        </p>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <button
          className="csz-action"
          disabled={busy}
          onClick={() => void recoverQuote()}
        >
          {busy ? "Checking your saved edit…" : "Check saved edit"}
        </button>
      </div>
    );
  return (
    <div className="space-y-4">
      {notice && draftVisible && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {error && (!operation || draftVisible) && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {!order && !operation && !error && (
        <p role="status">Loading your order…</p>
      )}
      {reloadRequired && (
        <div className="space-y-3">
          {reloadBusy ? (
            <p role="status">Your edit was cancelled. Reloading your order…</p>
          ) : (
            <button
              type="button"
              className="csz-action"
              onClick={() => void reloadCancelledOrder()}
            >
              Retry order
            </button>
          )}
        </div>
      )}
      {order && (
        <div hidden={!draftVisible || reloadRequired}>
          <OrderDraft
            audience="customer"
            order={order}
            api={api.edits}
            enabled={enabled}
            staffId={actorKey}
            active={draftVisible && !reloadRequired}
            reviewBlocked={closingQuote || reloadRequired}
            closedOperationId={closedOperationId}
            discountCodes={discountCodes}
            onDiscountCodesChange={setDiscountCodes}
            codeMessages={codeMessages}
            renderRewards={
              order.codeEntryAvailable
                ? (props) => (
                    <ClubRewardsWidget
                      {...props}
                      api={api}
                      connectionId={connectionId}
                      omsOrderId={omsOrderId}
                      actorKey={actorKey}
                      onBusy={(value) => {
                        props.onBusy(value);
                        setRewardBusy(value);
                      }}
                    />
                  )
                : undefined
            }
            initialOperation={initialOperation}
            onLock={setLocked}
            onQuote={received}
            inline={{
              operation,
              now,
              busy,
              uncertain,
              onCommit: async () => {
                await progress("commit");
              },
              onResume: async () => {
                await progress("resume");
              },
              onChange: () => {
                if (operation) void releaseForEditing();
              },
              onAbandon: () => {
                void progress("abandon");
              },
              beforeBrowse: releaseForEditing,
            }}
          />
        </div>
      )}
      {closingQuote && draftVisible && !reloadRequired && (
        <p role="status">Updating your edit. Your selections are saved.</p>
      )}
      {closingQuote && draftVisible && error && (
        <button
          className="csz-action"
          disabled={busy}
          onClick={() => void progress("reconcile")}
        >
          Check edit status
        </button>
      )}
      {operation && !draftVisible && (
        <OrderEditOperationView
          audience="customer"
          operation={operation}
          now={now}
          busy={busy}
          busyAction={busyAction}
          isUncertain={uncertain}
          recoveringCommand={observingCommand}
          codeMessages={codeMessages}
          error={error ?? status.error}
          onCommit={() => void progress("commit")}
          onRefresh={() => {
            if (status.error || observingCommand) status.retry();
            else void progress("reconcile");
          }}
          statusReadBusy={status.reading}
          onPaymentOpen={rememberPaymentReturn}
          onAbandon={() => void progress("abandon")}
        />
      )}
      {operation &&
        ["completed", "recovered"].includes(operation.status) &&
        onDone && (
          <button type="button" className="csz-action" onClick={onDone}>
            Done
          </button>
        )}
    </div>
  );
}
