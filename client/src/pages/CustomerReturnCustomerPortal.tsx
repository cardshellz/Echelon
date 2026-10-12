import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Loader2, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CustomerReturnFlow } from "@/components/returns/CustomerReturnFlow";
import { PreviewError } from "@/components/returns/CustomerReturnPreviewSteps";
import { PreviewAccessError } from "@/lib/customer-return-preview";
import {
  createCustomerReturnTransport,
  CustomerReturnCommandSession,
  customerReturnCanLeave,
  downloadCustomerReturnLabel,
} from "@/lib/customer-return-customer";
import type { CustomerReturnFlowGateway } from "@/lib/customer-return-gateway";
import type {
  CustomerReturnCustomerOrder,
  CustomerReturnCustomerProfile,
} from "@shared/returns/customer-return-access.contract";
import type { CustomerReturnCustomerLabelStatus } from "@shared/returns/customer-return-customer.contract";

type Session = Awaited<
  ReturnType<ReturnType<typeof createCustomerReturnTransport>["session"]>
>;
type History = Awaited<
  ReturnType<ReturnType<typeof createCustomerReturnTransport>["history"]>
>;
// Small server pages arrive progressively; bound each browse action so a long
// order history cannot create an unbounded chain of provider inspections.
const ORDER_PAGES_PER_LOAD = 5;
const message = (cause: unknown) =>
  cause instanceof Error
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
          <section className="space-y-5 rounded-2xl border bg-white p-6 shadow-sm">
            <Brand />
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
          </section>
        )}
      </div>
    </main>
  );
}

