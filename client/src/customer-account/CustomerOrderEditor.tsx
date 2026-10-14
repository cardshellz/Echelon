import { useEffect, useRef, useState } from "react";
import { OrderDraft, OrderEditOperationView } from "@/pages/OrderEdits";
import {
  loadPendingOrderEditQuote,
  savePendingOrderEditQuote,
  clearPendingOrderEditQuote,
  OrderEditRequestError,
} from "@/lib/order-edits";
import { orderEditPreviewInputSchema } from "@shared/order-edits/order-edit-preview";
import { orderEditQuoteInputSchema } from "@shared/order-edits/order-edit.contract";
import type {
  OrderEditOrder,
  OrderEditOperation,
  OrderEditQuoteInput,
} from "@shared/order-edits/order-edit.contract";
import type { CustomerAccountTransport } from "./customer-account.transport";

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
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [draftVisible, setDraftVisible] = useState(true);
  const [closingQuote, setClosingQuote] = useState(false);
  const [closedOperationId, setClosedOperationId] = useState<string>();
  const [now, setNow] = useState(Date.now);
  const inFlight = useRef(false);
  useEffect(() => {
    onBusy(busy || locked);
    return () => onBusy(false);
  }, [busy, locked, onBusy]);
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
          setDraftVisible(false);
        }
        setOrder(current);
      } catch (cause) {
        if (!controller.signal.aborted) setError(message(cause));
      }
    })();
    return () => controller.abort();
  }, [api, connectionId, omsOrderId, actorKey]);

  function received(result: OrderEditOperation) {
    if (result.requestedPlan?.discountCodes !== undefined)
      setDiscountCodes(result.requestedPlan.discountCodes);
    setOperation(result);
    setDraftVisible(false);
    setLocked(false);
    setUncertain(false);
    setError(null);
    try {
      clearPendingOrderEditQuote(actorKey, sessionStorage);
      setPendingQuote(null);
    } catch {
      setError(
        "Your edit is saved, but this browser could not clear its request reference. Keep this page open and contact us if you need help.",
      );
    }
  }
  async function reviseCodes(codes: string[]) {
    if (
      !operation ||
      operation.status !== "ready" ||
      !operation.canAbandon ||
      !operation.requestedPlan ||
      inFlight.current
    )
      return;
    const previous = operation;
    const plan = operation.requestedPlan;
    let phase: "validating" | "closing" | "quoting" = "validating";
    let reviewClosed = false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const candidate = {
        connectionId,
        omsOrderId,
        expectedRevision: previous.expectedRevision ?? order?.revision,
        changes: plan.changes,
        additions: plan.additions,
        discountCodes: codes,
      };
      const hasChanges =
        candidate.changes.length + candidate.additions.length + codes.length >
        0;
      // Validate while retaining the current review. An invalid code must not discard an accepted cart.
      if (hasChanges)
        await api.edits.preview(
          orderEditPreviewInputSchema.parse({
            ...candidate,
            operationId: previous.operationId,
          }),
        );
      phase = "closing";
      const released = await api.edits.abandon(previous.operationId);
      if (!closed.has(released.status)) {
        setOperation(released);
        throw new Error(
          "The previous review is still closing. Check its status before changing the code.",
        );
      }
      reviewClosed = true;
      setClosedOperationId(released.operationId);
      const current = await api.edits.order(connectionId, omsOrderId);
      setOrder(current);
      if (!hasChanges) {
        setDiscountCodes([]);
        setOperation(null);
        setDraftVisible(true);
        return;
      }
      setDiscountCodes(codes);
      const command = orderEditQuoteInputSchema.parse({
        ...candidate,
        expectedRevision: current.revision,
        requestKey: crypto.randomUUID(),
      });
      savePendingOrderEditQuote(actorKey, command, sessionStorage);
      setPendingQuote(command);
      phase = "quoting";
      received(await api.edits.quote(command));
    } catch (cause) {
      if (phase !== "validating") {
        setError(message(cause));
        setUncertain(cause instanceof OrderEditRequestError && cause.uncertain);
        if (reviewClosed) {
          setOperation(null);
          setDraftVisible(true);
        }
      }
      if (!(cause instanceof OrderEditRequestError && cause.uncertain)) {
        clearPendingOrderEditQuote(actorKey, sessionStorage);
        setPendingQuote(null);
      }
      throw cause;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
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
        received(hydrated);
      } else received(result);
    } catch (cause) {
      setError(message(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function progress(action: "commit" | "reconcile" | "abandon") {
    if (!operation || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    if (action === "abandon" && operation.status === "ready" && order) {
      // Show the retained draft immediately; another review waits for release.
      setDraftVisible(true);
      setClosingQuote(true);
    }
    try {
      const result = await api.edits[action](operation.operationId);
      setOperation(result);
      setUncertain(false);
      if (action === "abandon" && closed.has(result.status)) {
        setClosedOperationId(result.operationId);
        setOperation(null);
        setClosingQuote(false);
        setDraftVisible(true);
        const current = await api.edits.order(connectionId, omsOrderId);
        setOrder(current);
      } else if (closingQuote && closed.has(result.status)) {
        setClosedOperationId(result.operationId);
        setOperation(null);
        setClosingQuote(false);
      } else if (closingQuote && !closed.has(result.status)) {
        setDraftVisible(false);
        setClosingQuote(false);
      }
    } catch (cause) {
      setError(message(cause));
      setUncertain(cause instanceof OrderEditRequestError && cause.uncertain);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
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
      {order && (
        <div hidden={!draftVisible}>
          <OrderDraft
            audience="customer"
            order={order}
            api={api.edits}
            enabled={enabled}
            staffId={actorKey}
            active={draftVisible}
            reviewBlocked={closingQuote}
            closedOperationId={closedOperationId}
            discountCodes={discountCodes}
            onDiscountCodesChange={setDiscountCodes}
            initialOperation={initialOperation}
            onLock={setLocked}
            onQuote={received}
          />
        </div>
      )}
      {closingQuote && (
        <p role="status">
          Closing the previous review. You can change items now; another review
          will be available when this finishes.
        </p>
      )}
      {closingQuote && error && (
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
          isUncertain={uncertain}
          error={error}
          onCommit={() => void progress("commit")}
          onCodesChange={reviseCodes}
          onRefresh={() => void progress("reconcile")}
          onAbandon={() => void progress("abandon")}
        />
      )}
    </div>
  );
}
