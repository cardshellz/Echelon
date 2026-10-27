import { parseArgs } from "node:util";
import { z } from "zod";
import { orderActionMaintenanceIdsSchema } from "../../server/modules/customer-account/application/order-action-projection.ports";

const optionsSchema = z.object({
  orderIds: orderActionMaintenanceIdsSchema,
  actor: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,99}$/),
  passes: z.coerce.number().int().min(1).max(10),
  execute: z.boolean(),
}).strict();

/** Explicit scope only. Omitting IDs can never start a whole-store inspection. */
export function parseOrderActionWarmOptions(args: string[]) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    "order-id": { type: "string", multiple: true }, actor: { type: "string" },
    passes: { type: "string", default: "10" }, execute: { type: "boolean", default: false },
  } });
  return optionsSchema.parse({ orderIds: values["order-id"]?.map(value => /^\d+$/.test(value) ? Number(value) : NaN),
    actor: values.actor, passes: values.passes, execute: values.execute });
}
