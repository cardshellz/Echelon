import type { ChannelListingWarning } from "@shared/channel-listing-validation";

/** One presentation for durable package warnings in feed rows and job details. */
export function ChannelListingWarnings({ warnings }: { warnings?: readonly ChannelListingWarning[] }) {
  if (!warnings?.length) return null;
  return <section aria-label="Listing warnings" className="text-xs text-amber-700 dark:text-amber-400 space-y-1">
    {warnings.map(warning => <p key={`${warning.code}:${warning.variantId}`} className="break-words">
      {warning.variantSku}: package dimensions are missing. Shipping estimates may be inaccurate.{" "}
      <a className="underline" href={`/products/${warning.productId}?tab=variants&variantId=${warning.variantId}`}
        onClick={event => event.stopPropagation()}>Edit package dimensions</a>
    </p>)}
  </section>;
}
