import { z } from "zod";

export const channelListingSelectionFactsSchema = z.object({
  active: z.boolean(),
  included: z.boolean(),
  configured: z.boolean(),
  explicitlySelected: z.boolean(),
  hasRetainedIdentity: z.boolean(),
  hasSavedWork: z.boolean(),
}).strict();
export type ChannelListingSelectionFacts = z.infer<typeof channelListingSelectionFactsSchema>;

/** The workspace and bulk command share this decision. Adapters describe what
 * constitutes channel configuration; saved work grants visibility, never new
 * publication authority. Archived/excluded identities remain reviewable. */
export function selectChannelListing(input: ChannelListingSelectionFacts) {
  const facts = channelListingSelectionFactsSchema.parse(input);
  const selected = facts.configured || facts.explicitlySelected || facts.hasRetainedIdentity;
  return {
    visible: (facts.active && facts.configured) || facts.explicitlySelected || facts.hasRetainedIdentity || facts.hasSavedWork,
    syncIncluded: facts.active && facts.included && selected,
  };
}
