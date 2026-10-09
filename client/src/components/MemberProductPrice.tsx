import { useState, type CSSProperties } from "react";
import type { MemberPlanPresentation } from "@shared/membership/member-plan-presentation";
import { formatOrderEditMoney } from "@/lib/order-edits";

/** Thin React presentation of the live storefront's collection price stack and plan badge.
 * Prices are server-resolved; this component never calculates eligibility or discounts.
 * Source: shellz-club-app/theme-extension/assets/cardshellz-membership.js, renderCollectionPrices.
 */
export function MemberProductPrice(props: {
  priceCents: number;
  retailPriceCents?: number;
  plan: MemberPlanPresentation | null;
}) {
  const [failedIcon, setFailedIcon] = useState<string | null>(null);
  const { priceCents, retailPriceCents, plan } = props;
  if (!plan || retailPriceCents === undefined || priceCents >= retailPriceCents)
    return (
      <span className="text-sm tabular-nums">
        {formatOrderEditMoney(priceCents, "USD")}
      </span>
    );
  const style = {
    ...(plan.memberPriceColor
      ? { "--csz-member-price-color": plan.memberPriceColor }
      : {}),
    ...(plan.primaryColor ? { "--csz-plan-accent": plan.primaryColor } : {}),
  } as CSSProperties;
  return (
    <div
      className="cardshellz-catalog-price cardshellz-collection-price"
      style={style}
      aria-label={`${plan.name} member price ${formatOrderEditMoney(priceCents, "USD")}; retail ${formatOrderEditMoney(retailPriceCents, "USD")}`}
    >
      <div className="cardshellz-collection-price__top">
        <span className="cardshellz-retail-strikethrough">
          {formatOrderEditMoney(retailPriceCents, "USD")}
        </span>
      </div>
      <div className="cardshellz-collection-price__bottom">
        <span className="cardshellz-member-price-value">
          {formatOrderEditMoney(priceCents, "USD")}
        </span>
        <span className="cardshellz-member-tag cardshellz-member-tag--only">
          {plan.iconUrl && failedIcon !== plan.iconUrl ? (
            <img
              src={plan.iconUrl}
              alt={plan.badgeText}
              referrerPolicy="no-referrer"
              onError={() => setFailedIcon(plan.iconUrl)}
            />
          ) : (
            <span>{plan.badgeText}</span>
          )}
        </span>
      </div>
    </div>
  );
}
