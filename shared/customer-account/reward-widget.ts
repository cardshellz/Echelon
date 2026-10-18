import { z } from "zod";
const decimal = z.string().regex(/^-?\d+(?:\.\d{1,2})?$/);
export const rewardWidgetScopeSchema = z
  .object({
    customerId: z.string().regex(/^gid:\/\/shopify\/Customer\/[1-9]\d*$/),
    channelId: z.number().int().positive().safe(),
  })
  .strict();
export const rewardWidgetIssueSchema = rewardWidgetScopeSchema
  .extend({
    points: z.number().int().positive().max(99_999_999),
    requestKey: z.string().uuid(),
  })
  .strict();
export const rewardWidgetStateSchema = z
  .object({
    version: z.literal("v1"),
    balance: decimal,
    minimumPoints: z.number().int().positive().safe(),
    pointsPerDollar: decimal,
    currencyName: z.string().min(1).max(100),
    rewards: z
      .array(
        z
          .object({
            code: z.string().min(1).max(255),
            value: decimal,
            expiresAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(50),
    pending: z
      .array(
        z
          .object({
            requestKey: z.string().uuid(),
            points: z.number().int().positive(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
export const rewardWidgetIssueResultSchema = z
  .object({
    code: z.string().min(1).max(255),
    value: decimal,
    expiresAt: z.string().datetime(),
    balance: decimal,
  })
  .strict();
export type RewardWidgetState = z.infer<typeof rewardWidgetStateSchema>;
export type RewardWidgetScope = z.infer<typeof rewardWidgetScopeSchema>;
export type RewardWidgetIssueResult = z.infer<
  typeof rewardWidgetIssueResultSchema
>;
