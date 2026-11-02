import { z } from "zod";
import { CUSTOMER_RETURNS_SHOPIFY_PROXY } from "./customer-return-access.contract";

export const RETURN_GUEST_PROXY_API = `${CUSTOMER_RETURNS_SHOPIFY_PROXY}/guest`;
export const returnGuestBrowserSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const returnGuestLookupSchema = z.object({
  requestKey: z.string().uuid(), browserKey: returnGuestBrowserSchema,
  orderReference: z.string().trim().min(1).max(100), email: z.string().trim().email().max(254),
}).strict();
export const returnGuestVerifySchema = z.object({
  challengeId: z.string().uuid(), browserKey: returnGuestBrowserSchema, code: z.string().regex(/^\d{8}$/),
}).strict();
export const returnGuestProofSchema = z.object({
  challengeId: z.string().uuid(), browserKey: returnGuestBrowserSchema, grant: returnGuestBrowserSchema,
}).strict();
export const returnGuestChallengeSchema = z.object({ challengeId: z.string().uuid(), expiresAt: z.string().datetime() }).strict();
export const returnGuestSessionSchema = z.object({
  ...returnGuestProofSchema.shape, omsOrderId: z.number().int().positive().safe(),
  sessionKey: returnGuestBrowserSchema, expiresAt: z.string().datetime(),
}).strict();
export const returnGuestAccountSchema = z.object({
  kind: z.enum(["activate", "sign_in", "register"]), url: z.string().url().max(2048).refine(value => {
    try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.hash; }
    catch { return false; }
  }),
}).strict();
export type ReturnGuestSession = z.infer<typeof returnGuestSessionSchema>;
