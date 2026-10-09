import { useId } from "react";
import type { ListingSettingsSummary } from "@shared/dropship/listing-settings";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { dropshipPortalPath } from "@/lib/dropship-auth";
import {
  ATTENTION_STRIP_WORDS,
  attentionStripContent,
  type AttentionAction,
  type AttentionLine,
} from "@/lib/dropship-listing-settings-attention";
import type { ListingSettingsReadState } from "@/lib/dropship-listing-settings-access";
import { GuardedLink } from "../catalog/UnsavedChangesGuard";

export interface AttentionStripProps {
  /** The summary read, as React Query holds it. */
  summary: ListingSettingsReadState<Pick<ListingSettingsSummary, "attention" | "rail" | "catalog">>;
  /** A connection banner is shown; it already says to reconnect eBay. */
  bannerShown: boolean;
  storeName: string;
  /** A line's button (other than a link to another page). The step opens the editor, the drawer or the filter. */
  onAction: (action: Exclude<AttentionAction, { kind: "link" }>) => void;
  /** [Try again] after the summary failed to load. */
  onRetry: () => void;
  /** Resolves a portal route to its URL; injected in tests, which have no window. */
  portalHref?: (path: string) => string;
}

/**
 * "Needs your attention" (R:89): at most three lines from the summary, in
 * the server's order, each with one button, and "And N more." [See all] when
 * it holds more. Nothing is shown when the selection is too large to check;
 * the banner says why.
 */
export function AttentionStrip({ summary, bannerShown, storeName, onAction, onRetry, portalHref = dropshipPortalPath }: AttentionStripProps) {
  const titleId = useId();
  const content = attentionStripContent(summary, { bannerShown, storeName });
  if (content.state === "not_checked") return null;
  return (
    <section
      aria-labelledby={titleId}
      aria-busy={content.state === "loading" ? true : undefined}
      data-testid="listing-settings-attention"
      data-state={content.state}
      className="mt-4 rounded-lg border border-zinc-200 bg-white p-4"
    >
      <h3 id={titleId} className="text-sm font-semibold text-zinc-900">{ATTENTION_STRIP_WORDS.title}</h3>
      {content.state === "loading" && (
        <div className="mt-2 space-y-2">
          <p className="text-sm text-zinc-600">{content.text}</p>
          <Skeleton className="h-4 w-2/3" />
        </div>
      )}
      {content.state === "failed" && (
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-zinc-700">{content.text}</p>
          <Button type="button" size="sm" variant="outline" className="shrink-0 self-start sm:self-auto" onClick={onRetry}>
            {content.retryLabel}
          </Button>
        </div>
      )}
      {content.state === "empty" && <p className="mt-2 text-sm text-emerald-800">{content.text}</p>}
      {content.state === "lines" && (
        <ul className="mt-2 divide-y divide-zinc-100">
          {content.lines.map((line) => (
            <AttentionLineItem key={line.key} line={line} onAction={onAction} portalHref={portalHref} />
          ))}
          {content.more && (
            <li className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between" data-testid="listing-settings-attention-more">
              <p className="text-sm text-zinc-700">{content.more.text}</p>
              <ActionButton action={content.more.action} onAction={onAction} portalHref={portalHref} />
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function AttentionLineItem({ line, onAction, portalHref }: {
  line: AttentionLine;
  onAction: AttentionStripProps["onAction"];
  portalHref: (path: string) => string;
}) {
  return (
    <li className="flex flex-col gap-2 py-2 sm:flex-row sm:items-start sm:justify-between" data-code={line.code}>
      <p className="flex min-w-0 items-start gap-2 text-sm text-zinc-800">
        <span aria-hidden="true" className="leading-5 text-amber-600">●</span>
        <span className="min-w-0 break-words">{line.text}</span>
      </p>
      <ActionButton action={line.action} onAction={onAction} portalHref={portalHref} />
    </li>
  );
}

function ActionButton({ action, onAction, portalHref }: {
  action: AttentionAction;
  onAction: AttentionStripProps["onAction"];
  portalHref: (path: string) => string;
}) {
  if (action.kind === "link") {
    const { link } = action;
    return (
      <Button asChild size="sm" variant="outline" className="shrink-0 self-start">
        {link.external
          ? <a href={link.href} target="_blank" rel="noreferrer">{link.label}</a>
          // A portal page (the store connection page) asks first when changes aren't saved.
          : <GuardedLink href={portalHref(link.href)}>{link.label}</GuardedLink>}
      </Button>
    );
  }
  return (
    <Button type="button" size="sm" variant="outline" className="shrink-0 self-start" onClick={() => onAction(action)}>
      {action.label}
    </Button>
  );
}
