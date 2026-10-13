import { z } from "zod";
import { customerReturnSessionStateSchema, CUSTOMER_RETURNS_SHOPIFY_PROXY } from "../returns/customer-return-access.contract";
import { orderEditConnectionSchema } from "../order-edits/order-edit.contract";

export const CUSTOMER_ACCOUNT_PROXY_API = `${CUSTOMER_RETURNS_SHOPIFY_PROXY}/account`;
export const CUSTOMER_ACCOUNT_COMMAND_HEADER = "X-Customer-Account";
const externalId = z.string().max(30).regex(/^[1-9][0-9]*$/);
export const customerAccountRequestSchema = z.object({
  themeId: externalId,
  expectedCustomerId: externalId,
  method: z.enum(["GET", "POST"]),
  path: z.string().max(200).regex(/^\/(account|order-edits|returns)(\/[A-Za-z0-9-]+)*$/),
  query: z.record(z.string().max(1024)).default({}),
  body: z.unknown().optional(),
  commandKey: z.string().uuid().optional(),
  sessionKey: customerReturnSessionStateSchema.shape.sessionKey.optional(),
}).strict();
export type CustomerAccountRequest = z.infer<typeof customerAccountRequestSchema>;
export const customerAccountBootstrapSchema = z.object({
  session: customerReturnSessionStateSchema,
  connection: orderEditConnectionSchema,
}).strict();
export const customerAccountOrderIdentityInputSchema = z.object({
  orderReference: z.string().trim().min(1).max(50), externalOrderId: externalId,
}).strict();
export const customerAccountOrderIdentitySchema = z.object({
  omsOrderId: z.number().int().positive().safe(),
  connectionId: z.number().int().positive().safe(),
  externalOrderId: externalId,
}).strict();
