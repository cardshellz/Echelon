import { useEffect, useRef, useState } from "react";
import { OrderDraft, OrderEditOperationView } from "@/pages/OrderEdits";
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
import { orderEditNeedsPreparation } from "@/lib/order-edit-confirmation";
import { ClubRewardsWidget } from "./ClubRewardsWidget";

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
}: {
  api: CustomerAccountTransport;
  connectionId: number;
  omsOrderId: number;
  actorKey: string;
  enabled: boolean;
  onBusy: (busy: boolean) => void;
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
  const [draftVisible, setDraftVisible] = useState(true);
  const [closingQuote, setClosingQuote] = useState(false);
  const [closedOperationId, setClosedOperationId] = useState<string>();
  const [now, setNow] = useState(Date.now);
  const inFlight = useRef(false);
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
        if (current.activeOperationId) {
          const active = await api.edits.operation(
            current.activeOperationId,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          setInitialOperation(active);
          setOperation(active);
          setDiscountCodes(active.requestedPlan?.discountCodes ?? []);
          setDraftVisible(active.canAbandon && Boolean(active.requestedPlan));
          // Mount the draft only once its saved plan is available; mounting it
          // earlier would initialize quantities from the unchanged order.
          setOrder(current);
          if (orderEditNeedsPreparation(active, Date.now()))
            await progress("resume", active);
        } else setOrder(current);
      } catch (cause) {
        if (!controller.signal.aborted) setError(message(cause));
      }
    })();
    return () => controller.abort();
  }, [api, connectionId, omsOrderId, actorKey]);

  async function received(
    result: OrderEditOperation,
    confirmDisplayedAmount = false,
  ) {
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
    setDraftVisible(result.canAbandon);
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
    inFlight.current = true;
    setBusy(true);
    setBusyAction(action === "resume" ? "reconcile" : action);
    setError(null);
    setNotice(action === "resume" ? "Recalculating your saved changes…" : null);
    if (action === "abandon") {
      setClosingQuote(true);
      // Show the retained draft immediately; another review waits for release.
      if (order) setDraftVisible(true);
    }
    try {
      const result = await api.edits[action](target.operationId);
      setOperation(result);
      setUncertain(false);
      if ((action === "abandon" || closingQuote) && closed.has(result.status)) {
        setClosedOperationId(result.operationId);
        setOperation(null);
        setClosingQuote(false);
        setDraftVisible(true);
        // Cancellation is confirmed. A failed read must not restore this edit
        // or permit a new review against stale eligibility/revision evidence.
        setBusy(false);
        return Boolean(await reloadCancelledOrder());
      } else if (action === "abandon" || closingQuote) {
        setDraftVisible(false);
        setClosingQuote(false);
      } else
        setDraftVisible(result.canAbandon && Boolean(result.requestedPlan));
    } catch (cause) {
      setError(message(cause));
      setUncertain(cause instanceof OrderEditRequestError && cause.uncertain);
      // Only a genuinely uncertain command needs status reconciliation. A known
      // failed preparation remains inline with its original selections.
      if (cause instanceof OrderEditRequestError && cause.uncertain)
        setDraftVisible(false);
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
            renderRewards={order.codeEntryAvailable ? (props) => <ClubRewardsWidget {...props}
              api={api} connectionId={connectionId} omsOrderId={omsOrderId} actorKey={actorKey}
              onBusy={(value) => { props.onBusy(value); setRewardBusy(value); }} /> : undefined}
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
          error={error}
          onCommit={() => void progress("commit")}
          onRefresh={() => void progress("reconcile")}
          onAbandon={() => void progress("abandon")}
        />
      )}
    </div>
  );
}
