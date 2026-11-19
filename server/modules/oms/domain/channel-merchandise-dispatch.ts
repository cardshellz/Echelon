import { z } from "zod";
import type { ShopifyMerchandiseSnapshot } from "../infrastructure/shopify-merchandise-snapshot";

const quantity = z.coerce.number().int().min(0).max(2_147_483_647);
const linesSchema = z.array(
  z.object({
    externalLineItemId: z.string(),
    paidQuantity: quantity,
    authorityFulfillableQuantity: quantity,
    channelCurrentQuantity: quantity.nullable(),
    channelQuantityUpdatedAt: z.coerce.date().nullable(),
  }),
);
const nativeId = (value: string) =>
  value.replace(/^gid:\/\/shopify\/(Order|LineItem)\//, "");

/** Native quantities and prior paid permission are independent facts. This
 * validates them; it never grants payment authority or infers a cancellation. */
export function assertChannelMerchandiseDispatchQuantities(input: {
  orderId: string;
  snapshot: ShopifyMerchandiseSnapshot;
  lines: unknown;
  requireDispatchPermission?: boolean;
}): void {
  const pending = () =>
    Object.assign(
      new Error(
        "Waiting for verified channel quantities and prior payment authority.",
      ),
      { code: "CHANNEL_MERCHANDISE_INGEST_PENDING" },
    );
  if (nativeId(input.snapshot.orderId) !== nativeId(input.orderId))
    throw pending();
  const lines = linesSchema.parse(input.lines);
  const byId = new Map(
    lines.map((line) => [nativeId(line.externalLineItemId), line]),
  );
  if (byId.size !== lines.length) throw pending();
  for (const native of input.snapshot.lines) {
    const line = byId.get(nativeId(native.id));
    if (
      !line ||
      line.channelCurrentQuantity !== native.currentQuantity ||
      line.channelQuantityUpdatedAt === null ||
      line.channelQuantityUpdatedAt > new Date(input.snapshot.updatedAt) ||
      line.authorityFulfillableQuantity > native.currentQuantity ||
      line.paidQuantity < native.currentQuantity ||
      (input.requireDispatchPermission &&
        line.authorityFulfillableQuantity !== native.currentQuantity)
    )
      throw pending();
    byId.delete(nativeId(native.id));
  }
  if ([...byId.values()].some((line) => line.authorityFulfillableQuantity > 0))
    throw pending();
  if (
    input.requireDispatchPermission &&
    !input.snapshot.lines.some((line) => line.unfulfilledQuantity > 0)
  )
    throw pending();
}
