/** Current Shellz Club purchase cost for one sellable pack; never a quote or debit. */
export type DropshipProductCostSource = "variant_fixed_price" | "variant_percent" | "plan_percent" | "retail";

export type DropshipProductCostIssue =
  | "vendor_unavailable" | "plan_unavailable" | "entitlement_inactive"
  | "variant_unmapped" | "variant_ambiguous" | "variant_identity_mismatch"
  | "override_ambiguous" | "override_invalid" | "retail_unavailable"
  | "pricing_configuration_invalid" | "source_read_failed";

export type DropshipProductCost = Readonly<{
  status: "available" | "unavailable";
  unitCostCents: number | null;
  planId: string | null;
  source: DropshipProductCostSource | null;
  overrideId: string | null;
  issue: DropshipProductCostIssue | null;
}>;

export interface DropshipProductCostReader {
  loadProductCosts(input: {
    vendorId: number;
    productVariantIds: readonly number[];
  }): Promise<ReadonlyMap<number, DropshipProductCost>>;
}
