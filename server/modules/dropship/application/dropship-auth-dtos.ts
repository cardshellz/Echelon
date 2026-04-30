import { z } from "zod";
import {
  DROPSHIP_PASSWORD_MAX_LENGTH,
  dropshipSensitiveActionEnum,
} from "../domain/auth";

const emailSchema = z.string().trim().email().max(255);
const idempotencyKeySchema = z.string().trim().min(16).max(200);
const verificationCodeSchema = z.string().trim().regex(/^[0-9]{6}$/);
const base64UrlSchema = z.string().trim().min(1).regex(/^[A-Za-z0-9_-]+$/);

const webAuthnClientExtensionResultsSchema = z.record(z.unknown()).default({});

export const dropshipPasskeyRegistrationResponseSchema = z.object({
  id: base64UrlSchema,
  rawId: base64UrlSchema,
  type: z.literal("public-key"),
  authenticatorAttachment: z.string().optional(),
  clientExtensionResults: webAuthnClientExtensionResultsSchema,
  response: z.object({
    clientDataJSON: base64UrlSchema,
    attestationObject: base64UrlSchema,
    authenticatorData: base64UrlSchema.optional(),
    transports: z.array(z.string()).optional(),
    publicKeyAlgorithm: z.number().optional(),
    publicKey: base64UrlSchema.optional(),
  }).strict(),
}).strict();

export type DropshipPasskeyRegistrationResponse = z.infer<
  typeof dropshipPasskeyRegistrationResponseSchema
>;

export const dropshipPasskeyAuthenticationResponseSchema = z.object({
  id: base64UrlSchema,
  rawId: base64UrlSchema,
  type: z.literal("public-key"),
  authenticatorAttachment: z.string().optional(),
  clientExtensionResults: webAuthnClientExtensionResultsSchema,
  response: z.object({
    clientDataJSON: base64UrlSchema,
    authenticatorData: base64UrlSchema,
    signature: base64UrlSchema,
    userHandle: base64UrlSchema.optional(),
  }).strict(),
}).strict();

export type DropshipPasskeyAuthenticationResponse = z.infer<
  typeof dropshipPasskeyAuthenticationResponseSchema
>;

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

export const startDropshipPasskeyLoginInputSchema = z.object({
  email: emailSchema.optional(),
}).strict();

export type StartDropshipPasskeyLoginInput = z.infer<typeof startDropshipPasskeyLoginInputSchema>;

export const completeDropshipPasskeyLoginInputSchema = z.object({
  response: dropshipPasskeyAuthenticationResponseSchema,
}).strict();

export type CompleteDropshipPasskeyLoginInput = z.infer<
  typeof completeDropshipPasskeyLoginInputSchema
>;

export const completeDropshipPasskeyRegistrationInputSchema = z.object({
  response: dropshipPasskeyRegistrationResponseSchema,
}).strict();

export type CompleteDropshipPasskeyRegistrationInput = z.infer<
  typeof completeDropshipPasskeyRegistrationInputSchema
>;

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

export const startDropshipSensitiveActionPasskeyInputSchema = z.object({
  action: z.enum(dropshipSensitiveActionEnum),
}).strict();

export type StartDropshipSensitiveActionPasskeyInput = z.infer<
  typeof startDropshipSensitiveActionPasskeyInputSchema
>;

export const verifyDropshipSensitiveActionPasskeyInputSchema = z.object({
  action: z.enum(dropshipSensitiveActionEnum),
  response: dropshipPasskeyAuthenticationResponseSchema,
}).strict();

export type VerifyDropshipSensitiveActionPasskeyInput = z.infer<
  typeof verifyDropshipSensitiveActionPasskeyInputSchema
>;
