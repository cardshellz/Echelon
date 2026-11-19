import { z } from "zod";
import { customerAccountBootstrapSchema } from "./customer-account.contract";
import { customerAccountOrderSummariesSchema } from "./customer-account-orders";
import { customerOrderActionPageSchema } from "./order-actions";

/** One authenticated local read supplies the initial account screen. */
export const customerAccountOverviewSchema = z
  .object({
    bootstrap: customerAccountBootstrapSchema,
    summaries: customerAccountOrderSummariesSchema,
    actions: customerOrderActionPageSchema,
  })
  .strict();
export type CustomerAccountOverview = z.infer<
  typeof customerAccountOverviewSchema
>;
