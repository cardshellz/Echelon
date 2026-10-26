import { useEffect, useRef, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DialogPortalContainerContext } from "@/components/ui/dialog";
import { CustomerWorkspace } from "@/pages/CustomerReturnCustomerPortal";
import { CustomerOrderEditor } from "./CustomerOrderEditor";
import {
  CustomerAccountOrderTotals,
  type CustomerOrderTotalsState,
} from "./CustomerAccountOrderTotals";
import { CustomerAccountOrderStatus } from "./CustomerAccountOrderStatus";
import { CustomerAccountOrderHistory } from "./CustomerAccountOrderHistory";
import { CustomerOrderPanelLoader } from "./CustomerOrderPanelLoader";
import type { OrderEditOrder } from "@shared/order-edits/order-edit.contract";
import {
  loadOrderEditPaymentReturn,
  orderEditPaymentReturnStorage,
} from "./order-edit-payment-return";
import {
  createCustomerAccountTransport,
  customerAccountPageConfigSchema,
  type CustomerAccountTransport,
} from "./customer-account.transport";
import {
  customerAccountAccessNotice,
  customerAccountSignInUrl,
  type CustomerAccountAccessNotice,
} from "./customer-account-access";
import type { CustomerReturnCustomerOrder } from "@shared/returns/customer-return-access.contract";
import type { CustomerReturnCustomerLabelStatus } from "@shared/returns/customer-return-customer.contract";
import "../index.css";
import "./storefront.css";

