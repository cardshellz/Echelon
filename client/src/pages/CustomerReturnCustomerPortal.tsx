import { customerReturnWorkflowWorking, customerReturnWorkflowMessage, type CustomerReturnWorkflowStatus } from "@shared/returns/customer-return-workflow.contract";
import { CustomerReturnRequestError } from "@/lib/customer-return-customer";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CustomerReturnFlow } from "@/components/returns/CustomerReturnFlow";
import { CustomerReturnSurface } from "@/components/returns/CustomerReturnSurface";
import { PreviewError } from "@/components/returns/CustomerReturnPreviewSteps";
import { PreviewAccessError } from "@/lib/customer-return-preview";
import {
  createCustomerReturnTransport,
  CustomerReturnCommandSession,
  customerReturnCanLeave,
  downloadCustomerReturnLabel,
} from "@/lib/customer-return-customer";
import type { CustomerReturnFlowGateway } from "@/lib/customer-return-gateway";
import type { CustomerReturnCustomerOrder } from "@shared/returns/customer-return-access.contract";
import type { CustomerReturnCustomerLabelStatus } from "@shared/returns/customer-return-customer.contract";

const RETURN_OBSERVATION_INTERVAL_MS = 2_000;
const MAX_RETURN_OBSERVATION_FAILURES = 3;

type Session = Awaited<
  ReturnType<ReturnType<typeof createCustomerReturnTransport>["session"]>
>;
type History = Awaited<
  ReturnType<ReturnType<typeof createCustomerReturnTransport>["history"]>
>;
const message = (cause: unknown) =>
  cause instanceof Error && !(cause instanceof TypeError)
    ? cause.message
    : "We could not complete the request. Please try again.";

export default function CustomerReturnCustomerPortal() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const deny = useCallback((reason: string) => {
    setSession(null);
    setError(reason);
  }, []);
  const signedOut = useCallback(() => {
    setError(null);
    setSession((previous) => ({
      authenticated: false,
      privateTesting: previous?.privateTesting ?? true,
      sessionKey: null,
    }));
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setSession(null);
    void createCustomerReturnTransport()
      .session(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          if (result.authenticated && !result.sessionKey)
            throw new Error(
              "Your sign-in could not be verified. Sign in again.",
            );
          setSession(result);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(message(cause));
      });
    return () => controller.abort();
  }, [attempt]);
  return (
    <main
      className="min-h-screen bg-slate-50 px-4 py-6 sm:py-10"
      data-testid="customer-return-portal"
    >
      <title>Returns | Card Shellz</title>
      <div className="mx-auto max-w-3xl space-y-5">
        {session?.privateTesting && (
          <aside className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
            Private testing · Customer launch is not enabled.
          </aside>
        )}
        {session?.authenticated && session.sessionKey ? (
          <CustomerWorkspace
            key={session.sessionKey}
            sessionKey={session.sessionKey}
            onDenied={deny}
            onSignedOut={signedOut}
          />
        ) : (
          <CustomerReturnSurface>
            <div className="csz-return-status">
              <h1 className="text-2xl font-semibold">Return an order</h1>
              <PreviewError message={error} />
              {!session && !error ? (
                <Loading text="Checking your sign-in…" />
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    Sign in to your Card Shellz account to see orders available
                    for return and your existing returns.
                  </p>
                  <Button asChild className="min-h-12">
                    <a href="/customer-returns/start">Sign in to Card Shellz</a>
                  </Button>
                  {error && (
                    <Button
                      variant="outline"
                      className="ml-2"
                      onClick={() => setAttempt((value) => value + 1)}
                    >
                      Check sign-in again
                    </Button>
                  )}
                </>
              )}
            </div>
          </CustomerReturnSurface>
        )}
      </div>
    </main>
  );
}

