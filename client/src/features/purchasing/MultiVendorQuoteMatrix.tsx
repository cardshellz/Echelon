import type { SupplierSourcingOption } from "@shared/procurement/supplier-sourcing";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Check, ExternalLink, Sparkles, Zap } from "lucide-react";
import {
  buildNewEditablePoHref,
  rankAndAnnotateSupplierOptions,
} from "./multi-vendor-quote-helpers";

const STATUS_BADGE_CLASS: Record<"green" | "amber" | "red" | "gray", string> = {
  green: "border-emerald-200 bg-emerald-50 text-emerald-700",
  amber: "border-amber-200 bg-amber-50 text-amber-800",
  red: "border-red-200 bg-red-50 text-red-700",
  gray: "border-zinc-200 bg-zinc-50 text-zinc-600",
};

export interface MultiVendorQuoteMatrixProps {
  sku: string;
  productVariantId?: number | null;
  options: readonly SupplierSourcingOption[];
  selectedVendorProductId?: number | null;
  asOfIsoDate?: string;
  canEditPurchasing?: boolean;
  onSelectSupplier?: (option: SupplierSourcingOption) => void;
  onNavigate?: (href: string) => void;
  compact?: boolean;
  currencyCodeOnly?: boolean;
}

export function MultiVendorQuoteMatrix({
  sku,
  productVariantId,
  options,
  selectedVendorProductId,
  asOfIsoDate,
  canEditPurchasing = false,
  onSelectSupplier,
  onNavigate,
  compact = false,
  currencyCodeOnly = false,
}: MultiVendorQuoteMatrixProps) {
  const annotated = rankAndAnnotateSupplierOptions(
    options,
    selectedVendorProductId,
    asOfIsoDate,
    currencyCodeOnly,
  );

  if (annotated.length === 0) {
    return (
      <div
        className="rounded-md border border-dashed bg-zinc-50/70 px-3 py-2.5 text-xs text-zinc-500"
        data-testid={`quote-matrix-empty-${sku}`}
      >
        No supplier quotes or catalog mappings recorded for <span className="font-mono font-medium">{sku}</span>.
      </div>
    );
  }

  const showActions = Boolean(onSelectSupplier || (canEditPurchasing && onNavigate));

  return (
    <div
      className="overflow-x-auto rounded-md border bg-white"
      data-testid={`quote-matrix-${sku}`}
    >
      <table className="w-full min-w-[600px] text-xs">
        <thead>
          <tr className="border-b bg-zinc-50/80 text-left text-[10px] uppercase tracking-wider text-zinc-500">
            <th className="px-3 py-2 font-semibold">Supplier</th>
            <th className="px-2 py-2 font-semibold">Unit / Pack Quote</th>
            <th className="px-2 py-2 font-semibold">MOQ &amp; Pack</th>
            <th className="px-2 py-2 text-right font-semibold">Lead</th>
            <th className="px-2 py-2 text-right font-semibold">Proposed Est.</th>
            <th className="px-2 py-2 font-semibold">Quote Status</th>
            {showActions && <th className="px-3 py-2 text-right font-semibold">Action</th>}
          </tr>
        </thead>
        <tbody className="divide-y">
          {annotated.map((entry) => {
            const { option } = entry;
            return (
              <tr
                key={option.vendorProductId}
                className={`${
                  entry.isSelected
                    ? "bg-emerald-50/40"
                    : !option.eligible
                      ? "bg-zinc-50/60 text-zinc-400"
                      : "hover:bg-zinc-50/60"
                }`}
              >
                <td className="px-3 py-2 align-top">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold text-zinc-900">{option.vendorName}</span>
                    {option.preferred && (
                      <Badge variant="outline" className="border-blue-200 bg-blue-50 px-1.5 py-0 text-[10px] text-blue-700">
                        Preferred
                      </Badge>
                    )}
                    {entry.isBestPrice && (
                      <Badge variant="outline" className="border-emerald-200 bg-emerald-50 px-1.5 py-0 text-[10px] text-emerald-700">
                        <Sparkles className="mr-0.5 h-2.5 w-2.5" />
                        Best price
                      </Badge>
                    )}
                    {entry.isFastestLeadTime && (
                      <Badge variant="outline" className="border-violet-200 bg-violet-50 px-1.5 py-0 text-[10px] text-violet-700">
                        <Zap className="mr-0.5 h-2.5 w-2.5" />
                        Fastest
                      </Badge>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-zinc-500">
                    Priority {option.priority}
                    {option.tier ? ` · Ref ${option.tier.priceList.quoteReference}` : ""}
                  </div>
                </td>

                <td className="px-2 py-2 align-top tabular-nums">
                  {entry.formattedUnitCost ? (
                    <div className="font-semibold text-zinc-900">{entry.formattedUnitCost}</div>
                  ) : (
                    <span className="text-zinc-400">Unpriced</span>
                  )}
                  {entry.formattedPackQuote && (
                    <div className="text-[11px] text-zinc-500">{entry.formattedPackQuote}</div>
                  )}
                  {!compact && entry.tierSummaries.length > 1 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {entry.tierSummaries.map((tier) => (
                        <span
                          key={tier.label}
                          className={`rounded border px-1.5 py-0.5 text-[10px] ${
                            tier.isActive
                              ? "border-emerald-300 bg-emerald-50 font-medium text-emerald-800"
                              : "border-zinc-200 bg-zinc-50 text-zinc-500"
                          }`}
                        >
                          {tier.label}
                        </span>
                      ))}
                    </div>
                  )}
                </td>

                <td className="px-2 py-2 align-top tabular-nums">
                  <div>{entry.moqLabel}</div>
                  <div className="text-[11px] text-zinc-500">{entry.incrementLabel}</div>
                </td>

                <td className="px-2 py-2 text-right align-top font-medium tabular-nums">
                  {option.leadTimeDays}d
                </td>

                <td className="px-2 py-2 text-right align-top tabular-nums">
                  {option.proposedPieces > 0 ? (
                    <>
                      <div className="font-medium">{option.proposedPieces.toLocaleString("en-US")} pc</div>
                      <div className="text-[11px] text-zinc-500">
                        {entry.formattedLineTotal ?? "quote needed"}
                      </div>
                    </>
                  ) : (
                    <span className="text-zinc-400">—</span>
                  )}
                </td>

                <td className="px-2 py-2 align-top">
                  <Badge
                    variant="outline"
                    className={`whitespace-nowrap text-[10px] ${STATUS_BADGE_CLASS[entry.quoteStatus.tone]}`}
                  >
                    {entry.quoteStatus.label}
                  </Badge>
                </td>

                {showActions && (
                  <td className="px-3 py-2 text-right align-top">
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      {onSelectSupplier && option.eligible && (
                        <Button
                          type="button"
                          size="sm"
                          variant={entry.isSelected ? "secondary" : "outline"}
                          className={`h-7 px-2 text-xs ${entry.isSelected ? "text-emerald-700" : ""}`}
                          onClick={() => onSelectSupplier(option)}
                        >
                          {entry.isSelected ? (
                            <>
                              <Check className="mr-1 h-3 w-3" />
                              Selected
                            </>
                          ) : (
                            "Use supplier"
                          )}
                        </Button>
                      )}
                      {canEditPurchasing && onNavigate && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs text-zinc-600 hover:text-zinc-900"
                          title={`Open editable PO composer for ${option.vendorName}`}
                          onClick={() =>
                            onNavigate(
                              buildNewEditablePoHref({
                                vendorId: option.vendorId,
                                productVariantId,
                              }),
                            )
                          }
                        >
                          Editable PO
                          <ExternalLink className="ml-1 h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
