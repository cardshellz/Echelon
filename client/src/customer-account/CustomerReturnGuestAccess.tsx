import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { CustomerReturnSurface } from "@/components/returns/CustomerReturnSurface";
import { CustomerWorkspace } from "@/pages/CustomerReturnCustomerPortal";
import { returnGuestSessionSchema, type ReturnGuestSession } from "@shared/returns/customer-return-guest.contract";
import { createGuestReturnTransport } from "./customer-return-guest.transport";
import type { ReturnPortalPageConfig } from "./return-portal-config";

const draftSchema = z.object({ requestKey: z.string().uuid(), browserKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  email: z.string().max(254), orderReference: z.string().max(100), expiresAt: z.string().datetime().nullable() });
type Draft = z.infer<typeof draftSchema>;
function newDraft(): Draft {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return { requestKey: crypto.randomUUID(), browserKey: btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""),
    email: "", orderReference: "", expiresAt: null };
}

export function CustomerReturnGuestAccess({ config, loginHref }: { config: ReturnPortalPageConfig; loginHref: string }) {
  const api = useMemo(() => createGuestReturnTransport(config), [config]);
  const storageKey = `csz-guest-return:${config.proxyPath}`;
  const [draft, setDraft] = useState<Draft>(() => {
    try { const saved = draftSchema.safeParse(JSON.parse(sessionStorage.getItem(`${storageKey}:lookup`) ?? "null")); if (saved.success) return saved.data; } catch { /* Storage may be disabled; requests still work in this page. */ }
    return newDraft();
  });
  const [session, setSession] = useState<ReturnGuestSession | null>(() => {
    try { const saved = returnGuestSessionSchema.safeParse(JSON.parse(sessionStorage.getItem(storageKey) ?? "null"));
      if (saved.success && Date.parse(saved.data.expiresAt) > Date.now()) return saved.data; } catch { /* An invalid saved proof grants nothing. */ }
    return null;
  });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accountLink, setAccountLink] = useState<{ kind: "activate" | "sign_in" | "register"; url: string } | null>(null);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  useEffect(() => { try { sessionStorage.setItem(`${storageKey}:lookup`, JSON.stringify(draft)); } catch { /* In-memory retry retains the same request key. */ } }, [draft, storageKey]);
  useEffect(() => { try { if (session) sessionStorage.setItem(storageKey, JSON.stringify(session)); else sessionStorage.removeItem(storageKey); } catch { /* No persistent proof is required to use the current page. */ } }, [session, storageKey]);
  async function run(work: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return;
    const controller = new AbortController(); operation.current = controller; setBusy(true); setError(null);
    try { await work(controller.signal); }
    catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "We couldn't load your return. Please try again."); }
    finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
  }
  const reset = useCallback(() => { operation.current?.abort(); operation.current = null; setBusy(false); setSession(null); setAccountLink(null); setError(null); setCode(""); setDraft(newDraft()); }, []);
  const requireVerification = useCallback((message: string) => {
    setSession(null); setAccountLink(null); setCode(""); setError(message);
    // Do not trap an expired/changed grant behind its old email challenge.
    // Preserve the entered order/email, but require an explicit fresh lookup.
    setDraft(current => ({ ...current, requestKey: crypto.randomUUID(), expiresAt: null }));
  }, []);
  async function sendCode(signal: AbortSignal) {
    const current = draft.expiresAt && Date.parse(draft.expiresAt) <= Date.now()
      ? { ...draft, requestKey: crypto.randomUUID(), expiresAt: null } : draft;
    // Save a replacement key before the network request. A lost response must
    // retry that challenge rather than send another code under a new key.
    setDraft(current);
    const result = await api.lookup({ requestKey: current.requestKey, browserKey: current.browserKey, email: current.email, orderReference: current.orderReference }, signal);
    if (!signal.aborted) { setDraft({ ...current, expiresAt: result.expiresAt }); setCode(""); }
  }
  const gateway = useMemo(() => session ? api.returns(session) : null, [api, session]);
  if (session && gateway) return <>
    <div className="csz-return-ui csz-guest-account">
      <p>You’re returning this order as a guest. An account is optional.</p>
      {error && <p role="alert">{error}</p>}
      {accountLink ? <><Button asChild><a href={accountLink.url} target="_blank" rel="noopener noreferrer" aria-describedby="guest-account-navigation">{accountLink.kind === "activate" ? "Activate your account" : accountLink.kind === "sign_in" ? "Sign in to your account" : "Create an account"}</a></Button>
        <p id="guest-account-navigation">Account setup opens in a new tab. Your return stays open here.</p>
        {accountLink.kind === "register" && <p>You can create an account for future purchases. Continue this return here as a guest.</p>}</>
        : <Button variant="outline" disabled={busy} onClick={() => void run(async signal => { const result = await api.account(session, signal); if (!signal.aborted) setAccountLink(result); })}>Set up account access</Button>}
    </div>
    <CustomerWorkspace key={session.sessionKey} sessionKey={session.sessionKey}
      transport={gateway.transport} downloadRequest={gateway.request} onSignedOut={reset}
      onDenied={requireVerification} />
  </>;
  return <CustomerReturnSurface shoppingHref="https://www.cardshellz.com/">
    <div className="csz-return-status csz-guest-access">
      <h1>Find your order</h1>
      <p>Purchased as a guest? Enter the order number and email used at checkout. We’ll email you a verification code.</p>
      {error && <p role="alert">{error}</p>}
      <form onSubmit={event => { event.preventDefault(); void run(async signal => {
        if (draft.expiresAt) { const result = await api.verify({ challengeId: draft.requestKey, browserKey: draft.browserKey, code }, signal); if (!signal.aborted) setSession(result); }
        else await sendCode(signal);
      }); }}>
        {draft.expiresAt ? <>
          <p>If the order and email match, a code has been sent. Codes expire 10 minutes after the first request.</p>
          <label htmlFor="return-guest-code">Email verification code</label>
          <input id="return-guest-code" aria-describedby="return-guest-code-hint" inputMode="numeric" autoComplete="one-time-code" value={code} maxLength={8} pattern="[0-9]{8}" required disabled={busy} onChange={event => setCode(event.target.value.replace(/\D/g,""))} />
          <p id="return-guest-code-hint">Enter the 8-digit code. You can resend it after one minute.</p>
        </> : <>
          <label htmlFor="return-guest-order">Order number</label>
          <input id="return-guest-order" autoComplete="off" placeholder="e.g. 12345" value={draft.orderReference} maxLength={100} required disabled={busy} onChange={event => setDraft(current => ({ ...current, requestKey: crypto.randomUUID(), orderReference: event.target.value }))} />
          <label htmlFor="return-guest-email">Email used at checkout</label>
          <input id="return-guest-email" type="email" autoComplete="email" value={draft.email} maxLength={254} required disabled={busy} onChange={event => setDraft(current => ({ ...current, requestKey: crypto.randomUUID(), email: event.target.value }))} />
        </>}
        <Button type="submit" disabled={busy}>{busy ? "Please wait…" : draft.expiresAt ? "Verify and continue" : "Email me a code"}</Button>
      </form>
      {draft.expiresAt && <div className="csz-guest-code-actions">
        <Button variant="outline" disabled={busy} onClick={() => void run(sendCode)}>Resend code</Button>
        <Button variant="ghost" disabled={busy} onClick={reset}>Change order or email</Button>
      </div>}
      <p>Already have an account? <a href={loginHref}>Sign in</a></p>
      <p>Can’t find your order or email code? <a href="/pages/contact-us">Contact us</a>.</p>
    </div>
  </CustomerReturnSurface>;
}
