// Stage 2 (step 1 plan S2-5)
/**
 * The vendor's words the catalog reads and the selection save send in PR A
 * (§4.8, §4.9, §4.11, §4.12). Every string here is PROPOSED: new in stage 2
 * and kept in this one file so a later change edits one place. `retired` and
 * `siteUpdating` match the page's words of the same name (PR A3).
 */
export const CATALOG_READ_WORDS = {
  /** retired: the rules save once B froze the rules table (CHK9). */
  retired: "This page was updated, so your last changes weren't saved. Reload it and make them again.",
  /** A catalog read from a page newer than this server (CHK7): the page tries again by itself. */
  pageNewerThanServer: "Card Shellz is updating the site. This page will try again in a moment; nothing you did is lost.",
  /** An unknown query value (never a fallback). */
  queryInvalid: "This catalog request was not valid. Reload the page and try again.",
  /** The id list a "check all" or "uncheck all" needs is over the cap. */
  idsTooMany: "More than 10,000 items match. Narrow the list, then try again.",
  /** A selection save key in the prefix B's release uses. */
  keyReserved: "This request key is reserved. Send a different Idempotency-Key.",
  /** A store that is not one of the vendor's. */
  storeRequired: "That store was not found. Reload the page and choose a store.",
  /** A member's catalog read budget for the minute is spent. */
  rateLimited: "Too many catalog requests in a minute. Wait a moment and try again.",
} as const;
