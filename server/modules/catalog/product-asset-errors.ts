export class ProductAssetError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProductAssetError";
  }
}
