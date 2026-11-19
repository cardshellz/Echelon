import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { returnGuestLookupSchema, returnGuestVerifySchema, returnGuestProofSchema,
  returnGuestChallengeSchema, returnGuestSessionSchema, returnGuestAccountSchema } from "@shared/returns/customer-return-guest.contract";
import { CustomerReturnCustomerAccessError } from "./customer-return-customer-auth.service";
import { guestPurchaseSchema, type GuestChallenge, type GuestPurchaseGateway, type GuestVerificationStore, type GuestVerificationEmail } from "./customer-return-guest.ports";

export const RETURN_GUEST_CODE_LIFETIME_MS = 10 * 60_000;
export const RETURN_GUEST_GRANT_LIFETIME_MS = 30 * 60_000;
export function guestAccessError() {
  return new CustomerReturnCustomerAccessError("RETURN_GUEST_VERIFICATION_REQUIRED", "Enter the code from your email, or request a new code if it has expired.", 401);
}
export class CustomerReturnGuestService {
  private readonly secret: string;
  constructor(private readonly dependencies: { secret: string; store: GuestVerificationStore; purchases: GuestPurchaseGateway;
    email: GuestVerificationEmail; now: () => Date; randomId: () => string }) {
    this.secret = z.string().min(32).max(1024).parse(dependencies.secret);
  }
  private digest(purpose: string, value: unknown) {
    return createHmac("sha256", this.secret).update(JSON.stringify([purpose, value])).digest("base64url");
  }
  private now() {
    try {
      const value = z.date().parse(this.dependencies.now());
      if (value.getTime() < 0) throw new Error();
      return value;
    } catch {
      throw new CustomerReturnCustomerAccessError("RETURN_GUEST_CLOCK_UNAVAILABLE", "Guest verification is temporarily unavailable. Please try again.", 503);
    }
  }
  private code(challenge: GuestChallenge) {
    // Stable on retry, never stored in plaintext. Domain separation keeps this
    // short email code independent of the full-length access grant.
    const bytes = Buffer.from(this.digest("email-code", [challenge.id, challenge.browserHash]), "base64url");
    return String(bytes.readUInt32BE(0) % 100_000_000).padStart(8, "0");
  }
  async lookup(channelId: number, shopDomain: string, raw: unknown) {
    const input = returnGuestLookupSchema.parse(raw), now = this.now();
    const browserHash = this.digest("browser", input.browserKey);
    const inputHash = this.digest("lookup", [channelId, shopDomain, input.orderReference, input.email.toLowerCase()]);
    let challenge = await this.dependencies.store.read(input.requestKey, browserHash);
    if (challenge && challenge.inputHash !== inputHash) throw new CustomerReturnCustomerAccessError(
      "RETURN_GUEST_REQUEST_CONFLICT", "Start a new lookup when changing your order or email.", 409);
    if (!challenge) {
      const found = await this.dependencies.purchases.find(channelId, shopDomain, input.orderReference, input.email);
      const purchase = found === null ? null : guestPurchaseSchema.parse(found);
      if (purchase && (purchase.channelId !== channelId || purchase.shopDomain !== shopDomain
        || purchase.email.toLowerCase() !== input.email.toLowerCase())) throw guestAccessError();
      challenge = await this.dependencies.store.reserve({ id: input.requestKey, channelId, browserHash, inputHash,
        emailHash: this.digest("email", [channelId, input.email.toLowerCase()]), purchase, now,
        expiresAt: new Date(now.getTime() + RETURN_GUEST_CODE_LIFETIME_MS), verifiedAt: null });
    }
    if (challenge.inputHash !== inputHash || challenge.channelId !== channelId) throw guestAccessError();
    const token = z.string().uuid().parse(this.dependencies.randomId());
    const delivery = await this.dependencies.store.claimDelivery(challenge.id, browserHash, token, this.now());
    if (delivery?.purchase) {
      let delivered = false;
      try { await this.dependencies.email.send({ to: delivery.purchase.email, code: this.code(delivery), challengeId: delivery.id, expiresAt: delivery.expiresAt }); delivered = true; }
      catch { throw new CustomerReturnCustomerAccessError("RETURN_GUEST_EMAIL_UNAVAILABLE", "We couldn't confirm the email was sent. Please try again in a minute.", 503); }
      finally { await this.dependencies.store.finishDelivery(delivery.id, token, this.now(), delivered); }
    }
    // Same response for missing purchase, mismatched email and a real delivery.
    return returnGuestChallengeSchema.parse({ challengeId: challenge.id, expiresAt: challenge.expiresAt.toISOString() });
  }
  async verify(channelId: number, raw: unknown) {
    const input = returnGuestVerifySchema.parse(raw), browserHash = this.digest("browser", input.browserKey);
    const saved = await this.dependencies.store.read(input.challengeId, browserHash);
    if (!saved || saved.channelId !== channelId) throw guestAccessError();
    const correct = timingSafeEqual(Buffer.from(this.code(saved)), Buffer.from(input.code));
    const verified = await this.dependencies.store.verify(saved.id, browserHash, correct, this.now());
    if (!verified?.purchase || !verified.verifiedAt) throw guestAccessError();
    if (this.now().getTime() < verified.verifiedAt.getTime()) throw guestAccessError();
    if (!await this.dependencies.purchases.current(verified.purchase)) throw guestAccessError();
    const session = this.session(verified, input.browserKey);
    if (this.now().getTime() >= Date.parse(session.expiresAt)) throw guestAccessError();
    return session;
  }
  private session(challenge: GuestChallenge, browserKey: string) {
    if (!challenge.verifiedAt || !challenge.purchase) throw guestAccessError();
    return returnGuestSessionSchema.parse({ challengeId: challenge.id, browserKey,
      grant: this.digest("grant", [challenge.id, challenge.browserHash, challenge.verifiedAt.toISOString()]),
      sessionKey: this.digest("return-recovery", [challenge.channelId, challenge.purchase.omsOrderId, challenge.emailHash]),
      omsOrderId: challenge.purchase.omsOrderId,
      expiresAt: new Date(challenge.verifiedAt.getTime() + RETURN_GUEST_GRANT_LIFETIME_MS).toISOString() });
  }
  async authorize(channelId: number, raw: unknown) {
    const input = returnGuestProofSchema.parse(raw);
    const saved = await this.dependencies.store.read(input.challengeId, this.digest("browser", input.browserKey));
    if (!saved?.purchase || saved.channelId !== channelId || !saved.verifiedAt) throw guestAccessError();
    const session = this.session(saved, input.browserKey);
    if (this.now().getTime() < saved.verifiedAt.getTime() || this.now().getTime() >= Date.parse(session.expiresAt)
      || !timingSafeEqual(Buffer.from(input.grant), Buffer.from(session.grant))
      || !await this.dependencies.purchases.current(saved.purchase)) throw guestAccessError();
    // A provider read or a contended lock can outlive the credential. Recheck
    // at the boundary instead of granting the time at which the request began.
    if (this.now().getTime() < saved.verifiedAt.getTime() || this.now().getTime() >= Date.parse(session.expiresAt)) throw guestAccessError();
    return { purchase: saved.purchase, session };
  }
  async activate(channelId: number, raw: unknown) {
    const proof = returnGuestProofSchema.parse(raw);
    const { purchase, session } = await this.authorize(channelId, proof);
    try {
      const result = returnGuestAccountSchema.parse(await this.dependencies.store.account(proof.challengeId,
        this.digest("browser", proof.browserKey), this.now(), previous => this.dependencies.purchases.account(purchase, previous)));
      if (this.now().getTime() >= Date.parse(session.expiresAt)) throw guestAccessError();
      return result;
    } catch (error) {
      if (error instanceof CustomerReturnCustomerAccessError && error.code === "RETURN_GUEST_PURCHASE_UNAVAILABLE")
        throw new CustomerReturnCustomerAccessError("RETURN_GUEST_ACCOUNT_UNAVAILABLE", "You can continue your return as a guest. Account setup is temporarily unavailable.", 503);
      throw error;
    }
  }
  async logout(channelId: number, raw: unknown) {
    const proof = returnGuestProofSchema.parse(raw);
    const saved = await this.dependencies.store.read(proof.challengeId, this.digest("browser", proof.browserKey));
    if (saved && saved.channelId === channelId) {
      const expected = this.session(saved, proof.browserKey);
      if (!timingSafeEqual(Buffer.from(proof.grant), Buffer.from(expected.grant))) throw guestAccessError();
      await this.dependencies.store.revoke(saved.id, saved.browserHash, this.now());
    }
    return { ok: true as const };
  }
}
