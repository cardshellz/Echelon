import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { financialCommandFetchJson } from "@/lib/financial-command";

export const poProductOptionSchema = z.object({
  id: z.number().int().positive(), name: z.string(), sku: z.string().nullable(), isActive: z.boolean().optional(), status: z.string().optional(),
  variants: z.array(z.object({ id: z.number().int().positive(), name: z.string(), sku: z.string().nullable(), unitsPerVariant: z.number().int().positive(),
    isActive: z.boolean().optional() })).optional(),
});
export type PoProductOption = z.infer<typeof poProductOptionSchema>;
export type PoReceiveUnitOption = NonNullable<PoProductOption["variants"]>[number];

/** Catalog search shared by every PO editor picker. The server verifies the
 * chosen product and unit again under row locks before anything is saved. */
export function usePoProductSearch(search: string, enabled: boolean) {
  const url = `/api/products?${new URLSearchParams({ q: search.trim(), limit: "50" })}`;
  return useQuery({ queryKey: [url, "po-editor"], enabled,
    queryFn: async () => z.array(poProductOptionSchema).parse(await financialCommandFetchJson(url, { credentials: "include" })) });
}

/** A PO can only buy active, unarchived products. */
export function purchasableProducts(products: readonly PoProductOption[] | undefined): PoProductOption[] {
  return (products ?? []).filter(product => product.isActive !== false && product.status !== "archived");
}

/** An archived package cannot be an inventory destination. */
export function activeReceiveUnits(product: PoProductOption | null): PoReceiveUnitOption[] {
  return product?.variants?.filter(variant => variant.isActive !== false) ?? [];
}
