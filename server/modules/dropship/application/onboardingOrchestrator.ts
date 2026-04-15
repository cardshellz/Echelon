import { DropshipRepository } from "../infrastructure/dropship.repository";
import { StripeClient } from "../infrastructure/stripe.client";
import { VendorEntity, Vendor } from "../domain/vendor";
import { DropshipError } from "../domain/errors";

export class OnboardingOrchestrator {
  /**
   * Orchestrates the setup of a fresh Dropship Vendor Account from a standard Shellz Club membership.
   * Enforces rules from the Application layer, delegating exclusively to infrastructure/domain endpoints.
   */
  static async onboardVendor(
    email: string,
    name: string,
    companyName: string | null = null,
    phone: string | null = null
  ): Promise<Vendor> {
    
    // 1. Interface with Infrastructure: Pull verified identity mapping
    const memberDetails = await DropshipRepository.getMembershipDetailsByEmail(email);
    if (!memberDetails) {
      throw new DropshipError("MEMBER_NOT_FOUND", "No active Shellz Club membership found for this email.", { email });
    }

    // 2. Interface with Infrastructure: Prevent double insertions
    const holdsDropshipAccount = await DropshipRepository.vendorExists(email, memberDetails.id);
    if (holdsDropshipAccount) {
      throw new DropshipError("ACCOUNT_EXISTS", "A vendor account already exists under this membership.", { email });
    }

    // 3. Application > Domain: Evaluate Tier Eligibility
    const resolvedTier = VendorEntity.evaluateMembershipTier(
      memberDetails.planName, 
      memberDetails.includesDropship, 
      memberDetails.planTier
    );

    // 4. Application > Infrastructure: Setup Stripe 
    // Handled defensively. Will return null if it drops, preserving idempotency without failing the full sequence.
    const stripeId = await StripeClient.createCustomer(email, companyName || name);

    // 5. Application > Domain: Compile Entity
    const newVendorEntity = VendorEntity.createNewVendor(
      memberDetails.id,
      email,
      name,
      resolvedTier,
      companyName,
      phone,
      stripeId
    );

    // 6. Application > Infrastructure: Persist Deterministic Record
    const persistedVendor = await DropshipRepository.insertVendor(newVendorEntity);

    return persistedVendor;
  }
}
