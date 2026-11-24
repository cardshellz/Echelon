/** Explicit procurement failures are durable rejections. Unknown infrastructure
 * failures remain retryable through the transactional command owner. */
export class SupplierReturnError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 409,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SupplierReturnError";
  }
}
