import type { DropshipAtpProvider } from "../application/dropship-selection-atp-service";

interface InventoryAtpServiceLike {
  getAtpPerVariant(productId: number): Promise<readonly {
    productVariantId: number;
    atpUnits: number;
  }[]>;
}

export class InventoryServiceDropshipAtpProvider implements DropshipAtpProvider {
  constructor(private readonly inventoryAtpService: InventoryAtpServiceLike) {}

  async getVariantAtp(
    targets: readonly { productId: number; productVariantId: number }[],
  ): Promise<Map<number, number>> {
    if (targets.length === 0) return new Map();
    const productIdByVariantId = new Map<number, number>();
    for (const target of targets) {
      const productId = positiveInteger(target.productId, "productId");
      const productVariantId = positiveInteger(target.productVariantId, "productVariantId");
      const existingProductId = productIdByVariantId.get(productVariantId);
      if (existingProductId != null && existingProductId !== productId) {
        throw providerError(
          "DROPSHIP_ATP_TARGET_CONFLICT",
          "One product variant cannot belong to multiple ATP target products.",
          { productVariantId, productIds: [existingProductId, productId] },
        );
      }
      productIdByVariantId.set(productVariantId, productId);
    }
    const productIds = [...new Set(productIdByVariantId.values())].sort((left, right) => left - right);
    const rowsByProductId = await Promise.all(productIds.map(async (productId) => ({
      productId,
      rows: await this.inventoryAtpService.getAtpPerVariant(productId),
    })));
    const result = new Map<number, number>(
      [...productIdByVariantId.keys()].map((variantId) => [variantId, 0]),
    );
    for (const { productId, rows } of rowsByProductId) {
      for (const row of rows) {
        if (productIdByVariantId.get(row.productVariantId) !== productId) continue;
        if (!Number.isSafeInteger(row.atpUnits) || row.atpUnits < 0) {
          throw providerError(
            "DROPSHIP_ATP_QUANTITY_INVALID",
            "The authoritative inventory service returned an invalid variant ATP quantity.",
            { productId, productVariantId: row.productVariantId, atpUnits: row.atpUnits },
          );
        }
        result.set(row.productVariantId, row.atpUnits);
      }
    }
    return result;
  }
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw providerError(
      "DROPSHIP_ATP_TARGET_INVALID",
      `${field} must be a positive PostgreSQL integer.`,
      { field, value },
    );
  }
  return parsed;
}

function providerError(
  code: string,
  message: string,
  context: Readonly<Record<string, unknown>>,
): Error {
  return Object.assign(new Error(message), { code, context });
}
