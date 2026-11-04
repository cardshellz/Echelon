export class CustomerAccountRequestError extends Error {
  constructor(
    public readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "CustomerAccountRequestError";
  }
}
