import { AlertCircle, ArrowRight, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dropshipPortalPath } from "@/lib/dropship-auth";
import type { ListingAccessLink } from "@/lib/dropship-listing-access";
import type { ConnectionBanner } from "@/lib/dropship-listing-settings-access";
import { connectionBannerWords } from "@/lib/dropship-listing-settings-words";
import { GuardedLink } from "../catalog/UnsavedChangesGuard";

export interface ConnectionBannerViewProps {
  /** The one banner `chooseConnectionBanner` picked (plan 4.4). */
  banner: ConnectionBanner;
  storeName: string;
  /** [Try again] (`unreachable`): read the eBay setup and the store shelves again. */
  onRetry: () => void;
  /** [Go to step 1] (`too_large`). The step asks first when changes aren't saved. */
  onGoToStep1: () => void;
  /** While the reads [Try again] started are running: the button is off. */
  retrying?: boolean;
  /** Resolves a portal route to its URL; injected in tests, which have no window. */
  portalHref?: (path: string) => string;
}

/**
 * The step's one connection banner (R:88, R:500-507, R:521): what eBay or the
 * account needs, and the one button that fixes it. The button sits under the
 * words on a phone and beside them from 640 px. A link to another portal page
 * asks first when changes aren't saved.
 */
export function ConnectionBannerView({ banner, storeName, onRetry, onGoToStep1, retrying = false, portalHref = dropshipPortalPath }: ConnectionBannerViewProps) {
  const words = connectionBannerWords(banner, storeName);
  const action = words.action;
  return (
    <div
      role="status"
      data-testid="listing-settings-banner"
      data-kind={banner.kind}
      className="mt-4 flex flex-col gap-3 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 sm:flex-row sm:items-start sm:justify-between"
    >
      <div className="flex min-w-0 items-start gap-2">
        <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <p className="min-w-0 break-words">{words.message}</p>
      </div>
      <div className="shrink-0">
        {action.kind === "link" && <BannerLink link={action.link} portalHref={portalHref} />}
        {action.kind === "retry" && (
          <Button type="button" size="sm" variant="outline" className="bg-white" disabled={retrying} onClick={onRetry}>
            {action.label}
          </Button>
        )}
        {action.kind === "go_to_step_1" && (
          <Button type="button" size="sm" variant="outline" className="gap-2 bg-white" onClick={onGoToStep1}>
            {action.label}
            <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

function BannerLink({ link, portalHref }: { link: ListingAccessLink; portalHref: (path: string) => string }) {
  if (!link.external) {
    return (
      <Button asChild size="sm" variant="outline" className="gap-2 bg-white">
        <GuardedLink href={portalHref(link.href)}>
          {link.label}
          <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </GuardedLink>
      </Button>
    );
  }
  // A mail link opens the mail client and leaves the page as it is; only a web page gets a new tab.
  const opensPage = !link.href.startsWith("mailto:");
  return (
    <Button asChild size="sm" variant="outline" className="gap-2 bg-white">
      <a href={link.href} {...(opensPage ? { target: "_blank", rel: "noreferrer" } : {})}>
        {link.label}
        {opensPage && <ExternalLink aria-hidden="true" className="h-4 w-4" />}
      </a>
    </Button>
  );
}
