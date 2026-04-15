import { Request, Response } from "express";
import { WalletOrchestrator } from "../../application/walletOrchestrator";
import { DropshipError } from "../../domain/errors";

export class WalletController {
  
  static async requestCheckoutRouting(req: Request, res: Response) {
    try {
      const vendorId = req.vendor!.id;
      const { amountCents } = req.body;

      if (!amountCents) {
        return res.status(400).json({ error: true, code: "MISSING_DEPOSIT", message: "Deposit integer required securely." });
      }

      const checkoutUrl = await WalletOrchestrator.requestFundingNode(vendorId, parseInt(amountCents, 10));

      return res.status(200).json({
        success: true,
        checkoutUrl
      });
    } catch (error: any) {
      if (error instanceof DropshipError) return res.status(400).json(error.toJSON());
      return res.status(500).json({ error: true, code: "INTERNAL_ERROR", message: "Stripe hook collapsed." });
    }
  }

  static async fetchDashboardData(req: Request, res: Response) {
    try {
      const vendorId = req.vendor!.id;
      const data = await WalletOrchestrator.fetchDashboard(vendorId);

      return res.status(200).json({
        success: true,
        data
      });
    } catch (error: any) {
      return res.status(500).json({ error: true, code: "INTERNAL_ERROR", message: "Failed dashboard resolution smoothly." });
    }
  }
}
