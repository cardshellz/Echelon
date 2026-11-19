import { useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import type { CustomerOrderTotalsState } from "./CustomerAccountOrderTotals";

/** Known rows stay visible while an individual saved fact refreshes. */
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
    values.length > 0 && values.some((value) => value.status === "verified");
  const pending = values.some((value) => value.status === "loading");
  useLayoutEffect(() => {
    if (!content) return;
    content.hidden = false;
    return () => {
      content.hidden = true;
    };
  }, [content]);
  const failed = values.some((value) => value.status === "failed");
  if (!content || !status || (ready && !failed) || hasAccessError) return null;
  return createPortal(
    pending ? (
      <p role="status">Loading your orders…</p>
    ) : (
      <div role="alert" className="csz-account-notice">
        <p>
          {ready
            ? "Some order totals couldn’t be loaded."
            : "We couldn’t load your orders. Please try again."}
        </p>
        <button type="button" className="csz-action" onClick={onRetry}>
          Try again
        </button>
      </div>
    ),
    status,
  );
}