export function CustomerWorkspace({
  sessionKey,
  onDenied,
  onSignedOut,
  transport,
  initialOrder,
  initialOrderId,
  initialStatus,
  downloadRequest = fetch,
  embedded = false,
  onBusy,
}: {
  sessionKey: string;
  onDenied: (message: string) => void;
  onSignedOut: () => void;
  transport?: ReturnType<typeof createCustomerReturnTransport>;
  initialOrder?: CustomerReturnCustomerOrder;
  initialOrderId?: number;
  initialStatus?: CustomerReturnCustomerLabelStatus;
  downloadRequest?: typeof fetch;
  embedded?: boolean;
  onBusy?: (busy: boolean) => void;
}) {
  const api = useMemo(
    () => transport ?? createCustomerReturnTransport(fetch, sessionKey),
    [sessionKey, transport],
  );
  const [commands] = useState(() => {
    let storage: Storage | null = null;
    try {
      storage = window.sessionStorage;
    } catch {
      /* Closed until a recovery key can be saved. */
    }
    return new CustomerReturnCommandSession(sessionKey, storage, api, onDenied);
  });
  const command = useSyncExternalStore(
    commands.subscribe,
    commands.getSnapshot,
  );
  const [orders, setOrders] = useState<CustomerReturnCustomerOrder[]>([]);
  const [nextOrder, setNextOrder] = useState<number | null>(null);
  const [unavailableOrders, setUnavailableOrders] = useState(0);
  const [history, setHistory] = useState<History>({
    returns: [],
    nextBeforeAuthorizationId: null,
  });
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CustomerReturnCustomerOrder | null>(
    null,
  );
  const [directOrderId, setDirectOrderId] = useState<number | null>(
    !initialStatus ? initialOrder?.omsOrderId ?? initialOrderId ?? null : null,
  );
  const [restoring, setRestoring] = useState(Boolean(!initialStatus && (initialOrder || initialOrderId)));
  const [historicalWorkflow, setHistoricalWorkflow] = useState<CustomerReturnWorkflowStatus | null>(null);
  const [observationAttempt, setObservationAttempt] = useState(0);
  const [historicalStatus, setHistoricalStatus] =
    useState<CustomerReturnCustomerLabelStatus | null>(initialStatus ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [flowBusy, setFlowBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const operation = useRef<AbortController | null>(null);
  const downloads = useRef(new Set<string>());
  const chooser = useRef<HTMLHeadingElement>(null);
  const statusHeading = useRef<HTMLHeadingElement>(null);
  const reviewAfterRetry = useRef(false);
  useEffect(() => {
    commands.activate();
    if (commands.getSnapshot().record) void commands.check();
    return () => commands.dispose();
  }, [commands]);
  useEffect(() => {
    if (!command.workflow || !customerReturnWorkflowWorking(command.workflow.phase)) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, failures = 0;
    const observe = async () => {
      const observed = await commands.check();
      if (stopped) return;
      failures = observed ? 0 : failures + 1;
      if (failures < MAX_RETURN_OBSERVATION_FAILURES) timer = setTimeout(() => { void observe(); }, RETURN_OBSERVATION_INTERVAL_MS);
    };
    timer = setTimeout(() => { void observe(); }, RETURN_OBSERVATION_INTERVAL_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }, [commands, command.workflow?.requestKey, command.workflow?.phase, observationAttempt]);
  useEffect(() => {
    if (!historicalStatus || command.record) return;
    const controller = new AbortController();
    void api.authorizationWorkflow(historicalStatus.authorizationId, controller.signal).then(value => {
      if (!controller.signal.aborted) setHistoricalWorkflow(value);
    }).catch(cause => {
      if (!controller.signal.aborted && !(cause instanceof CustomerReturnRequestError && cause.code === "RETURN_WORKFLOW_NOT_FOUND")) {
        if (cause instanceof PreviewAccessError) onDenied(cause.message);
        else setError(message(cause));
      }
    });
    return () => controller.abort();
  }, [api, historicalStatus?.authorizationId, command.record !== null, onDenied]);
  useEffect(() => {
    if (!historicalWorkflow || !customerReturnWorkflowWorking(historicalWorkflow.phase)) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, failures = 0;
    const controller = new AbortController();
    const observe = async () => {
      try {
        const next = await api.workflow(historicalWorkflow.requestKey, controller.signal);
        if (stopped) return;
        if (next.omsOrderId !== historicalWorkflow.omsOrderId || next.labels?.authorizationId !== historicalWorkflow.labels?.authorizationId)
          throw new Error("Your return details could not be verified. Contact us for help.");
        setHistoricalWorkflow(next); setHistoricalStatus(next.labels); setError(null); failures = 0;
      } catch (cause) {
        if (stopped) return;
        if (cause instanceof PreviewAccessError) { onDenied(cause.message); return; }
        setError(message(cause)); failures++;
      }
      if (!stopped && failures < MAX_RETURN_OBSERVATION_FAILURES) timer = setTimeout(() => { void observe(); }, RETURN_OBSERVATION_INTERVAL_MS);
    };
    timer = setTimeout(() => { void observe(); }, RETURN_OBSERVATION_INTERVAL_MS);
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [api, historicalWorkflow?.requestKey, historicalWorkflow?.phase, observationAttempt, onDenied]);
  useEffect(
    () => () => {
      const pending = operation.current;
      operation.current = null;
      pending?.abort();
      downloads.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );

  const run = useCallback(
    async (work: (signal: AbortSignal) => Promise<void>) => {
      operation.current?.abort();
      const controller = new AbortController();
      operation.current = controller;
      setBusy(true);
      setError(null);
      try {
        await work(controller.signal);
      } catch (cause) {
        if (!controller.signal.aborted) {
          if (cause instanceof PreviewAccessError) onDenied(cause.message);
          else setError(message(cause));
        }
      } finally {
        // A view transition can legitimately abort its own read after restoring
        // a durable request. Clear only this operation's busy state; an aborted
        // older read must not clear a newer operation or leave the UI frozen.
        if (operation.current === controller) {
          operation.current = null;
          setBusy(false);
        }
      }
    },
    [onDenied],
  );

  useEffect(() => {
    if (command.record || embedded || directOrderId !== null) return;
    void run(async (signal) => {
      const [page, prior] = await Promise.allSettled([
        api.orders(null, signal),
        api.history(null, signal),
      ]);
      if (signal.aborted) return;
      for (const result of [page, prior])
        if (
          result.status === "rejected" &&
          result.reason instanceof PreviewAccessError
        )
          throw result.reason;
      if (page.status === "fulfilled") {
        setOrders(page.value.orders);
        setNextOrder(page.value.nextBeforeOmsOrderId);
        setUnavailableOrders(page.value.unavailableOrderCount);
      } else {
        setOrders([]);
        setNextOrder(null);
        setUnavailableOrders(0);
        setError(message(page.reason));
      }
      if (prior.status === "fulfilled") {
        setHistory(prior.value);
        setHistoryError(null);
      } else {
        setHistory({ returns: [], nextBeforeAuthorizationId: null });
        setHistoryError(message(prior.reason));
      }
    });
    return () => operation.current?.abort();
  }, [api, run, attempt, command.record !== null, embedded, directOrderId]);

  useEffect(() => {
    if (directOrderId === null || command.record) { setRestoring(false); return; }
    let cancelled = false;
    setRestoring(true);
    void run(async signal => {
      if (await commands.restore(directOrderId, signal)) return;
      const order = attempt === 0 && initialOrder?.omsOrderId === directOrderId
        ? initialOrder : await api.order(directOrderId, signal);
      if (!signal.aborted) setSelected(order);
    }).finally(() => { if (!cancelled) setRestoring(false); });
    return () => { cancelled = true; operation.current?.abort(); };
  }, [api, run, commands, directOrderId, attempt, command.record !== null, initialOrder]);

  useEffect(() => {
    if (reviewAfterRetry.current && command.rejected && !command.busy) reviewRejectedReturn();
  }, [command.rejected, command.busy]);

  function reviewRejectedReturn(): void {
    const previous = commands.getSnapshot();
    if (!previous.record || !previous.rejected || previous.busy
      || previous.record.authorizationId !== null) return;
    reviewAfterRetry.current = false;
    const orderId = initialOrderId ?? initialOrder?.omsOrderId ?? previous.record.omsOrderId;
    // Only an authoritative, definitive rejection permits a new intent. Keep the
    // immutable server receipt; clear local recovery through its existing owner.
    commands.finish();
    if (commands.getSnapshot().record) return;
    operation.current?.abort();
    setSelected(null);
    setHistoricalStatus(null);
    setHistoricalWorkflow(null);
    setError(null);
    setNotice(null);
    setDirectOrderId(orderId);
    setAttempt(value => value + 1);
  }

  async function retryReturn(): Promise<void> {
    const saved = commands.getSnapshot();
    if (saved.busy || busy) return;
    setObservationAttempt(value => value + 1);
    if (saved.record) {
      reviewAfterRetry.current = saved.record.authorizationId === null;
      if (!saved.rejected) await commands.retry();
      // One action also handles an obsolete request discovered during resume.
      // Unknown/accepted outcomes retain their original recovery record.
      if (commands.getSnapshot().rejected) reviewRejectedReturn();
      return;
    }
    if (historicalStatus) {
      await run(async signal => {
        const next = historicalWorkflow
          ? await api.retryWorkflow(historicalWorkflow.requestKey, signal)
          : await api.queueExistingLabels(historicalStatus.authorizationId, signal);
        if (!signal.aborted) { setHistoricalWorkflow(next); setHistoricalStatus(next.labels); }
      });
    }
  }

  function chooseAnother(reason?: string) {
    if (embedded) { onSignedOut(); return; }
    operation.current?.abort();
    setBusy(false);
    setSelected(null);
    setDirectOrderId(null);
    setHistoricalStatus(null);
    setHistoricalWorkflow(null);
    setError(null);
    setNotice(reason ?? null);
    setAttempt((value) => value + 1);
    requestAnimationFrame(() => chooser.current?.focus());
  }
  const gateway = useMemo<CustomerReturnFlowGateway | null>(
    () =>
      selected
        ? {
            lookup: async (_reference, signal) =>
              (await api.order(selected.omsOrderId, signal)).order,
            review: async (input, signal) => {
              const { orderReference: _reference, ...body } = input;
              return api.review(selected.omsOrderId, body, signal);
            },
            ...(selected.settingsVersion !== null &&
            selected.order.sourceRevision !== null &&
            !command.storageBlocked
              ? {
                  labels: {
                    create: async (input) => {
                      const { orderReference: _reference, ...body } = input;
                      await commands.begin(selected.omsOrderId, {
                        ...body,
                        sourceRevision: body.sourceRevision!,
                        settingsVersion: selected.settingsVersion!,
                      });
                    },
                  },
                }
              : {}),
          }
        : null,
    [selected, api, commands, command.storageBlocked],
  );

  const status = command.record ? command.status : historicalStatus;
  const showStatus = command.record !== null || historicalStatus !== null;
  useEffect(() => {
    if (showStatus) statusHeading.current?.focus();
  }, [showStatus, status?.authorizationId]);
  const workflow = command.record ? command.workflow : historicalWorkflow;
  const workflowWorking = workflow !== null && customerReturnWorkflowWorking(workflow.phase);
  const requestBusy = busy || command.busy || flowBusy;
  const inProgress = requestBusy || (workflowWorking && !error && !command.error);
  const workflowError = workflow?.reason ? customerReturnWorkflowMessage(workflow.reason) : null;
  const canRetry = workflow ? !customerReturnWorkflowWorking(workflow.phase) && workflow.phase !== "ready"
    : !status || status.canProgress || status.parcels.some(parcel => parcel.status !== "ready" && parcel.status !== "failed");
  const labelPreparationText =
    (command.record?.input.parcels.length ?? status?.parcels.length ?? 1) > 1
      ? "Getting your return labels"
      : "Getting your return label";
  useLayoutEffect(() => {
    onBusy?.(busy || flowBusy);
    return () => onBusy?.(false);
  }, [busy, flowBusy, onBusy]);
  const signOut = embedded ? null : (
    <Button
      variant="ghost"
      disabled={requestBusy}
      onClick={() =>
        void run(async (signal) => {
          await api.logout(signal);
          if (!signal.aborted) onSignedOut();
        })
      }
    >
      Sign out
    </Button>
  );
  async function download(parcelId: number) {
    if (!status) return;
    await run(async (signal) => {
      const blob = await downloadCustomerReturnLabel(
        status,
        parcelId,
        sessionKey,
        signal,
        downloadRequest,
      );
      if (signal.aborted) return;
      const url = URL.createObjectURL(blob);
      downloads.current.add(url);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `return-${status.authorizationId}-box-${parcelId}.pdf`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        downloads.current.delete(url);
      }, 60_000);
    });
  }
  if (showStatus)
    return (
      <CustomerReturnSurface label="Your return" onClose={embedded ? onSignedOut : undefined} closeDisabled={busy || flowBusy}>
        <div className="csz-return-status">
          <h1 ref={statusHeading} tabIndex={-1} className="text-2xl font-semibold outline-none">
            {status
              ? `Return ${status.authorizationNumber}`
              : inProgress ? labelPreparationText : "We couldn’t finish your return"}
          </h1>
          <PreviewError message={error ?? command.error ?? workflowError ?? notice} />
          {!status && !inProgress && !error && !command.error && (
            <p className="text-sm text-muted-foreground">
              Your selections are saved. Try again to continue with your return.
            </p>
          )}
          {inProgress && <Loading text={`${labelPreparationText}…`} />}
          {status?.parcels.map((parcel) => (
            <section
              key={parcel.parcelId}
              className="space-y-3 rounded-xl border p-4"
            >
              <h2 className="font-semibold">Box {parcel.number}</h2>
              <p className="text-sm">
                {parcel.status === "ready"
                  ? "Ready to download."
                  : parcel.status === "pending"
                    ? workflowWorking ? "Getting this label." : "This label is not ready yet."
                    : parcel.status === "processing"
                      ? workflowWorking ? "Getting this label." : "We couldn’t confirm this label. Try again."
                      : parcel.status === "failed"
                        ? "This label could not be prepared. Contact us for help."
                      : "We couldn’t finish preparing this label. Try again, or contact us for help."}
              </p>
              {parcel.trackingNumber && (
                <p className="break-all text-sm">
                  Tracking: {parcel.trackingNumber}
                </p>
              )}
              {parcel.downloadPath && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void download(parcel.parcelId)}
                >
                  Download label for box {parcel.number}
                </Button>
              )}
            </section>
          ))}
          <div className="flex flex-wrap gap-3">
            {(canRetry || Boolean(error || command.error)) && !requestBusy && (
              <Button disabled={inProgress} onClick={() => void retryReturn()}>
                {inProgress ? "Please wait…" : "Try again"}
              </Button>
            )}
            {command.record &&
              customerReturnCanLeave(status) && (
                <Button
                  variant="ghost"
                  disabled={inProgress}
                  onClick={() => {
                    commands.finish();
                    if (!commands.getSnapshot().record) chooseAnother();
                  }}
                >
                  Back to your orders
                </Button>
              )}
            {!command.record && status && customerReturnCanLeave(status) && (
              <Button
                variant="ghost"
                disabled={inProgress}
                onClick={() => chooseAnother()}
              >
                Back to your orders
              </Button>
            )}
          </div>
          {workflow && <p className="break-all text-xs text-muted-foreground">Return reference: {workflow.requestKey}</p>}
          <p className="text-xs leading-relaxed text-muted-foreground">
            Use one label per box. Our team inspects returned items and reviews
            any refund. Creating a label does not issue a refund.
          </p>
          {signOut}
        </div>
      </CustomerReturnSurface>
    );

  if (selected && gateway && !restoring)
    return (
      <>
        {signOut && <div className="flex justify-end">{signOut}</div>}
        <CustomerReturnFlow
          key={`${selected.omsOrderId}:${selected.order.sourceRevision}`}
          initialOrderReference={selected.order.orderReference}
          initialOrder={selected.order}
          onChooseAnotherOrder={chooseAnother}
          gateway={gateway}
          onAccessDenied={onDenied}
          onClose={embedded ? onSignedOut : undefined}
          closeDisabled={busy || flowBusy}
          onBusy={setFlowBusy}
          notice={<>
            <PreviewError message={command.error} />
            {selected.settingsVersion === null && (
              <p role="status" className="rounded-lg border bg-white p-3 text-sm">
                Return labels are temporarily unavailable. You can review your
                items, or contact support for help.
              </p>
            )}
          </>}
        />
      </>
    );

  if (directOrderId !== null)
    return (
      <CustomerReturnSurface onClose={embedded ? onSignedOut : undefined} closeDisabled={busy || flowBusy}>
        <div className="csz-return-status">
          <h1 className="text-2xl font-semibold">Return items</h1>
          <PreviewError message={error} />
          {busy && <Loading text="Loading return items…" />}
          {error && !busy && (
            <Button variant="outline" onClick={() => setAttempt(value => value + 1)}>
              Try again
            </Button>
          )}
          <Button variant="ghost" disabled={inProgress} onClick={() => chooseAnother()}>
            Back to your orders
          </Button>
        </div>
      </CustomerReturnSurface>
    );

  return (
    <CustomerReturnSurface onClose={embedded ? onSignedOut : undefined} closeDisabled={busy || flowBusy}>
      <div className="csz-return-status">
        <h1
          ref={chooser}
          tabIndex={-1}
          className="text-2xl font-semibold outline-none"
        >
          Choose an order to return
        </h1>
        <PreviewError message={error ?? command.error ?? workflowError ?? notice} />
        {busy && <Loading text="Loading your orders…" />}
        {unavailableOrders > 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            Some orders could not be checked. Refresh or contact support.
          </p>
        )}
        {!busy && !error && !orders.length && unavailableOrders === 0 && (
          <p className="text-sm text-muted-foreground">
            No eligible orders were found on this page. Items must meet the return
            policy.
          </p>
        )}
        <div className="space-y-3">
          {orders.map((item) => (
            <div
              key={item.omsOrderId}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
            >
              <div>
                <h2 className="font-semibold">
                  Order #{item.order.orderReference.replace(/^#\s*/, "")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {new Date(item.order.purchasedAt).toLocaleDateString()} ·{" "}
                  {item.order.lines.reduce(
                    (sum, line) => sum + line.eligibleQuantity,
                    0,
                  )}{" "}
                  items available
                </p>
              </div>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async (signal) => {
                    if (await commands.restore(item.omsOrderId, signal)) return;
                    const detail = await api.order(item.omsOrderId, signal);
                    if (!signal.aborted) { setNotice(null); setSelected(detail); }
                  })
                }
              >
                Return items
              </Button>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-3">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Refresh orders
          </Button>
          {nextOrder !== null && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async (signal) => {
                  const page = await api.orders(nextOrder, signal);
                  if (!signal.aborted) {
                    setOrders((previous) => [
                      ...previous.filter(
                        (item) =>
                          !page.orders.some(
                            (next) => next.omsOrderId === item.omsOrderId,
                          ),
                      ),
                      ...page.orders,
                    ]);
                    setNextOrder(page.nextBeforeOmsOrderId);
                    setUnavailableOrders(
                      (previous) => previous + page.unavailableOrderCount,
                    );
                  }
                })
              }
            >
              More orders
            </Button>
          )}
        </div>
        <section
          className="space-y-3 border-t pt-5"
          aria-label="Existing returns"
        >
          <h2 className="text-lg font-semibold">Your returns</h2>
          <PreviewError message={historyError} />
          {!history.returns.length && !historyError && (
            <p className="text-sm text-muted-foreground">
              Your saved returns will appear here.
            </p>
          )}
          {history.returns.map((item) => (
            <Button
              key={item.authorizationId}
              variant="outline"
              className="mr-2 min-h-11"
              disabled={busy}
              onClick={() =>
                void run(async (signal) => {
                  const result = await api.status(item.authorizationId, signal);
                  if (!signal.aborted) setHistoricalStatus(result);
                })
              }
            >
              {item.authorizationNumber}
              {item.orderReference ? ` · Order ${item.orderReference}` : ""}
            </Button>
          ))}
          {history.nextBeforeAuthorizationId !== null && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void run(async (signal) => {
                  const page = await api.history(
                    history.nextBeforeAuthorizationId,
                    signal,
                  );
                  if (!signal.aborted)
                    setHistory((previous) => ({
                      ...page,
                      returns: [
                        ...previous.returns.filter(
                          (item) =>
                            !page.returns.some(
                              (next) =>
                                next.authorizationId === item.authorizationId,
                            ),
                        ),
                        ...page.returns,
                      ],
                    }));
                })
              }
            >
              More returns
            </Button>
          )}
        </section>
        {signOut}
      </div>
    </CustomerReturnSurface>
  );
}
function Loading({ text }: { text: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-sm">
      <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
      {text}
    </p>
  );
}
