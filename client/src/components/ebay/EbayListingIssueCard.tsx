import { useState } from "react";
import type { EbayListingIssue } from "@shared/types/ebay-listing-issue";
import { Button } from "@/components/ui/button";

interface EbayListingIssueCardProps {
  issue: EbayListingIssue;
  onAction?: (issue: EbayListingIssue) => void;
  busy?: boolean;
}

/** Present the server's recovery decision without inventing client-side retry policy. */
export function EbayListingIssueCard({ issue, onAction, busy = false }: EbayListingIssueCardProps) {
  const [copyResult, setCopyResult] = useState<string | null>(null);
  const safeHref = issue.action.href?.startsWith("/") && !issue.action.href.startsWith("//")
    ? issue.action.href : null;
  const copyDetails = async () => {
    const text = [issue.title, issue.message, issue.nextStep, `Code: ${issue.code}`,
      issue.reference ? `Reference: ${issue.reference}` : null,
      ...(issue.details ?? []).map((detail) => `${detail.label}: ${detail.value}`),
    ].filter(Boolean).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopyResult("Details copied. Include them when requesting help.");
    } catch {
      setCopyResult("Copy is unavailable. Expand Technical details and copy the code and reference below.");
    }
  };

  return (
    <div className="min-w-0 space-y-2 rounded-md border border-amber-300 bg-amber-50/50 p-3 text-left text-sm dark:border-amber-800 dark:bg-amber-950/20" onClick={(event) => event.stopPropagation()}>
      <p className="font-medium break-words">{issue.title}</p>
      <p className="break-words">{issue.message}</p>
      <p className="break-words"><strong>Next step:</strong> {issue.nextStep}</p>
      <div className="flex flex-wrap items-center gap-2">
        {safeHref ? (
          <Button asChild variant="outline" size="sm" className="min-h-[44px] whitespace-normal h-auto py-2">
            <a href={safeHref} target={issue.action.kind === "reconnect" ? "_blank" : undefined} rel={issue.action.kind === "reconnect" ? "noopener noreferrer" : undefined}>{issue.action.label}</a>
          </Button>
        ) : issue.action.kind === "contact_support" ? (
          <Button variant="outline" size="sm" className="min-h-[44px]" onClick={copyDetails}>Copy support details</Button>
        ) : onAction && (issue.action.kind !== "retry_sync" || issue.retryable) ? (
          <Button variant="outline" size="sm" className="min-h-[44px] whitespace-normal h-auto py-2" disabled={busy} onClick={() => onAction(issue)}>{busy ? "Checking…" : issue.action.label}</Button>
        ) : null}
      </div>
      {copyResult && <p role="status" className="text-xs">{copyResult}</p>}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer py-1">Technical details</summary>
        <dl className="space-y-1 mt-1 break-words">
          <div><dt className="inline font-medium">Code: </dt><dd className="inline">{issue.code}</dd></div>
          {issue.reference && <div><dt className="inline font-medium">Reference: </dt><dd className="inline">{issue.reference}</dd></div>}
          {(issue.details ?? []).map((detail, index) => <div key={`${detail.label}-${index}`}><dt className="inline font-medium">{detail.label}: </dt><dd className="inline">{detail.value}</dd></div>)}
        </dl>
      </details>
    </div>
  );
}
