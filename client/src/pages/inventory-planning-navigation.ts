// Product IDs use PostgreSQL INTEGER in the existing planning HTTP contract.
const MAX_PRODUCT_ID = 2_147_483_647;

export function parseInventoryPlanningProductId(search: string): number | null {
  const values = new URLSearchParams(search).getAll("productId");
  if (values.length !== 1 || !/^[1-9]\d*$/.test(values[0]!)) return null;
  const productId = Number(values[0]);
  return Number.isSafeInteger(productId) && productId <= MAX_PRODUCT_ID ? productId : null;
}

export function inventoryPlanningProductHref(path: string, productId: number | null): string {
  if (productId === null) return path;
  if (!Number.isSafeInteger(productId) || productId <= 0 || productId > MAX_PRODUCT_ID) {
    throw new Error("A positive database product ID is required for planning navigation.");
  }
  return `${path}?productId=${productId}`;
}
