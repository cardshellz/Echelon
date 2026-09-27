import { useState } from "react";
import {
  listingPriceRuleSchema,
  type ListingCatalogItem,
  type ListingDraftItem,
  type ListingPriceRule,
} from "@shared/types/channel-listing-publication";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, money, previewRulePrice } from "./model";

interface Props {
  rule: ListingPriceRule | null;
  items: ListingCatalogItem[];
  draftItems: ListingDraftItem[];
  canEdit: boolean;
  onSave(rule: ListingPriceRule): Promise<void>;
}

export function ListingPricingRules({
  rule,
  items,
  draftItems,
  canEdit,
  onSave,
}: Props) {
  const [type, setType] = useState<ListingPriceRule["type"]>(
    rule?.type ?? "percentage",
  );
  const [value, setValue] = useState(rule?.value ?? "0");
  const [preview, setPreview] = useState<ListingPriceRule | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function review() {
    const result = listingPriceRuleSchema.safeParse({
      type,
      value: value.trim(),
    });
    if (
      !result.success ||
      (type === "override" && /^0(?:\.0{1,2})?$/.test(value.trim()))
    ) {
      setError(
        "Enter a nonnegative value with at most two decimal places. Fixed prices must be greater than zero.",
      );
      return;
    }
    setPreview(result.data);
    setError("");
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pricing Rules</CardTitle>
        <CardDescription>
          Markup uses the retail base price. Fixed item prices take precedence.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          {rule
            ? `Saved channel rule: ${rule.type === "percentage" ? `${rule.value}% markup` : rule.type === "fixed" ? `$${rule.value} addition` : `$${rule.value} fixed price`}.`
            : "No channel default rule. Items use their resolved retail prices."}{" "}
          Saving changes draft pricing; submission still requires a fresh
          review.
        </p>
        <fieldset
          disabled={!canEdit || busy}
          className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
        >
          <div className="space-y-1.5">
            <Label htmlFor="publication-rule-type">Channel default</Label>
            <select
              id="publication-rule-type"
              className="min-h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={type}
              onChange={(event) => {
                setType(event.target.value as ListingPriceRule["type"]);
                setPreview(null);
              }}
            >
              <option value="percentage">Percentage markup</option>
              <option value="fixed">Fixed dollar addition</option>
              <option value="override">Fixed selling price</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="publication-rule-value">
              {type === "percentage" ? "Markup (%)" : "Amount (USD)"}
            </Label>
            <Input
              id="publication-rule-value"
              inputMode="decimal"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setPreview(null);
              }}
            />
          </div>
          <Button variant="outline" className="self-end" onClick={review}>
            Preview prices
          </Button>
        </fieldset>
        <p className="text-xs text-muted-foreground">
          Price source: retail cache, then catalog retail price. Existing
          specific rules take precedence over the channel default. Item
          overrides are preserved.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {preview && (
          <div className="space-y-3">
            <h3 className="font-medium">Selected draft price preview</h3>
            {items.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Select items to compare prices before saving.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="p-2">SKU</th>
                      <th className="p-2">Retail base</th>
                      <th className="p-2">Current</th>
                      <th className="p-2">Proposed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => {
                      const override = draftItems.find(
                        (draft) => draft.variantId === item.variantId,
                      )?.priceOverrideCents;
                      const specific =
                        item.appliedRuleScope !== null &&
                        item.appliedRuleScope !== "channel";
                      const proposed =
                        override ??
                        (specific
                          ? item.priceCents
                          : previewRulePrice(item, preview));
                      return (
                        <tr key={item.variantId} className="border-b">
                          <td className="p-2 font-mono text-xs">{item.sku}</td>
                          <td className="p-2">{money(item.basePriceCents)}</td>
                          <td className="p-2">
                            {money(override ?? item.priceCents)}
                          </td>
                          <td className="p-2">
                            {money(proposed)}
                            {override !== null && override !== undefined
                              ? " (fixed item)"
                              : specific
                                ? " (specific rule)"
                                : ""}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {canEdit && (
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await onSave(preview);
                    setPreview(null);
                  } catch (failure) {
                    setError(errorMessage(failure));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Saving…" : "Save channel pricing rule"}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
