import { createContext, forwardRef, type ReactNode } from "react";
import { ArrowLeft, Package, X } from "lucide-react";
import "./customer-return.css";

// Packing tools replace the current step inside the account dialog. They must
// not open another modal above the customer's existing return window.
export const CustomerReturnEmbeddedContext = createContext(false);

export const CustomerReturnSurface = forwardRef<
  HTMLElement,
  {
    children: ReactNode;
    onClose?: () => void;
    closeDisabled?: boolean;
    label?: string;
    testId?: string;
    shoppingHref?: string;
  }
>(function CustomerReturnSurface(
  {
    children,
    onClose,
    closeDisabled = false,
    label = "Customer return experience",
    testId,
    shoppingHref,
  },
  ref,
) {
  return (
    <CustomerReturnEmbeddedContext.Provider value={Boolean(onClose)}>
      <section
        ref={ref}
        className="csz-return-ui"
        aria-label={label}
        data-testid={testId}
      >
        <header className="csz-return-brand" data-shopping={Boolean(shoppingHref && !onClose)}>
          <div className="csz-return-brand-name">
            <Package aria-hidden="true" size={24} />
            <span>CARD SHELLZ</span>
            <span className="csz-return-brand-section">Returns</span>
          </div>
          {shoppingHref && !onClose && (
            <a className="csz-return-shopping" href={shoppingHref}>
              <ArrowLeft aria-hidden="true" size={16} />
              Back to shopping
            </a>
          )}
          {onClose && (
            <button
              type="button"
              className="csz-return-close"
              aria-label="Close returns"
              disabled={closeDisabled}
              onClick={onClose}
            >
              <X aria-hidden="true" size={20} />
            </button>
          )}
        </header>
        <div className="csz-return-content">{children}</div>
      </section>
    </CustomerReturnEmbeddedContext.Provider>
  );
});