function CustomerWorkspace({
  sessionKey,
  onDenied,
  onSignedOut,
}: {
  sessionKey: string;
  onDenied: (message: string) => void;
  onSignedOut: () => void;
}) {
  const api = useMemo(
    () => createCustomerReturnTransport(fetch, sessionKey),
    [sessionKey],
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
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [nextOrder, setNextOrder] = useState<number | null>(null);
  const [unavailableOrders, setUnavailableOrders] = useState(0);
  const [profile, setProfile] = useState<CustomerReturnCustomerProfile | null>(
    null,
  );
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileAttempt, setProfileAttempt] = useState(0);
  const [history, setHistory] = useState<History>({
    returns: [],
    nextBeforeAuthorizationId: null,
  });
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [selected, setSelected] = useState<CustomerReturnCustomerOrder | null>(
    null,
  );
  const [historicalStatus, setHistoricalStatus] =
    useState<CustomerReturnCustomerLabelStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const operation = useRef<AbortController | null>(null);
  const orderRead = useRef<AbortController | null>(null);
  const historyRead = useRef<AbortController | null>(null);
  const downloads = useRef(new Set<string>());
  const chooser = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    commands.activate();
    if (commands.getSnapshot().record) void commands.check();
    return () => commands.dispose();
  }, [commands]);
  useEffect(
    () => () => {
      operation.current?.abort();
      orderRead.current?.abort();
      historyRead.current?.abort();
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
        if (!controller.signal.aborted) setBusy(false);
      }
    },
    [onDenied],
  );

  // This workspace is keyed by the verified session. Profile reads never hold
  // up orders, and an old account's response cannot populate a new workspace.
  useEffect(() => {
    const controller = new AbortController();
    setProfile(null);
    setProfileLoading(true);
    void api
      .profile(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setProfile(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted && cause instanceof PreviewAccessError)
          onDenied(cause.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setProfileLoading(false);
      });
    return () => controller.abort();
  }, [api, onDenied, profileAttempt]);

  const loadOrders = useCallback(
    async (before: number | null) => {
      orderRead.current?.abort();
      const controller = new AbortController();
      orderRead.current = controller;
      setOrdersLoading(true);
      setOrdersError(null);
      if (before === null) {
        setOrders([]);
        setNextOrder(null);
        setUnavailableOrders(0);
      }
      try {
        let cursor = before;
        for (
          let pageIndex = 0;
          pageIndex < ORDER_PAGES_PER_LOAD;
          pageIndex += 1
        ) {
          const page = await api.orders(cursor, controller.signal);
          if (controller.signal.aborted) return;
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
          if (page.nextBeforeOmsOrderId === null) break;
          // The transport rejects a non-decreasing cursor before any page is
          // displayed. Each subsequent request retains the same session header.
          cursor = page.nextBeforeOmsOrderId;
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          if (cause instanceof PreviewAccessError) onDenied(cause.message);
          else setOrdersError(message(cause));
        }
      } finally {
        if (!controller.signal.aborted) setOrdersLoading(false);
      }
    },
    [api, onDenied],
  );

  const loadHistory = useCallback(
    async (before: number | null) => {
      historyRead.current?.abort();
      const controller = new AbortController();
      historyRead.current = controller;
      setHistoryLoading(true);
      setHistoryError(null);
      if (before === null)
        setHistory({ returns: [], nextBeforeAuthorizationId: null });
      try {
        const page = await api.history(before, controller.signal);
        if (controller.signal.aborted) return;
        setHistory((previous) => ({
          ...page,
          returns:
            before === null
              ? page.returns
              : [
                  ...previous.returns.filter(
                    (item) =>
                      !page.returns.some(
                        (next) => next.authorizationId === item.authorizationId,
                      ),
                  ),
                  ...page.returns,
                ],
        }));
      } catch (cause) {
        if (!controller.signal.aborted) {
          if (cause instanceof PreviewAccessError) onDenied(cause.message);
          else setHistoryError(message(cause));
        }
      } finally {
        if (!controller.signal.aborted) setHistoryLoading(false);
      }
    },
    [api, onDenied],
  );

  useEffect(() => {
    if (command.record) return;
    void loadOrders(null);
    return () => orderRead.current?.abort();
  }, [loadOrders, attempt, command.record !== null]);

  useEffect(() => {
    if (command.record) return;
    void loadHistory(null);
    return () => historyRead.current?.abort();
  }, [loadHistory, attempt, command.record !== null]);

  function stopOrderRead() {
    orderRead.current?.abort();
    setOrdersLoading(false);
  }

  function chooseAnother(reason?: string) {
    operation.current?.abort();
    setBusy(false);
    setSelected(null);
    setHistoricalStatus(null);
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
  const inProgress = busy || command.busy;
  const signOut = (
    <Button
      variant="ghost"
      disabled={inProgress}
      onClick={() => {
        stopOrderRead();
        void run(async (signal) => {
          await api.logout(signal);
          if (!signal.aborted) onSignedOut();
        });
      }}
    >
      Sign out
    </Button>
  );
  const accountHeader = (
    <section
      aria-label="Signed-in customer"
      className="flex items-start justify-between gap-3 rounded-xl border bg-white px-4 py-3 text-sm"
    >
      <div className="min-w-0 self-center">
        {profileLoading ? (
          <Loading text="Loading account details…" />
        ) : profile?.name || profile?.email ? (
          <>
            <p className="text-xs text-muted-foreground">Signed in as</p>
            <p className="font-medium [overflow-wrap:anywhere]">
              {profile.name ?? profile.email}
            </p>
            {profile.name && profile.email && (
              <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {profile.email}
              </p>
            )}
          </>
        ) : (
          <>
            <p>Signed in to Card Shellz</p>
            <p className="text-xs text-muted-foreground">
              Account details are unavailable.
            </p>
            <Button
              variant="link"
              className="h-auto px-0 py-1 text-xs"
              onClick={() => setProfileAttempt((value) => value + 1)}
            >
              Retry account details
            </Button>
          </>
        )}
      </div>
      <div className="shrink-0">{signOut}</div>
    </section>
  );
  async function download(parcelId: number) {
    if (!status) return;
    await run(async (signal) => {
      const blob = await downloadCustomerReturnLabel(
        status,
        parcelId,
        sessionKey,
        signal,
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
      <>
        {accountHeader}
        <section
          className="space-y-5 rounded-2xl border bg-white p-6 shadow-sm"
          aria-label="Your return"
        >
          <Brand />
          <h1 className="text-2xl font-semibold">
            {status
              ? `Return ${status.authorizationNumber}`
              : command.rejected
                ? "Return not accepted"
                : "Checking your return"}
          </h1>
          <PreviewError message={error ?? command.error ?? notice} />
          {!status && !command.rejected && (
            <p className="text-sm text-muted-foreground">
              Your request is saved. Check its status or retry this same request
              before starting another return.
            </p>
          )}
          {inProgress && <Loading text="Checking your return…" />}
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
                    ? "Your label is waiting to be prepared."
                    : parcel.status === "processing"
                      ? "We are checking whether this label was created."
                      : "This label needs verification. Contact support if checking its status does not resolve it."}
              </p>
              {parcel.trackingNumber && (
                <p className="break-all text-sm">
                  Tracking: {parcel.trackingNumber}
                </p>
              )}
              {parcel.downloadPath && (
                <Button
                  variant="outline"
                  disabled={inProgress}
                  onClick={() => void download(parcel.parcelId)}
                >
                  Download label for box {parcel.number}
                </Button>
              )}
            </section>
          ))}
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              disabled={inProgress}
              onClick={() => {
                if (command.record) void commands.check();
                else if (status)
                  void run(async (signal) => {
                    const result = await api.status(
                      status.authorizationId,
                      signal,
                    );
                    if (!signal.aborted) setHistoricalStatus(result);
                  });
              }}
            >
              Check status
            </Button>
            {command.record && !status && !command.rejected && (
              <Button
                disabled={inProgress}
                onClick={() => void commands.retry()}
              >
                Retry saved request
              </Button>
            )}
            {status?.canProgress && (
              <Button
                disabled={inProgress}
                onClick={() => {
                  if (command.record) void commands.progress();
                  else
                    void run(async (signal) => {
                      const result = await api.progress(
                        status.authorizationId,
                        signal,
                      );
                      if (!signal.aborted) setHistoricalStatus(result);
                    });
                }}
              >
                Prepare or recover labels
              </Button>
            )}
            {command.record &&
              (command.rejected || customerReturnCanLeave(status)) && (
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
            {!command.record && (
              <Button
                variant="ghost"
                disabled={inProgress}
                onClick={() => chooseAnother()}
              >
                Back to your orders
              </Button>
            )}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Use one label per box. Our team inspects returned items and reviews
            any refund. Creating a label does not issue a refund.
          </p>
        </section>
      </>
    );

  if (selected && gateway)
    return (
      <>
        {accountHeader}
        <PreviewError message={command.error} />
        {selected.settingsVersion === null && (
          <p role="status" className="rounded-lg border bg-white p-3 text-sm">
            Return labels are temporarily unavailable. You can review your
            items, or contact support for help.
          </p>
        )}
        <CustomerReturnFlow
          key={`${selected.omsOrderId}:${selected.order.sourceRevision}`}
          initialOrderReference={selected.order.orderReference}
          initialOrder={selected.order}
          onChooseAnotherOrder={chooseAnother}
          gateway={gateway}
          onAccessDenied={onDenied}
        />
      </>
    );

  return (
    <>
      {accountHeader}
      <section className="space-y-6 rounded-2xl border bg-white p-6 shadow-sm">
        <Brand />
        <h1
          ref={chooser}
          tabIndex={-1}
          className="text-2xl font-semibold outline-none"
        >
          Choose an order to return
        </h1>
        <PreviewError
          message={error ?? ordersError ?? command.error ?? notice}
        />
        {ordersLoading && (
          <Loading
            text={
              orders.length ? "Checking more orders…" : "Loading your orders…"
            }
          />
        )}
        {unavailableOrders > 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            Some orders could not be checked. Refresh or contact support.
          </p>
        )}
        {!ordersLoading &&
          !ordersError &&
          !orders.length &&
          unavailableOrders === 0 && (
            <p className="text-sm text-muted-foreground">
              No eligible orders were found on this page. Items must meet the
              return policy and have confirmed delivery.
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
                onClick={() => {
                  stopOrderRead();
                  void run(async (signal) => {
                    const detail = await api.order(item.omsOrderId, signal);
                    if (!signal.aborted) {
                      setNotice(null);
                      setSelected(detail);
                    }
                  });
                }}
              >
                Return items
              </Button>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-3">
          <Button
            variant="outline"
            disabled={busy || ordersLoading}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Refresh orders
          </Button>
          {nextOrder !== null && (
            <Button
              variant="outline"
              disabled={busy || ordersLoading}
              onClick={() => void loadOrders(nextOrder)}
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
          {historyLoading && <Loading text="Loading your returns…" />}
          {!historyLoading && !history.returns.length && !historyError && (
            <p className="text-sm text-muted-foreground">
              Your saved returns will appear here.
            </p>
          )}
          {historyError && (
            <Button
              variant="outline"
              disabled={historyLoading}
              onClick={() => void loadHistory(null)}
            >
              Retry loading returns
            </Button>
          )}
          {history.returns.map((item) => (
            <Button
              key={item.authorizationId}
              variant="outline"
              className="mr-2 min-h-11"
              disabled={busy}
              onClick={() => {
                stopOrderRead();
                void run(async (signal) => {
                  const result = await api.status(item.authorizationId, signal);
                  if (!signal.aborted) setHistoricalStatus(result);
                });
              }}
            >
              {item.authorizationNumber}
              {item.orderReference ? ` · Order ${item.orderReference}` : ""}
            </Button>
          ))}
          {history.nextBeforeAuthorizationId !== null && (
            <Button
              variant="ghost"
              disabled={busy || historyLoading}
              onClick={() =>
                void loadHistory(history.nextBeforeAuthorizationId)
              }
            >
              More returns
            </Button>
          )}
        </section>
      </section>
    </>
  );
}
function Brand() {
  return (
    <div className="flex items-center gap-2 font-bold tracking-tight">
      <Package aria-hidden="true" className="h-6 w-6 text-blue-600" />
      CARD SHELLZ{" "}
      <span className="border-l pl-2 text-sm font-normal text-muted-foreground">
        Returns
      </span>
    </div>
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