type Bootstrap = Awaited<ReturnType<CustomerAccountTransport["bootstrap"]>>;
type Choice = {
  kind: "edit" | "return" | "labels";
  omsOrderId: number;
  returnOperationId?: string;
  returnOrder?: CustomerReturnCustomerOrder;
  returnStatus?: CustomerReturnCustomerLabelStatus;
};
const message = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : "Your order could not be loaded. Please try again.";
function AccountModal({
  api,
  session,
  choice,
  onClose,
  customerId,
}: {
  api: CustomerAccountTransport;
  session: Bootstrap;
  choice: Choice;
  onClose: () => void;
  customerId: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [portalRoot, setPortalRoot] = useState<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const returnApi = useRef(api.returns(session.session.sessionKey!));
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (busy) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);
  return (
    <dialog
      ref={dialog}
      className={`csz-account-dialog${choice.kind === "edit" ? "" : " csz-return-dialog"}`}
      aria-labelledby={choice.kind === "edit" ? "csz-account-dialog-title" : undefined}
      aria-label={choice.kind === "edit" ? undefined : "Return items"}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="csz-account-ui" ref={setPortalRoot}>
        {choice.kind === "edit" && (
          <header className="csz-dialog-heading">
            <div>
              <h2 id="csz-account-dialog-title">
                Edit your order
              </h2>
              <p>
                Update your items, then apply your changes.
              </p>
            </div>
            <button
              type="button"
              className="csz-modal-close"
              aria-label="Close order tools"
              disabled={busy}
              onClick={onClose}
            >
              ×
            </button>
          </header>
        )}
        <div className={choice.kind === "edit" ? "csz-dialog-body" : "csz-return-dialog-body"}>
          {error && (
            <p
              role="alert"
              className="rounded-md border p-3 text-sm text-destructive"
            >
              {error}
            </p>
          )}
          <DialogPortalContainerContext.Provider
            value={portalRoot ?? undefined}
          >
            {choice.kind === "edit" ? (
              <CustomerOrderEditor
                api={api}
                connectionId={session.connection.connectionId}
                omsOrderId={choice.omsOrderId}
                actorKey={`customer:${session.session.sessionKey}`}
                enabled={session.connection.enabled}
                onBusy={setBusy}
                paymentOwner={customerId}
                returnOperationId={choice.returnOperationId}
                onDone={() => {
                  onClose();
                  window.location.reload();
                }}
              />
            ) : (
              (choice.returnOrder || choice.returnStatus) && (
                <CustomerWorkspace
                  embedded
                  onBusy={setBusy}
                  initialOrder={choice.returnOrder}
                  initialStatus={choice.returnStatus}
                  sessionKey={session.session.sessionKey!}
                  transport={returnApi.current}
                  downloadRequest={api.request}
                  onDenied={setError}
                  onSignedOut={onClose}
                />
              )
            )}
          </DialogPortalContainerContext.Provider>
        </div>
      </div>
    </dialog>
  );
}
function CustomerAccount({
  root,
  api,
  statusTarget,
  signInUrl,
  customerId,
}: {
  root: HTMLElement;
  api: CustomerAccountTransport;
  statusTarget: HTMLElement | null;
  signInUrl: string;
  customerId: string;
}) {
  const [session, setSession] = useState<Bootstrap | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [rows] = useState(() =>
    Array.from(root.querySelectorAll<HTMLElement>("[data-csz-account-order]")),
  );
  const accessSurface = root.querySelector("[data-csz-order-history-content]")
    ? "history"
    : "order";
  const [managed, setManaged] = useState<{
    row: HTMLElement;
    opener: HTMLButtonElement;
  } | null>(null);
  const [error, setError] = useState<CustomerAccountAccessNotice | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [totals, setTotals] = useState<
    ReadonlyMap<HTMLElement, CustomerOrderTotalsState>
  >(() => new Map(rows.map((row) => [row, { status: "loading" as const }])));
  const [statusFailures, setStatusFailures] = useState<
    ReadonlySet<HTMLElement>
  >(new Set());
  const [history, setHistory] = useState<Awaited<
    ReturnType<ReturnType<CustomerAccountTransport["returns"]>["history"]>
  > | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false },
        },
      }),
  );
  const requestGeneration = useRef(new Map<HTMLElement, number>());
  const accountRequests = useRef<AbortController | null>(null);

  const loadSummaries = useCallback(
    async (
      selected: HTMLElement[],
      signal = accountRequests.current?.signal,
    ) => {
      if (!selected.length) return;
      setError(null);
      setTotals((previous) => {
        const next = new Map(previous);
        for (const row of selected)
          if (previous.get(row)?.status !== "verified")
            next.set(row, { status: "loading" });
        return next;
      });
      const generations = new Map(
        selected.map((row) => {
          const generation = (requestGeneration.current.get(row) ?? 0) + 1;
          requestGeneration.current.set(row, generation);
          return [row, generation];
        }),
      );
      try {
        const result = await api.orderSummaries(
          {
            orders: selected.map((row) => ({
              externalOrderId: row.dataset.externalOrderId,
              orderReference: row.dataset.orderReference,
            })),
          },
          signal,
        );
        if (signal?.aborted) return;
        if (result.unavailableExternalOrderIds.length) {
          // Do not reveal a partially verified page or blank a previously
          // verified amount when a refresh cannot account for every row.
          throw new Error("The current order history could not be verified.");
        }
        const currentRows = selected.filter(
          (row) => requestGeneration.current.get(row) === generations.get(row),
        );
        if (!currentRows.length) return;
        setTotals((previous) => {
          const next = new Map(previous);
          for (const row of currentRows) {
            const order = result.orders.find(
              (item) => item.externalOrderId === row.dataset.externalOrderId,
            );
            next.set(
              row,
              order ? { status: "verified", order } : { status: "failed" },
            );
          }
          return next;
        });
        setStatusFailures((previous) => {
          const next = new Set(previous);
          for (const row of currentRows) {
            if (result.statusUnavailable) next.add(row);
            else next.delete(row);
          }
          return next;
        });
        setError(null);
      } catch (cause) {
        if (signal?.aborted) return;
        const currentRows = selected.filter(
          (row) => requestGeneration.current.get(row) === generations.get(row),
        );
        if (!currentRows.length) return;
        setTotals((previous) => {
          const next = new Map(previous);
          for (const row of currentRows) {
            if (
              requestGeneration.current.get(row) === generations.get(row) &&
              previous.get(row)?.status !== "verified"
            )
              next.set(row, { status: "failed" });
          }
          return next;
        });
        setError(customerAccountAccessNotice(cause, accessSurface));
      }
    },
    [api, accessSurface],
  );

  const verifiedOrder = useCallback(
    (row: HTMLElement, order: OrderEditOrder) => {
      // Prevent an earlier list request from replacing newer detailed native facts.
      requestGeneration.current.set(
        row,
        (requestGeneration.current.get(row) ?? 0) + 1,
      );
      setTotals((previous) =>
        new Map(previous).set(row, { status: "verified", order }),
      );
    },
    [],
  );
  const closePanel = useCallback(() => setManaged(null), []);
  const closeModal = () => {
    const omsOrderId = choice?.omsOrderId;
    setChoice(null);
    const row = rows.find((item) => {
      const state = totals.get(item);
      return (
        state?.status === "verified" && state.order.omsOrderId === omsOrderId
      );
    });
    if (row) void loadSummaries([row]);
  };

  useEffect(() => {
    const controller = new AbortController();
    accountRequests.current = controller;
    setError(null);
    setSession(null);
    setHistoryError(null);
    void api
      .bootstrap(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setSession(result);
        // One small native query covers this page, including purchases predating
        // OMS. Edit eligibility and return policy checks are demand-loaded.
        void loadSummaries(rows, controller.signal);
        const paymentStorage = orderEditPaymentReturnStorage();
        const paymentReturn =
          paymentStorage &&
          loadOrderEditPaymentReturn(
            customerId,
            result.connection.connectionId,
            paymentStorage,
            Date.now,
          );
        if (
          paymentReturn &&
          rows.some(
            (row) => row.dataset.orderReference === paymentReturn.orderNumber,
          )
        ) {
          setChoice(
            (current) =>
              current ?? {
                kind: "edit",
                omsOrderId: paymentReturn.omsOrderId,
                returnOperationId: paymentReturn.operationId,
              },
          );
        }
        void api
          .returns(result.session.sessionKey!)
          .history(null, controller.signal)
          .then((value) => {
            if (!controller.signal.aborted) {
              setHistory(value);
              setHistoryError(null);
            }
          })
          .catch((cause) => {
            if (!controller.signal.aborted) setHistoryError(message(cause));
          });
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(customerAccountAccessNotice(cause, accessSurface));
          setTotals(
            (previous) =>
              new Map(
                rows.map((row) => [
                  row,
                  previous.get(row)?.status === "verified"
                    ? previous.get(row)!
                    : { status: "failed" as const },
                ]),
              ),
          );
        }
      });
    return () => {
      controller.abort();
      client.clear();
    };
  }, [api, rows, attempt, client, customerId, loadSummaries, accessSurface]);

  async function showReturn(
    authorizationId: number,
    omsOrderId: number,
  ): Promise<boolean> {
    if (!session?.session.sessionKey) return false;
    try {
      const returnStatus = await api
        .returns(session.session.sessionKey)
        .status(authorizationId, new AbortController().signal);
      setChoice({ kind: "labels", omsOrderId, returnStatus });
      setManaged(null);
      return true;
    } catch (cause) {
      setHistoryError(message(cause));
      return false;
    }
  }
  const accessError = error && (
    <div className="csz-account-notice" role="alert">
      <span>{error.message}</span>
      {error.action === "sign_in" ? (
        <a className="csz-action" href={signInUrl}>
          Sign in again
        </a>
      ) : (
        <button
          type="button"
          className="csz-action"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Try again
        </button>
      )}
    </div>
  );
  return (
    <QueryClientProvider client={client}>
      <CustomerAccountOrderTotals root={root} states={totals} api={api} />
      <CustomerAccountOrderHistory
        root={root}
        states={totals}
        hasAccessError={error !== null}
        onRetry={() => void loadSummaries(rows)}
      />
      <CustomerAccountOrderStatus states={totals} />
      {rows.flatMap((row) => {
        const target = row.querySelector<HTMLElement>(
          "[data-csz-order-panel-trigger]",
        );
        return target
          ? [
              createPortal(
                <button
                  type="button"
                  className="csz-action csz-manage-order"
                  aria-haspopup="dialog"
                  aria-label={`Manage order ${row.dataset.orderReference}`}
                  aria-expanded={managed?.row === row}
                  aria-controls="csz-order-panel"
                  onClick={(event) =>
                    setManaged({ row, opener: event.currentTarget })
                  }
                >
                  Manage order
                </button>,
                target,
                `${row.dataset.externalOrderId}:manage`,
              ),
            ]
          : [];
      })}
      {accessError &&
        !managed &&
        (statusTarget ? createPortal(accessError, statusTarget) : accessError)}
      {managed && (
        <CustomerOrderPanelLoader
          key={managed.row.dataset.externalOrderId}
          row={managed.row}
          opener={managed.opener}
          summary={totals.get(managed.row)}
          statusUnavailable={statusFailures.has(managed.row)}
          api={api}
          customerId={customerId}
          connectionId={session?.connection.connectionId ?? null}
          enabled={session?.connection.enabled ?? false}
          sessionKey={session?.session.sessionKey ?? undefined}
          accessNotice={error}
          signInUrl={signInUrl}
          history={history}
          historyError={historyError}
          onClose={closePanel}
          onRefresh={() => {
            void loadSummaries([managed.row]);
          }}
          onAccessRetry={() => setAttempt((value) => value + 1)}
          onVerified={verifiedOrder}
          onEdit={(omsOrderId) => {
            setManaged(null);
            setChoice({ kind: "edit", omsOrderId });
          }}
          onReturn={(returnOrder) => {
            setManaged(null);
            setChoice({
              kind: "return",
              omsOrderId: returnOrder.omsOrderId,
              returnOrder,
            });
          }}
          onLabel={showReturn}
        />
      )}
      {choice && session && (
        <AccountModal
          key={`${choice.kind}:${choice.omsOrderId}:${choice.returnStatus?.authorizationId ?? "intake"}`}
          api={api}
          session={session}
          choice={choice}
          onClose={closeModal}
          customerId={customerId}
        />
      )}
      {session && (
        <section className="csz-account-returns" aria-label="Your returns">
          <h2>Your returns</h2>
          {historyError && <p role="status">{historyError}</p>}
          {history?.returns.length === 0 && (
            <p>You don’t have any returns yet.</p>
          )}
          {history?.returns.map((item) => (
            <button
              className="csz-action"
              type="button"
              key={item.authorizationId}
              onClick={() =>
                void showReturn(item.authorizationId, item.omsOrderId)
              }
            >
              {item.orderReference ? `Order ${item.orderReference} · ` : ""}
              {item.authorizationNumber} · View labels
            </button>
          ))}
          {history?.nextBeforeAuthorizationId && (
            <button
              className="csz-action"
              type="button"
              onClick={() => {
                void api
                  .returns(session.session.sessionKey!)
                  .history(
                    history.nextBeforeAuthorizationId,
                    new AbortController().signal,
                  )
                  .then((page) =>
                    setHistory((previous) => ({
                      ...page,
                      returns: [
                        ...(previous?.returns ?? []).filter(
                          (item) =>
                            !page.returns.some(
                              (next) =>
                                next.authorizationId === item.authorizationId,
                            ),
                        ),
                        ...page.returns,
                      ],
                    })),
                  )
                  .catch((cause) => setHistoryError(message(cause)));
              }}
            >
              More returns
            </button>
          )}
        </section>
      )}
    </QueryClientProvider>
  );
}
const root = document.querySelector<HTMLElement>("[data-csz-customer-account]");
const mount = document.getElementById("csz-customer-account-tools");
const configElement = document.getElementById("csz-customer-account-config");
if (root && mount && configElement) {
  const statusTarget = root.querySelector<HTMLElement>(
    "[data-csz-account-tools-status]",
  );
  try {
    const config = customerAccountPageConfigSchema.parse(
      JSON.parse(configElement.textContent ?? "null"),
    );
    const api = createCustomerAccountTransport(config);
    const signInUrl = customerAccountSignInUrl(
      config.loginPath,
      `${window.location.pathname}${window.location.search}`,
    );
    // The template supplies a loader before JavaScript runs. Transfer this
    // portal target to React without leaving a second server-rendered loader.
    root
      .querySelector<HTMLElement>("[data-csz-order-history-status]")
      ?.replaceChildren();
    createRoot(mount).render(
      <CustomerAccount
        root={root}
        api={api}
        statusTarget={statusTarget}
        signInUrl={signInUrl}
        customerId={config.customerId}
      />,
    );
  } catch {
    // React has not mounted when page configuration fails validation.
    root
      .querySelector<HTMLElement>("[data-csz-order-history-status]")
      ?.replaceChildren();
    const history = root.querySelector<HTMLElement>(
      "[data-csz-order-history-content]",
    );
    if (history) history.hidden = true;
    root
      .querySelectorAll<HTMLElement>(
        "[data-csz-order-total], [data-csz-order-financials]",
      )
      .forEach((target) => {
        target.textContent = history
          ? ""
          : "Order details could not be loaded.";
      });
    const notice = document.createElement("p");
    notice.setAttribute("role", "alert");
    notice.textContent = history
      ? "Your orders could not be loaded. Please refresh this page."
      : "Order options could not be loaded. Please refresh this page.";
    (statusTarget ?? mount).append(notice);
  }
}
