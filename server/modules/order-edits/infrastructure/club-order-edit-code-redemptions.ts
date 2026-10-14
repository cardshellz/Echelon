import { z } from "zod";
import type { OrderEditCodeRedemptions } from "../application/order-edit-code-redemptions";
import { OrderEditProviderError } from "../application/order-edit-provider";

/** Finishes receipts created by the legacy integration; never validates new coupons. */
export class ClubOrderEditCodeRedemptions implements OrderEditCodeRedemptions {
  constructor(
    private readonly baseUrl: string | undefined,
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  available(): boolean {
    if (!this.baseUrl || !this.apiKey) return false;
    try {
      const url = new URL(this.baseUrl);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/"
      );
    } catch {
      return false;
    }
  }
  reserve(id: string) {
    return this.command(id, "reserve");
  }
  finalize(id: string) {
    return this.command(id, "finalize");
  }
  release(id: string) {
    return this.command(id, "release");
  }
  private command(id: string, action: string) {
    return this.request(`${z.string().uuid().parse(id)}/${action}`, {});
  }
  private async request(path: string, input: unknown): Promise<void> {
    if (!this.available())
      throw new OrderEditProviderError(
        "ORDER_EDIT_CODES_UNAVAILABLE",
        "Coupon and rewards codes are temporarily unavailable.",
      );
    let response: Response;
    try {
      response = await this.fetchImpl(
        new URL(`/api/internal/order-edit-codes/${path}`, this.baseUrl).href,
        {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(45_000),
        },
      );
      const body: unknown = await response.json();
      if (
        response.ok &&
        z
          .object({ ok: z.literal(true) })
          .strict()
          .safeParse(body).success
      )
        return;
      const failure = z
        .object({
          code: z.string().regex(/^ORDER_EDIT_[A-Z0-9_]+$/),
          message: z.string().min(1).max(1000),
        })
        .safeParse(body);
      if (failure.success)
        throw new OrderEditProviderError(
          failure.data.code,
          failure.data.message,
          response.status >= 500 ? "unknown" : "rejected",
        );
    } catch (error) {
      if (error instanceof OrderEditProviderError) throw error;
    }
    throw new OrderEditProviderError(
      "ORDER_EDIT_CODE_RESULT_UNCERTAIN",
      "The code result could not be verified. Check this order before trying again.",
      "unknown",
    );
  }
}
