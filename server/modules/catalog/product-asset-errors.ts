export class ProductAssetError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "ProductAssetError";
  }
}
