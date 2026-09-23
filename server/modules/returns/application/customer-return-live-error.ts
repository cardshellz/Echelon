export class CustomerReturnLiveError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "CustomerReturnLiveError";
  }
}

export function returnEvidenceUnresolved(): never {
  throw new CustomerReturnLiveError("RETURN_LIVE_EVIDENCE_UNRESOLVED",
    "This order needs return-history verification before its available quantities can be shown.", 409);
}
