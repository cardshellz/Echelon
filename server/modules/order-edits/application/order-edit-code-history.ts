import type { OrderEditSnapshot } from "./order-edit-provider";

/** Read-only access to the existing immutable order-edit pricing evidence. */
export interface OrderEditCodeHistory {
  enrich(
    snapshot: OrderEditSnapshot,
    descriptionsByLine: Map<string, string[]>,
  ): Promise<OrderEditSnapshot>;
}
