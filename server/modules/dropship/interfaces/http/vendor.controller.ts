import { Request, Response } from "express";
import { OnboardingOrchestrator } from "../../application/onboardingOrchestrator";
import { DropshipError } from "../../domain/errors";

export class VendorController {
  
  /**
   * HTTP Interface Boundary for generating an initial vendor instantiation.
   */
  static async initiateOnboarding(req: Request, res: Response) {
    try {
      // 3) Data Integrity & Validation - Validate completely at HTTP boundary
      const { email, name, companyName, phone } = req.body;

      if (!email || !name) {
        return res.status(400).json({
          error: true,
          code: "MISSING_INPUT",
          message: "Email and name are strictly required parameters."
        });
      }

      // Delegate pure execution logic into central orchestrator
      const vendor = await OnboardingOrchestrator.onboardVendor(email, name, companyName, phone);

      return res.status(201).json({
        success: true,
        data: vendor
      });

    } catch (error: any) {
      if (error instanceof DropshipError) {
        // Map domain errors cleanly backwards to HTTP statuses without parsing nested logic
        const status = (error.code.includes("NOT_FOUND") || error.code.includes("TIER")) ? 403 : 400;
        return res.status(status).json(error.toJSON());
      }
      
      console.error("[VendorController] System Failure:", error);
      return res.status(500).json({
        error: true,
        code: "INTERNAL_ERROR",
        message: "A critical system fault aborted the onboarding cycle."
      });
    }
  }
}
