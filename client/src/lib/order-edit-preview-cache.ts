import { canonicalJson } from "@shared/utils/canonical-json";
import type { OrderEditOrder } from "@shared/order-edits/order-edit.contract";
import {
  orderEditPreviewInputSchema,
  type OrderEditPreviewInput,
} from "@shared/order-edits/order-edit-preview";

export const ORDER_EDIT_PREVIEW_REFRESH_GRACE_MS = 100;
export type OrderEditQuantityTarget = { kind: "line" | "addition"; id: string };

/** One bounded read-ahead calculation, using the existing validated preview API.
 * No browser price multiplication or financial command is involved. */
export function nextOrderEditPreviewInput(
  order: OrderEditOrder,
  input: OrderEditPreviewInput,
  target: OrderEditQuantityTarget | null,
): OrderEditPreviewInput | null {
  const selected =
    target ??
    (order.lines.length === 1
      ? { kind: "line" as const, id: order.lines[0].lineItemId }
      : null);
  if (!selected) return null;
  let changes = input.changes.map((line) => ({ ...line }));
  const additions = input.additions.map((line) => ({ ...line }));
  if (selected.kind === "addition") {
    const line = additions.find((line) => line.variantId === selected.id);
    if (!line) return null;
    line.quantity += 1;
  } else {
    const original = order.lines.find(
      (line) => line.lineItemId === selected.id,
    );
    if (!original) return null;
    const changed = changes.find((line) => line.lineItemId === selected.id);
    const quantity = (changed?.quantity ?? original.quantity) + 1;
    changes = changes.filter((line) => line.lineItemId !== selected.id);
    if (quantity !== original.quantity)
      changes.push({ lineItemId: selected.id, quantity });
  }
  const checked = orderEditPreviewInputSchema.safeParse({
    ...input,
    changes,
    additions,
  });
  return checked.success && canonicalJson(checked.data) !== canonicalJson(input)
    ? checked.data
    : null;
}

/** The server's cache expires at its deadline. Refresh just after that boundary;
 * refreshing beforehand only returns the same nearly-expired server result. */
export function orderEditPreviewRefreshDelay(
  expiresAt: string,
  now: number,
): number | false {
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires) || !Number.isFinite(now)) return false;
  return Math.max(
    ORDER_EDIT_PREVIEW_REFRESH_GRACE_MS,
    expires - now + ORDER_EDIT_PREVIEW_REFRESH_GRACE_MS,
  );
}
