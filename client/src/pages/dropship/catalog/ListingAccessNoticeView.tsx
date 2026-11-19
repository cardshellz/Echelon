import { Link } from "wouter";
import { ArrowRight, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dropshipPortalPath } from "@/lib/dropship-auth";
import type { ListingAccessLink, ListingAccessNotice } from "@/lib/dropship-listing-access";

/**
 * What the account needs before listings can be checked or published, with the
 * one link that fixes it. `notice` reads as guidance; `error` follows a request
 * the server refused. Moved unchanged out of the Catalog page (step 1 plan S2-5
 * PR A) so step 3's PublishStep and step 2's notice share it; the page
 * re-exports it.
 */
export function ListingAccessNoticeView({
  notice,
  tone,
  portalHref = dropshipPortalPath,
}: {
  notice: ListingAccessNotice;
  tone: "notice" | "error";
  /** Resolves a portal route to its URL; injected in tests, which have no window. */
  portalHref?: (path: string) => string;
}) {
  const palette = tone === "error"
    ? "border-red-200 bg-red-50 text-red-900"
    : "border-amber-300 bg-amber-50 text-amber-900";
  return (
    <div role={tone === "error" ? "alert" : "status"} data-testid="listing-access-notice"
      className={`mt-4 rounded-md border p-4 text-sm ${palette}`}>
      <p>{notice.message}</p>
      {notice.link && <ListingAccessLinkButton link={notice.link} portalHref={portalHref} />}
    </div>
  );
}

function ListingAccessLinkButton({ link, portalHref }: { link: ListingAccessLink; portalHref: (path: string) => string }) {
  if (!link.external) {
    return (
      <Button asChild size="sm" variant="outline" className="mt-3 h-9 gap-2 bg-white">
        <Link href={portalHref(link.href)}>
          {link.label}
          <ArrowRight className="h-4 w-4" />
        </Link>
      </Button>
    );
  }
  // A mail link opens the mail client; only a web page gets a new tab.
  const opensPage = !link.href.startsWith("mailto:");
  return (
    <Button asChild size="sm" variant="outline" className="mt-3 h-9 gap-2 bg-white">
      <a href={link.href} {...(opensPage ? { target: "_blank", rel: "noreferrer" } : {})}>
        {link.label}
        {opensPage && <ExternalLink className="h-4 w-4" />}
      </a>
    </Button>
  );
}
