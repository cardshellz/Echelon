import { useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import type { CustomerOrderTotalsState } from "./CustomerAccountOrderTotals";

/** Reveal a history page only after every amount has been verified. Monetary
 * portals commit before this layout effect, so rows never paint empty totals
 * or a guessed historical amount while their current value is loading. */
export function CustomerAccountOrderHistory({
  root,
  states,
  hasAccessError,
  onRetry,
}: {
  root: HTMLElement;
  states: ReadonlyMap<HTMLElement, CustomerOrderTotalsState>;
  hasAccessError: boolean;
  onRetry(): void;
}) {
  const content = root.querySelector<HTMLElement>(
    "[data-csz-order-history-content]",
  );
  const status = root.querySelector<HTMLElement>(
    "[data-csz-order-history-status]",
  );
  const values = [...states.values()];
  const ready =
    values.length > 0 && values.every((value) => value.status === "verified");
  const pending = values.some((value) => value.status === "loading");
  useLayoutEffect(() => {
    if (!content) return;
    content.hidden = !ready;
    return () => {
      content.hidden = true;
    };
  }, [content, ready]);
  if (!content || !status || ready || hasAccessError) return null;
  return createPortal(
    pending ? (
      <p role="status">Loading your orders…</p>
    ) : (
      <div role="alert" className="csz-account-notice">
        <p>We couldn’t load your orders. Please try again.</p>
        <button type="button" className="csz-action" onClick={onRetry}>
          Try again
        </button>
      </div>
    ),
    status,
  );
}
