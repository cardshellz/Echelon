import { DropshipError } from "./errors";

export class WalletDomain {
  /**
   * Deterministic evaluation defending against mathematically impossible bounds. 
   * Protects the application without risking unexpected SQL constraint crashing safely.
   */
  static evaluateDeduction(currentBalanceCents: number, deductionCents: number): number {
    if (!Number.isInteger(currentBalanceCents) || !Number.isInteger(deductionCents)) {
      throw new DropshipError("FLOATING_POINT_VIOLATION", "Ledger bounds natively require entirely typed integer evaluation execution.");
    }
    
    if (deductionCents < 0) {
      throw new DropshipError("INVALID_DEDUCTION", "Negative boundary limits cannot cleanly evaluate.");
    }

    const projectedBalance = currentBalanceCents - deductionCents;

    if (projectedBalance < 0) {
      throw new DropshipError("INSUFFICIENT_FUNDS", "Vendor Ledger lacks prerequisite bounds to definitively clear transaction execution.", { 
        currentBalanceCents, 
        requiredCents: deductionCents 
      });
    }

    return projectedBalance;
  }
}
