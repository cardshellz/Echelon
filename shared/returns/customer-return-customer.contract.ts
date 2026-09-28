import { z } from "zod";
import {
  customerReturnLabelStatusSchema,
  customerReturnLabelSubmitInputSchema,
} from "./customer-return-label.contract";

export const CUSTOMER_RETURN_CUSTOMER_API = "/api/returns/customer";

/** Channel, customer and display reference are resolved by the server. */
export const customerReturnCustomerSubmitInputSchema = customerReturnLabelSubmitInputSchema
  .omit({ channelId: true, orderReference: true }).strict();
export type CustomerReturnCustomerSubmitInput = z.infer<typeof customerReturnCustomerSubmitInputSchema>;

const customerParcelStatusSchema = customerReturnLabelStatusSchema.shape.parcels.element
  .extend({
    downloadPath: z.string().max(300)
      .regex(/^\/api\/returns\/customer\/returns\/[1-9]\d*\/parcels\/[1-9]\d*\/download$/)
      .nullable(),
  }).strict();

/** Provider URLs and private administrator routes never cross this boundary. */
export const customerReturnCustomerLabelStatusSchema = customerReturnLabelStatusSchema
  .omit({ channelId: true })
  .extend({ parcels: z.array(customerParcelStatusSchema).min(1).max(20) }).strict();
export type CustomerReturnCustomerLabelStatus = z.infer<typeof customerReturnCustomerLabelStatusSchema>;

export const customerReturnCustomerHistoryInputSchema = z.object({
  beforeAuthorizationId: z.number().int().positive().safe().optional(),
  pageSize: z.number().int().min(1).max(20).default(10),
}).strict();
export const customerReturnCustomerHistoryItemSchema = z.object({
  authorizationId: z.number().int().positive().safe(),
  authorizationNumber: z.string().min(1).max(32),
  omsOrderId: z.number().int().positive().safe(),
  orderReference: z.string().min(1).max(100).nullable(),
  createdAt: z.string().datetime({ offset: true }),
}).strict();
export const customerReturnCustomerHistorySchema = z.object({
  returns: z.array(customerReturnCustomerHistoryItemSchema).max(20),
  nextBeforeAuthorizationId: z.number().int().positive().safe().nullable(),
}).strict();
