import { useEffect, useRef, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DialogPortalContainerContext } from "@/components/ui/dialog";
import { CustomerWorkspace } from "@/pages/CustomerReturnCustomerPortal";
import { CustomerOrderEditor } from "./CustomerOrderEditor";
import { createCustomerAccountTransport, customerAccountPageConfigSchema, type CustomerAccountTransport } from "./customer-account.transport";
import type { CustomerReturnCustomerOrder } from "@shared/returns/customer-return-access.contract";
import type { CustomerReturnCustomerLabelStatus } from "@shared/returns/customer-return-customer.contract";
import "../index.css";
import "./storefront.css";

type Bootstrap = Awaited<ReturnType<CustomerAccountTransport["bootstrap"]>>;
type Choice = { kind: "edit" | "return" | "labels"; omsOrderId: number; returnOrder?: CustomerReturnCustomerOrder; returnStatus?: CustomerReturnCustomerLabelStatus };
const message = (cause: unknown) => cause instanceof Error ? cause.message : "Account tools are temporarily unavailable. Please try again.";
function AccountModal({ api, session, choice, onClose }: {
  api: CustomerAccountTransport; session: Bootstrap; choice: Choice; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [portalRoot, setPortalRoot] = useState<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const returnApi = useRef(api.returns(session.session.sessionKey!));
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (busy) { event.preventDefault(); } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);
  return <dialog ref={dialog} className="csz-account-dialog" aria-labelledby="csz-account-dialog-title"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="csz-account-ui" ref={setPortalRoot}>
      <header className="csz-dialog-heading">
        <div><h2 id="csz-account-dialog-title">{choice.kind === "edit" ? "Edit your order" : "Return items"}</h2>
          <p>{choice.kind === "edit" ? "Update quantities or add a product, then review the new total." : "Choose the items and quantities you want to send back."}</p></div>
        <button type="button" className="csz-modal-close" aria-label="Close order tools" disabled={busy} onClick={onClose}>×</button>
      </header>
      <div className="csz-dialog-body">
      {error && <p role="alert" className="rounded-md border p-3 text-sm text-destructive">{error}</p>}
      <DialogPortalContainerContext.Provider value={portalRoot ?? undefined}>
        {choice.kind === "edit" ? <CustomerOrderEditor api={api} connectionId={session.connection.connectionId} omsOrderId={choice.omsOrderId}
          actorKey={`customer:${session.session.sessionKey}`} enabled={session.connection.enabled} onBusy={setBusy} />
          : (choice.returnOrder || choice.returnStatus) && <CustomerWorkspace embedded initialOrder={choice.returnOrder} initialStatus={choice.returnStatus} sessionKey={session.session.sessionKey!}
            transport={returnApi.current} downloadRequest={api.request} onDenied={setError} onSignedOut={onClose} />}
      </DialogPortalContainerContext.Provider>
      </div>
    </div>
  </dialog>;
}
function CustomerAccount({ root, api, statusTarget }: { root: HTMLElement; api: CustomerAccountTransport; statusTarget: HTMLElement | null }) {
  const [session, setSession] = useState<Bootstrap | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [history, setHistory] = useState<Awaited<ReturnType<ReturnType<CustomerAccountTransport["returns"]>["history"]>> | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }));
  const close = useCallback(() => { setChoice(null); setAttempt(value => value + 1); }, []);
  useEffect(() => {
    const controller = new AbortController();
    const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-csz-account-order]"));
    const listeners: Array<() => void> = [];
    let observer: IntersectionObserver | null = null;
    let active = 0;
    const queued: HTMLElement[] = [];
    const seen = new Set<HTMLElement>();
    let activeSession: Bootstrap | null = null;
    setError(null);
    rows.forEach(row => row.querySelectorAll<HTMLElement>("[data-csz-account-action]").forEach(button => { button.hidden = true; }));
    function schedule() {
      // Bound provider inspection work; paginate/scroll adds rows without
      // delaying the native order list or flooding Shopify with parallel reads.
      while (active < 2 && queued.length && !controller.signal.aborted) {
        const row = queued.shift()!;
        active += 1;
        void inspect(row).finally(() => { active -= 1; schedule(); });
      }
    }
    async function inspect(row: HTMLElement) {
      const status = row.querySelector<HTMLElement>("[data-csz-order-tools-status]");
      if (status) status.textContent = "Checking available actions…";
      try {
        const identity = await api.resolve({ orderReference: row.dataset.orderReference, externalOrderId: row.dataset.externalOrderId }, controller.signal);
        const currentSession = activeSession;
        if (!currentSession) return;
        if (controller.signal.aborted) return;
        const editable = row.dataset.fulfillment !== "fulfilled" && row.dataset.cancelled !== "true";
        const canHaveReturn = ["fulfilled", "partial"].includes(row.dataset.fulfillment ?? "") && row.dataset.cancelled !== "true";
        const results = await Promise.allSettled([
          editable ? api.edits.order(identity.connectionId, identity.omsOrderId, controller.signal) : Promise.resolve(null),
          canHaveReturn ? api.returns(currentSession.session.sessionKey!).order(identity.omsOrderId, controller.signal) : Promise.resolve(null),
        ]);
        if (controller.signal.aborted) return;
        const editResult = results[0];
        const returnResult = results[1];
        const bind = (kind: "edit" | "return", returnOrder?: CustomerReturnCustomerOrder) => {
          const button = row.querySelector<HTMLButtonElement>(`[data-csz-account-action="${kind}"]`);
          if (!button) return;
          button.hidden = false;
          const click = () => setChoice({ kind, omsOrderId: identity.omsOrderId, returnOrder });
          button.addEventListener("click", click);
          listeners.push(() => button.removeEventListener("click", click));
        };
        if (editResult.status === "fulfilled" && editResult.value && (editResult.value.activeOperationId || (currentSession.connection.enabled && editResult.value.eligibility.editable))) {
          bind("edit");
          const address = row.querySelector<HTMLElement>("[data-csz-account-action='address']");
          if (address && editResult.value.eligibility.editable) address.hidden = false;
        }
        if (returnResult.status === "fulfilled" && returnResult.value?.order.lines.some(line => line.eligibleQuantity > 0)) bind("return", returnResult.value);
        if (status) status.textContent = results.some(result => result.status === "rejected") ? "Some order actions could not be checked. Refresh this page to try again."
          : editResult.status === "fulfilled" && editResult.value && !editResult.value.eligibility.editable
            ? editResult.value.eligibility.reasons[0] ?? "This order can no longer be edited." : "";
      } catch (cause) { if (!controller.signal.aborted && status) status.textContent = message(cause); }
    }
    void api.bootstrap(controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setSession(result);
      activeSession = result;
      void api.returns(result.session.sessionKey!).history(null, controller.signal).then(value => {
        if (!controller.signal.aborted) { setHistory(value); setHistoryError(null); }
      }).catch(cause => { if (!controller.signal.aborted) setHistoryError(message(cause)); });
      observer = new IntersectionObserver(entries => {
        entries.filter(entry => entry.isIntersecting).forEach(entry => {
          const row = entry.target as HTMLElement;
          if (!seen.has(row)) { seen.add(row); queued.push(row); observer?.unobserve(row); }
        });
        schedule();
      }, { rootMargin: "200px" });
      rows.forEach(row => observer!.observe(row));
    }).catch(cause => { if (!controller.signal.aborted) setError(message(cause)); });
    return () => { controller.abort(); observer?.disconnect(); listeners.forEach(remove => remove()); client.clear(); };
  }, [api, root, attempt, client]);
  async function showReturn(authorizationId: number, omsOrderId: number) {
    if (!session?.session.sessionKey) return;
    try {
      const returnStatus = await api.returns(session.session.sessionKey).status(authorizationId, new AbortController().signal);
      setChoice({ kind: "labels", omsOrderId, returnStatus });
    } catch (cause) { setHistoryError(message(cause)); }
  }
  const accessError = error && <div className="csz-account-notice" role="alert"><span>{error}</span><button type="button" className="csz-action" onClick={() => setAttempt(value => value + 1)}>Retry account tools</button></div>;
  return <QueryClientProvider client={client}>
    {accessError && (statusTarget ? createPortal(accessError, statusTarget) : accessError)}
    {choice && session && <AccountModal key={`${choice.kind}:${choice.omsOrderId}:${choice.returnStatus?.authorizationId ?? "intake"}`} api={api} session={session} choice={choice} onClose={close} />}
    {session && <section className="csz-account-returns" aria-label="Your returns"><h2>Your returns</h2>
      {historyError && <p role="status">{historyError}</p>}
      {history?.returns.length === 0 && <p>You don’t have any returns yet.</p>}
      {history?.returns.map(item => <button className="csz-action" type="button" key={item.authorizationId} onClick={() => void showReturn(item.authorizationId, item.omsOrderId)}>
        {item.orderReference ? `Order ${item.orderReference} · ` : ""}{item.authorizationNumber} · View labels
      </button>)}
      {history?.nextBeforeAuthorizationId && <button className="csz-action" type="button" onClick={() => {
        void api.returns(session.session.sessionKey!).history(history.nextBeforeAuthorizationId, new AbortController().signal).then(page => setHistory(previous => ({ ...page,
          returns: [...(previous?.returns ?? []).filter(item => !page.returns.some(next => next.authorizationId === item.authorizationId)), ...page.returns] }))).catch(cause => setHistoryError(message(cause)));
      }}>More returns</button>}
    </section>}
  </QueryClientProvider>;
}
const root = document.querySelector<HTMLElement>("[data-csz-customer-account]");
const mount = document.getElementById("csz-customer-account-tools");
const configElement = document.getElementById("csz-customer-account-config");
if (root && mount && configElement) {
  const statusTarget = root.querySelector<HTMLElement>("[data-csz-account-tools-status]");
  try {
    const config = customerAccountPageConfigSchema.parse(JSON.parse(configElement.textContent ?? "null"));
    const api = createCustomerAccountTransport(config);
    createRoot(mount).render(<CustomerAccount root={root} api={api} statusTarget={statusTarget} />);
  } catch {
    const notice = document.createElement("p"); notice.setAttribute("role", "alert");
    notice.textContent = "Account tools could not be loaded. Please refresh this page.";
    (statusTarget ?? mount).append(notice);
  }
}
