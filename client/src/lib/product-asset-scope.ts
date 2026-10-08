import { productAssetScopeResultSchema, type ProductAssetScopeCommand } from "@shared/catalog/product-asset-scope";

export interface ProductAssetScopeAttempt {
  assetId: number;
  command: ProductAssetScopeCommand;
  idempotencyKey: string;
}
export class ProductAssetScopeSaveError extends Error {
  constructor(message: string, readonly outcome: "rejected" | "unconfirmed") { super(message); }
}

/** The caller retains this exact attempt until its outcome is confirmed. */
export async function saveProductAssetScope(productId: number, attempt: ProductAssetScopeAttempt): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/products/${productId}/assets/${attempt.assetId}/scope`, {
      method: "PUT", credentials: "include",
      headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.idempotencyKey },
      body: JSON.stringify(attempt.command),
    });
  } catch {
    throw new ProductAssetScopeSaveError("Could not confirm the photo assignment. Retry this change.", "unconfirmed");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body as { error?: unknown; code?: unknown } | null;
    const rejected = response.status >= 400 && response.status < 500
      && error?.code !== "FINANCIAL_COMMAND_IN_PROGRESS"
      && error?.code !== "FINANCIAL_COMMAND_STALE_OWNER";
    throw new ProductAssetScopeSaveError(
      typeof error?.error === "string" ? error.error : "Could not confirm the photo assignment. Retry this change.",
      rejected ? "rejected" : "unconfirmed",
    );
  }
  const parsed = productAssetScopeResultSchema.safeParse(body);
  if (!parsed.success || parsed.data.productId !== productId || parsed.data.assetId !== attempt.assetId
    || parsed.data.productVariantId !== attempt.command.productVariantId) {
    throw new ProductAssetScopeSaveError("Could not confirm the photo assignment. Retry this change.", "unconfirmed");
  }
}
