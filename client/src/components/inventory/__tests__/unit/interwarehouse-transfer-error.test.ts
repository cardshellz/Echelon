import { describe, expect, it } from "vitest";

import { FinancialCommandRequestError } from "@/lib/financial-command";
import { describeInterwarehouseActionError } from "../../InterwarehouseTransferQueue";

describe("inter-warehouse transfer action errors", () => {
  it("refreshes an ambiguous transfer instead of claiming the receipt failed", () => {
    const error = new FinancialCommandRequestError("The server returned HTTP 500", {
      status: 500,
      code: "INTERWAREHOUSE_TRANSFER_FAILED",
      retryable: true,
      ambiguous: true,
    });

    expect(describeInterwarehouseActionError(error)).toEqual({
      title: "Transfer status not confirmed",
      description: "The transfer list is refreshing. If the units still show in transit, open the transfer and retry; the saved command will be reused safely.",
      refreshTransfer: true,
    });
  });

  it("preserves an actionable rejection from the server", () => {
    expect(describeInterwarehouseActionError(new Error("Only 4 units remain in transit."))).toEqual({
      title: "Transfer action failed",
      description: "Only 4 units remain in transit.",
      refreshTransfer: false,
    });
  });
});
