/**
 * An order line parked on an eBay item number Card Shellz does not know, whose
 * custom label is one of the store's listings (plan v4 §7.3 steps 3-4). The
 * poll marks the candidate listing due; the sweep then reads Card Shellz's own
 * offer for it, which relinks the listing when eBay moved it to a new item
 * number. Pure: the caller passes what is known now.
 */
export interface ParkedOrderLineFacts {
  externalListingId: string;
  /** Null when the candidate listing was deleted (the foreign key sets it null). */
  candidateListingId: number | null;
  /** The candidate's item number now. */
  candidateExternalListingId: string | null;
  /** Whether the candidate had the parked number before a relist (a recorded previous number). */
  candidateHadItemNumber: boolean;
  /** When the sweep last read the candidate's eBay listing; null while it is due. */
  candidateReadAt: Date | null;
  firstSeenAt: Date;
}

/**
 * - `release`: the number is proven the candidate's (it shows it now, or had
 *   it): the order is read again and taken in.
 * - `ask_vendor`: the sweep read the candidate after the line was parked and
 *   did not prove it (or the candidate is gone): the vendor is asked once per
 *   item. The line stays parked until it is proven, cancelled or expires.
 * - `wait`: the sweep has not read the candidate yet.
 */
export function decideParkedOrderLine(line: ParkedOrderLineFacts): "release" | "ask_vendor" | "wait" {
  if (line.candidateListingId === null) return "ask_vendor";
  if (line.candidateExternalListingId === line.externalListingId || line.candidateHadItemNumber) return "release";
  if (line.candidateReadAt !== null && line.candidateReadAt.getTime() > line.firstSeenAt.getTime()) return "ask_vendor";
  return "wait";
}
