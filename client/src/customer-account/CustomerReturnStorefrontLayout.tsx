import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { CustomerReturnPresentationContext } from "@/components/returns/CustomerReturnPresentation";

/** Presentation only. The shared return workspace continues to own every command. */
export function CustomerReturnStorefrontLayout({ children, accountTools, sessionTools }: {
  children: ReactNode;
  accountTools?: ReactNode;
  sessionTools?: ReactNode;
}) {
  return <CustomerReturnPresentationContext.Provider value="storefront">
    <div className="csz-storefront-returns">
      <header className="csz-returns-page-heading">
        <div><h1>Returns</h1><p>Start a return or manage one you’ve already started.</p></div>
        <a className="csz-returns-text-link" href="https://www.cardshellz.com/"><ArrowLeft size={16} aria-hidden="true" />Continue shopping</a>
      </header>
      <div className="csz-returns-page-layout">
        <div className="csz-returns-page-main">{children}{sessionTools && <div className="csz-returns-session">{sessionTools}</div>}</div>
        <aside className="csz-returns-help" aria-label="Returns help">
          <section><h2>Need a hand?</h2><p>We’re here to help with your order or return.</p><a href="/pages/contact-us">Contact us</a></section>
          <section><h2>Before you send it</h2><p>Use one label per box. Your refund is reviewed after we receive and inspect the items.</p><a href="/pages/returns">Read the return policy</a></section>
          {accountTools}
        </aside>
      </div>
    </div>
  </CustomerReturnPresentationContext.Provider>;
}
