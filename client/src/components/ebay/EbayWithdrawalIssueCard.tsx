import type { EbayListingIssue } from "@shared/types/ebay-listing-issue";
import { Button } from "@/components/ui/button";
import { EbayListingIssueCard } from "./EbayListingIssueCard";

/** A removal identity failure must not send an excluded product into the
 * publication mapping repair, which requires included variants. */
export function EbayWithdrawalIssueCard({ issue, onCheck, onRetry, busy = false }: {
  issue: EbayListingIssue; onCheck?: () => void; onRetry?: () => void; busy?: boolean;
}) {
  const removalIssue: EbayListingIssue = { ...issue, title: "The listing to remove could not be verified", retryable: false,
    nextStep: "Keep the product excluded. Check the saved removal details. If its listing identity remains unresolved, find the exact product and SKUs in eBay Seller Hub and end the intended listing there. Retry removal afterward so Echelon can verify its state.",
    action: { kind: "check_status", label: "Check saved removal" } };
  return <div className="space-y-2" onClick={event => event.stopPropagation()}>
    <EbayListingIssueCard issue={removalIssue} busy={busy} onAction={onCheck} />
    <div className="flex flex-wrap gap-2">
      <Button asChild variant="outline" size="sm" className="min-h-11"><a href="https://www.ebay.com/sh/lst/active" target="_blank" rel="noopener noreferrer">Review listings in eBay Seller Hub</a></Button>
      {onRetry && <Button variant="outline" size="sm" className="min-h-11" disabled={busy} onClick={onRetry}>Retry removal</Button>}
    </div>
  </div>;
}
