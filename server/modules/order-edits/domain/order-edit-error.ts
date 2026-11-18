import type { OrderEditCodeErrorParams } from "@shared/order-edits/order-edit-code-errors";

export class OrderEditError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
    public readonly params?: OrderEditCodeErrorParams,
  ) {
    super(message);
    this.name = "OrderEditError";
  }
}
