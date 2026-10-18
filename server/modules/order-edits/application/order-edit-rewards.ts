import type { OrderEditCodeRule } from "@shared/order-edits/order-edit-codes";

/** Club alone verifies issuance, ownership and the points already reserved for a reward. */
export interface OrderEditRewards {
  available(): boolean;
  identify(input: { customerId: string; codes: string[] }): Promise<string[]>;
  verify(input: {
    customerId: string;
    orderId: string;
    rules: OrderEditCodeRule[];
  }): Promise<void>;
}
