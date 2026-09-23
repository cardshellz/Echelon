import { z } from "zod";
import {
  customerReturnFlowOrderSchema,
  customerReturnFlowReviewInputSchema,
  customerReturnFlowReviewSchema,
  customerReturnSourceRevisionSchema,
} from "./customer-return-flow.contract";

const channelIdSchema = z.number().int().positive().safe();
const liveSourceRevisionSchema = customerReturnSourceRevisionSchema.unwrap();

export const customerReturnLiveStateSchema = z.object({
  mode: z.literal("admin_live"),
  customerAccess: z.literal("disabled"),
  effects: z.literal("none"),
  shops: z.array(z.object({
    channelId: channelIdSchema,
    name: z.string().min(1).max(255),
  }).strict()).max(100),
}).strict();
export type CustomerReturnLiveState = z.infer<typeof customerReturnLiveStateSchema>;

export const customerReturnLiveLookupInputSchema = z.object({
  channelId: channelIdSchema,
  orderReference: z.string().min(1).max(256),
}).strict();
export type CustomerReturnLiveLookupInput = z.infer<typeof customerReturnLiveLookupInputSchema>;

export const customerReturnLiveOrderSchema = customerReturnFlowOrderSchema.extend({
  mode: z.literal("admin_live"),
  sourceRevision: liveSourceRevisionSchema,
}).strict();
export type CustomerReturnLiveOrder = z.infer<typeof customerReturnLiveOrderSchema>;

export const customerReturnLiveReviewInputSchema = customerReturnFlowReviewInputSchema.extend({
  channelId: channelIdSchema,
  sourceRevision: liveSourceRevisionSchema,
}).strict();
export type CustomerReturnLiveReviewInput = z.infer<typeof customerReturnLiveReviewInputSchema>;

export const customerReturnLiveReviewSchema = customerReturnFlowReviewSchema.extend({
  mode: z.literal("admin_live"),
  sourceRevision: liveSourceRevisionSchema,
}).strict();
export type CustomerReturnLiveReview = z.infer<typeof customerReturnLiveReviewSchema>;
