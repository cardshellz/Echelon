import { DropshipError } from "./errors";

export type VendorTier = "standard" | "gold" | "pro" | "elite";
export type VendorStatus = "pending" | "active" | "suspended" | "closed";

export interface Vendor {
  id?: number;
  shellzClubMemberId: number;
  email: string;
  name: string;
  companyName: string | null;
  phone: string | null;
  status: VendorStatus;
  tier: VendorTier;
  stripeCustomerId: string | null;
  walletBalanceCents: number;
}

export class VendorEntity {
  /**
   * Domain rule: Vendor must hold an eligible Shellz Club membership.
   */
  static evaluateMembershipTier(planName: string, includesDropship: boolean, planTier: string): VendorTier {
    if (includesDropship === false && planTier !== "gold" && !planName.toLowerCase().includes("gold")) {
      throw new DropshipError(
        "INSUFFICIENT_MEMBERSHIP_TIER",
        "Dropship feature requires at least a Gold tier Shellz Club membership.",
        { planName, planTier }
      );
    }

    const plan = planName.toLowerCase();
    if (plan.includes("elite")) return "elite";
    if (plan.includes("pro")) return "pro";
    if (plan.includes("gold") || planTier === "gold") return "gold";

    return "standard";
  }

  /**
   * Domain rule: Validates the baseline shape of a vendor being onboarded.
   */
  static createNewVendor(
    memberId: number,
    email: string,
    name: string,
    tier: VendorTier,
    companyName: string | null,
    phone: string | null,
    stripeCustomerId: string | null
  ): Vendor {
    if (!email || !email.includes("@")) {
      throw new DropshipError("INVALID_INPUT", "Email format is invalid.", { email });
    }
    if (!name || name.trim() === "") {
      throw new DropshipError("INVALID_INPUT", "Name is required.", { name });
    }

    return {
      shellzClubMemberId: memberId,
      email: email.toLowerCase().trim(),
      name: name.trim(),
      companyName: companyName ? companyName.trim() : null,
      phone: phone ? phone.trim() : null,
      status: "pending", // Always starts pending until OAuth link and init completes
      tier,
      stripeCustomerId,
      walletBalanceCents: 0
    };
  }
}
