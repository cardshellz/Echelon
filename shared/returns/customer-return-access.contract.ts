import { z } from "zod";
import { customerReturnFlowOrderSchema } from "./customer-return-flow.contract";

export const CUSTOMER_RETURNS_PAGE = "/customer-returns";
export const CUSTOMER_RETURNS_API = "/api/returns/customer";
export const CUSTOMER_RETURNS_SHOPIFY_PROXY = "/api/returns/shopify/proxy";
export const RETURN_CUSTOMER_SESSION_HEADER = "X-Return-Session";
export const customerReturnSessionStateSchema = z.object({
  authenticated: z.boolean(),
  privateTesting: z.boolean(),
  sessionKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/).nullable(),
}).strict();
export const customerReturnCustomerOrderSchema = z.object({
  omsOrderId: z.number().int().positive().safe(),
  order: customerReturnFlowOrderSchema,
  settingsVersion: z.number().int().positive().safe().nullable(),
}).strict();
export const customerReturnCustomerOrderPageSchema = z.object({
  orders: z.array(customerReturnCustomerOrderSchema).max(10),
  nextBeforeOmsOrderId: z.number().int().positive().safe().nullable(),
  unavailableOrderCount: z.number().int().nonnegative().max(10).default(0),
}).strict();
export type CustomerReturnCustomerOrder = z.infer<typeof customerReturnCustomerOrderSchema>;
