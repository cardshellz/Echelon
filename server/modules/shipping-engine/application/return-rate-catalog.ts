import { z } from "zod";

export const returnRateCatalogServiceSchema = z.object({
  domestic: z.boolean(),
  supportsReturns: z.boolean(),
  sendRates: z.boolean(),
  returnSupport: z.enum(["supported", "unsupported", "unknown"]).optional(),
});
export type ReturnRateCatalogService = z.infer<
  typeof returnRateCatalogServiceSchema
>;

/** Catalog availability only: a merchant must still explicitly allow the exact
 * account/service, and a completed return-specific quote must establish eligibility.
 * ShipStation's documented service schema has send_rates but no return-support flag.
 * Preserve fixed-service compatibility for explicit support even without rating.
 */
export function isReturnRateCatalogServiceEligible(service: unknown): boolean {
  const parsed = returnRateCatalogServiceSchema.safeParse(service);
  if (!parsed.success) return false;
  const capability = parsed.data;
  if (!capability.domestic || capability.returnSupport === "unsupported")
    return false;
  if (capability.returnSupport === "unknown") return capability.sendRates;
  return capability.supportsReturns || capability.sendRates;
}
