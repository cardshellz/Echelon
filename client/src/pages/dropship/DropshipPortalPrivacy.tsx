import { Link } from "wouter";
import { ShieldCheck } from "lucide-react";
import { dropshipPortalPath } from "@/lib/dropship-auth";

/**
 * The Dropship Portal privacy policy, served publicly (no sign-in) so that
 * vendors can read it before they link a store or a bank, and so that payment
 * providers reviewing our data use can open it.
 *
 * Every data category named here is one the portal actually stores, and every
 * processor named is one the portal actually calls. When the code changes what
 * it collects or who it sends data to, this page changes with it; the source
 * contract test pins the categories so the two cannot drift apart silently.
 */

/** The date the current wording took effect. Update it with every change to the text. */
export const PRIVACY_POLICY_EFFECTIVE_DATE = "September 21, 2026";

/** Where a vendor sends a privacy request. The support mailbox, not an individual. */
export const PRIVACY_CONTACT_EMAIL = "support@cardshellz.com";

const SECTION = "mt-8";
const H2 = "text-lg font-semibold text-zinc-950";
const P = "mt-2 text-sm leading-6 text-zinc-700";
const UL = "mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-zinc-700";

export default function DropshipPortalPrivacy() {
  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-[#C060E0] text-white">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <div className="text-base font-semibold">Card Shellz .ops</div>
            <div className="text-xs text-zinc-500">Dropship portal</div>
          </div>
        </div>

        <article className="mt-8 rounded-md border border-zinc-200 bg-white p-6 shadow-sm sm:p-8" data-testid="privacy-policy">
          <h1 className="text-2xl font-semibold tracking-normal">Privacy policy for the Dropship Portal</h1>
          <p className="mt-1 text-sm text-zinc-500">Effective {PRIVACY_POLICY_EFFECTIVE_DATE}</p>

          <p className={P}>
            This policy covers the Card Shellz Dropship Portal: the account you use as a Card Shellz .ops member to sell
            Card Shellz products through your own online store, fund a prepaid wallet, and have orders shipped to your
            customers. It explains what we collect, why, who we share it with, and what you can ask of us. It does not
            cover the Card Shellz retail store, which has its own policy.
          </p>

          <section className={SECTION}>
            <h2 className={H2}>What we collect</h2>
            <ul className={UL}>
              <li>
                <strong>Your account.</strong> The email, business name, contact name and phone number on your Card Shellz
                membership, and the status of that membership.
              </li>
              <li>
                <strong>Signing in.</strong> One-time codes we email you, a password if you set one, and passkeys if you
                register one. A passkey gives us a public key and a credential identifier only; your fingerprint or face
                never leaves your device. We keep a session cookie while you are signed in.
              </li>
              <li>
                <strong>Your store.</strong> Which platform it is on (Shopify or eBay), its identifier and display name, and
                the access tokens your platform issues us so we can read orders and update listings. Tokens are stored
                encrypted.
              </li>
              <li>
                <strong>Orders from your store.</strong> The order details your store sends us, including your customer's
                name, shipping address and contact details, because we ship the order on your behalf. We keep the order as
                your store sent it and a normalised copy we work from.
              </li>
              <li>
                <strong>Wallet and payment methods.</strong> We never store card numbers or bank account numbers. Stripe
                holds them. We store the identifiers Stripe gives us, the card brand and last four digits or the bank name
                and last four digits, whether a bank account is a business or personal account, and every movement in your
                wallet: top-ups, order charges, fees, refunds and reversals.
              </li>
              <li>
                <strong>Bank balance readings.</strong> When you link a bank account through Stripe and we are set up to read
                balances, we record the available balance Stripe reports when the account is linked and when Stripe
                refreshes it. We use it for one purpose: to decide whether an order may ship against a transfer from that
                account that has not yet landed. We do not show it to you and do not use it for anything else.
              </li>
              <li>
                <strong>USDC deposits.</strong> If you fund the wallet with USDC, the deposit address we assign you and the
                public blockchain records of transfers to it.
              </li>
              <li>
                <strong>Notifications.</strong> The emails and in-portal alerts we send you and your preferences for them.
              </li>
              <li>
                <strong>Technical records.</strong> Standard logs of requests made to the portal, kept to keep it secure and
                working.
              </li>
            </ul>
            <p className={P}>
              The portal runs no advertising or analytics trackers.
            </p>
          </section>

          <section className={SECTION}>
            <h2 className={H2}>Why we use it</h2>
            <ul className={UL}>
              <li>To run your wallet: take the top-ups you ask for, run the automatic top-ups you agreed to, and pay for orders from it.</li>
              <li>To accept, pack, ship and track the orders your store sends us, and to handle returns.</li>
              <li>To tell you what happened: an order accepted or held, a charge made, a transfer returned, a low balance.</li>
              <li>To keep your account secure and to detect and prevent fraud.</li>
              <li>To keep the financial records the law and our payment providers require.</li>
            </ul>
          </section>

          <section className={SECTION}>
            <h2 className={H2}>Who we share it with</h2>
            <p className={P}>
              Only companies that do work for us, and only what they need for that work. We do not sell your data and we
              do not share it with anyone for their own purposes.
            </p>
            <ul className={UL}>
              <li><strong>Stripe</strong> processes card and bank payments and links bank accounts. Stripe's own privacy policy governs what it holds.</li>
              <li><strong>Shopify or eBay</strong>, whichever runs your store, sends us your orders and receives our listing and tracking updates.</li>
              <li><strong>ShipStation</strong> produces shipping labels and tracking for your orders.</li>
              <li>The providers that host our servers, our database and our email delivery.</li>
              <li>Authorities or professional advisers where the law requires it.</li>
            </ul>
          </section>

          <section className={SECTION}>
            <h2 className={H2}>Where it is kept and for how long</h2>
            <p className={P}>
              Your data is stored in the United States. We keep it while your account is open. After it closes we keep the
              wallet ledger, order records and related payment records for as long as financial record-keeping rules require,
              and delete or anonymise the rest.
            </p>
          </section>

          <section className={SECTION}>
            <h2 className={H2}>Your choices</h2>
            <ul className={UL}>
              <li>You can see and change your account details, saved payment methods and notification preferences in the portal.</li>
              <li>You can disconnect your store or remove a payment method at any time, subject to the wallet terms you agreed to.</li>
              <li>You can ask us for a copy of your data, or ask us to delete it, by writing to {PRIVACY_CONTACT_EMAIL}. Records we must keep for financial or legal reasons are kept even after a deletion request, and we will tell you which.</li>
            </ul>
          </section>

          <section className={SECTION}>
            <h2 className={H2}>Security</h2>
            <p className={P}>
              Traffic to the portal is encrypted in transit. Store access tokens are encrypted at rest. Card and bank
              account numbers never touch our systems; they go directly to Stripe. Access to production data is limited to
              the people who operate the service.
            </p>
          </section>

          <section className={SECTION}>
            <h2 className={H2}>Changes</h2>
            <p className={P}>
              When this policy changes we update the effective date at the top of this page. A change that affects what we
              collect or who we share it with is also announced in the portal.
            </p>
          </section>

          <section className={SECTION}>
            <h2 className={H2}>Contact</h2>
            <p className={P}>
              Questions about this policy or about your data: <a className="text-[#8c35aa] underline" href={`mailto:${PRIVACY_CONTACT_EMAIL}`}>{PRIVACY_CONTACT_EMAIL}</a>.
            </p>
          </section>
        </article>

        <p className="mt-6 text-sm">
          <Link href={dropshipPortalPath("/login")} className="text-[#8c35aa] underline">Back to sign in</Link>
        </p>
      </div>
    </main>
  );
}
