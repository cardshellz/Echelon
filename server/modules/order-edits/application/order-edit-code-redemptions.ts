import type { OrderEditCodeRule } from "@shared/order-edits/order-edit-codes";

/** The membership application owns issued rewards and their redemption ledger. */
export interface OrderEditCodeRedemptions {
  available(): boolean;
  validate(input: {
    customerId: string;
    orderId: string;
    rules: OrderEditCodeRule[];
  }): Promise<void>;
  reserve(operationId: string): Promise<void>;
  finalize(operationId: string): Promise<void>;
  release(operationId: string): Promise<void>;
}
