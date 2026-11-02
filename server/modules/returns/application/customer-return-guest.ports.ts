import { z } from "zod";
import { customerReturnCanonicalOrderScopeSchema } from "./customer-return-order-access.service";

export const guestPurchaseSchema = customerReturnCanonicalOrderScopeSchema.extend({
  verifiedPurchase: customerReturnCanonicalOrderScopeSchema.shape.verifiedPurchase.unwrap(),
  shopDomain: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
  email: z.string().email().max(254),
}).strict().refine(value => value.email.toLowerCase() === value.verifiedPurchase.email.toLowerCase(), "Verified purchase email must match its delivery address.");
export type GuestPurchase = z.infer<typeof guestPurchaseSchema>;
export interface GuestPurchaseGateway {
  /** Exact channel + order aliases, followed by an authoritative Shopify read.
   * No access is granted by the email entered on the form. */
  find(channelId: number, shopDomain: string, reference: string, email: string): Promise<GuestPurchase | null>;
  /** Recheck the same Shopify order, email and customer link, never search by email. */
  current(purchase: GuestPurchase): Promise<boolean>;
  account(purchase: GuestPurchase, previous?: { kind: "activate" | "sign_in" | "register"; url: string } | null): Promise<{ kind: "activate" | "sign_in" | "register"; url: string }>;
}
export interface GuestChallenge {
  id: string; channelId: number; browserHash: string; inputHash: string; emailHash: string;
  purchase: GuestPurchase | null; expiresAt: Date; verifiedAt: Date | null;
}
export interface GuestVerificationStore {
  reserve(input: GuestChallenge & { now: Date }): Promise<GuestChallenge>;
  read(id: string, browserHash: string): Promise<GuestChallenge | null>;
  claimDelivery(id: string, browserHash: string, token: string, now: Date): Promise<GuestChallenge | null>;
  finishDelivery(id: string, token: string, now: Date, delivered: boolean): Promise<void>;
  /** Wrong attempts must commit. Concurrent correct submissions share one grant. */
  verify(id: string, browserHash: string, correct: boolean, now: Date): Promise<GuestChallenge | null>;
  revoke(id: string, browserHash: string, now: Date): Promise<void>;
  account(id: string, browserHash: string, now: Date, build: (previous: { kind: "activate" | "sign_in" | "register"; url: string } | null) => Promise<{ kind: "activate" | "sign_in" | "register"; url: string }>): Promise<{ kind: "activate" | "sign_in" | "register"; url: string }>;
}
export interface GuestVerificationEmail {
  send(input: { to: string; code: string; challengeId: string; expiresAt: Date }): Promise<void>;
}
