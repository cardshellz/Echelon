import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { CustomerReturnSurface } from "@/components/returns/CustomerReturnSurface";
import { CustomerWorkspace } from "@/pages/CustomerReturnCustomerPortal";
import { customerAccountAccessNotice, customerAccountSignInUrl, type CustomerAccountAccessNotice } from "./customer-account-access";
import { createCustomerAccountTransport, type CustomerAccountTransport } from "./customer-account.transport";
import type { ReturnPortalPageConfig } from "./return-portal-config";

type Bootstrap = Awaited<ReturnType<CustomerAccountTransport["bootstrap"]>>;

/** Full storefront page using the account proxy's existing customer boundary.
 * No iframe, cross-origin cookies, or second return/label workflow. */
export function CustomerReturnStorefrontPage({ config }: { config: ReturnPortalPageConfig }) {
  const api = useMemo(() => config.customerId ? createCustomerAccountTransport({
    themeId: config.themeId, customerId: config.customerId,
    proxyPath: config.proxyPath, loginPath: config.loginPath,
  }) : null, [config]);
  const [session, setSession] = useState<Bootstrap | null>(null);
  const [notice, setNotice] = useState<CustomerAccountAccessNotice | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loginHref = customerAccountSignInUrl(config.loginPath, `${window.location.pathname}${window.location.search}`);

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    setSession(null);
    setNotice(null);
    void api.bootstrap(controller.signal).then(result => {
      if (!controller.signal.aborted) setSession(result);
    }).catch(cause => {
      if (!controller.signal.aborted) setNotice(customerAccountAccessNotice(cause, "history"));
    });
    return () => controller.abort();
  }, [api, attempt]);

  const returns = useMemo(() => session?.session.sessionKey && api
    ? api.returns(session.session.sessionKey) : null, [api, session]);
  if (api && session?.session.sessionKey && returns) return (
    <CustomerWorkspace key={session.session.sessionKey}
      sessionKey={session.session.sessionKey} transport={returns} downloadRequest={api.request}
      signOutHref={config.logoutPath}
      onDenied={message => { setSession(null); setNotice({ message, action: "retry" }); }}
      onSignedOut={() => { window.location.assign(config.logoutPath); }} />
  );
  return (
    <CustomerReturnSurface shoppingHref="https://www.cardshellz.com/">
      <div className="csz-return-status">
        <h1 className="text-2xl font-semibold">Return an order</h1>
        {notice ? <p role="alert">{notice.message}</p> : <p>
          {api ? "Loading your orders…" : "Sign in to your Card Shellz account to see orders available to return."}
        </p>}
        {!api || notice?.action === "sign_in" ? (
          <Button asChild><a href={loginHref}>Sign in to your account</a></Button>
        ) : notice ? <Button onClick={() => setAttempt(value => value + 1)}>Try again</Button> : null}
      </div>
    </CustomerReturnSurface>
  );
}
