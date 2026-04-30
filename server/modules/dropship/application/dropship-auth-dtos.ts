import { z } from "zod";
import {
  DROPSHIP_PASSWORD_MAX_LENGTH,
  dropshipSensitiveActionEnum,
} from "../domain/auth";

const emailSchema = z.string().trim().email().max(255);
const idempotencyKeySchema = z.string().trim().min(16).max(200);
const verificationCodeSchema = z.string().trim().regex(/^[0-9]{6}$/);

export const startDropshipAccountBootstrapInputSchema = z.object({
  email: emailSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

export type StartDropshipAccountBootstrapInput = z.infer<
  typeof startDropshipAccountBootstrapInputSchema
>;

export const completeDropshipAccountBootstrapInputSchema = z.object({
  email: emailSchema,
  verificationCode: verificationCodeSchema,
  password: z.string().min(1).max(DROPSHIP_PASSWORD_MAX_LENGTH),
}).strict();

export type CompleteDropshipAccountBootstrapInput = z.infer<
  typeof completeDropshipAccountBootstrapInputSchema
>;

export const dropshipPasswordLoginInputSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(DROPSHIP_PASSWORD_MAX_LENGTH),
}).strict();

export type DropshipPasswordLoginInput = z.infer<typeof dropshipPasswordLoginInputSchema>;

export const startDropshipSensitiveActionChallengeInputSchema = z.object({
  action: z.enum(dropshipSensitiveActionEnum),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export type StartDropshipSensitiveActionChallengeInput = z.infer<
  typeof startDropshipSensitiveActionChallengeInputSchema
>;

export const verifyDropshipSensitiveActionChallengeInputSchema = z.object({
  action: z.enum(dropshipSensitiveActionEnum),
  verificationCode: verificationCodeSchema,
}).strict();

export type VerifyDropshipSensitiveActionChallengeInput = z.infer<
  typeof verifyDropshipSensitiveActionChallengeInputSchema
>;
