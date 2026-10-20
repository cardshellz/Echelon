import { z } from "zod";
import type { ListingIntentChangeStatus } from "@shared/listing-intent-propagation";

const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("channel"), channelId: z.number().int().positive().safe() }).strict(),
  z.object({ kind: z.literal("dropship"), storeConnectionId: z.number().int().positive().safe() }).strict(),
]);
export type ListingIntentChangeScope = z.infer<typeof scopeSchema>;
export function listingIntentChangesUrl(input: ListingIntentChangeScope): string {
  const scope = scopeSchema.parse(input);
  return scope.kind === "channel"
    ? `/api/channels/${scope.channelId}/listing-intent-changes`
    : `/api/dropship/listings/stores/${scope.storeConnectionId}/listing-intent-changes`;
}
export function listingIntentChangePresentation(row: Pick<ListingIntentChangeStatus,
  "state" | "can_retry" | "last_error_message">) {
  switch (row.state) {
    case "not_applicable": return { label: "No update required", attention: false, retry: false,
      message: row.last_error_message ?? "These members were excluded and their channel obligations were verified complete at the recorded check." };
    case "waiting_lifecycle": return { label: "Excluded - channel work pending", attention: true, retry: false,
      message: row.last_error_message ?? "Content updates are excluded. Stock clearing or removal still needs completion; automatic checks continue." };
    case "delivered": return { label: "Update requested", attention: false, retry: false,
      message: "An update was requested. Provider completion has not been confirmed here." };
    case "pending": return { label: "Update pending", attention: false, retry: false,
      message: row.last_error_message ?? "The saved change is waiting for an update to be requested." };
    case "needs_review": return { label: "Review required", attention: true, retry: false,
      message: row.last_error_message ?? "Review this change in the listing workspace before publishing." };
    case "blocked": return { label: "Needs attention", attention: true, retry: row.can_retry,
      message: row.last_error_message ?? "Correct the saved listing or connection issue before retrying." };
  }
}
