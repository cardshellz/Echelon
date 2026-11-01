import type { CustomerReturnOrderChoices } from "@shared/returns/customer-return-access.contract";
import type { CustomerReturnOrderAccessResult } from "./customer-return-order-access.service";

/** Scoped presentation read only: no provider, return command or cache writes.
 * Missing inspection evidence leaves the owned purchase selectable; the selected
 * order is inspected by the existing live owner before its items are shown. */
export interface CustomerReturnOrderChoicesReader {
  read(owned: readonly CustomerReturnOrderAccessResult[]): Promise<
    Pick<CustomerReturnOrderChoices, "orders" | "unavailableOrderCount">
  >;
}

export class CustomerReturnOrderChoicesError extends Error {
  readonly status = 503;
  constructor(readonly code: string) {
    super("We couldn’t load your orders. Please try again.");
    this.name = "CustomerReturnOrderChoicesError";
  }
}
