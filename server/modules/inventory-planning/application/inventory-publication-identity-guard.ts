import { eq } from "drizzle-orm";
import { inventoryAvailabilityRuntimeAuthority, inventoryPublicationTargets } from "@shared/schema";

export class LegacyChannelIdentityAuthorityError extends Error {}

/** Published owner guard: legacy repair cannot bypass canonical publication ownership. */
export async function assertLegacyChannelIdentityRepairAllowed(
  client: Pick<typeof import("../../../db").db, "select">,
  channelId: number,
): Promise<void> {
  const [runtime] = await client.select({ authority: inventoryAvailabilityRuntimeAuthority.authority })
    .from(inventoryAvailabilityRuntimeAuthority).where(eq(inventoryAvailabilityRuntimeAuthority.singletonKey, true)).for("share");
  if (runtime?.authority !== "legacy") throw new LegacyChannelIdentityAuthorityError("Legacy identity repair requires confirmed legacy publication authority");
  const targets = await client.select({ id: inventoryPublicationTargets.id, state: inventoryPublicationTargets.state }).from(inventoryPublicationTargets)
    .where(eq(inventoryPublicationTargets.channelId, channelId)).for("share");
  if (targets.some((target) => target.state === "active")) throw new LegacyChannelIdentityAuthorityError("Active canonical publication targets require their own identity revision workflow");
}
