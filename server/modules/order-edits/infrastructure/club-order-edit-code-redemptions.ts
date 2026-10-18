import { z } from "zod";
import type { OrderEditCodeRedemptions } from "../application/order-edit-code-redemptions";
import { OrderEditProviderError } from "../application/order-edit-provider";
import type { OrderEditRewards } from "../application/order-edit-rewards";
import { orderEditCodeRuleSchema } from "@shared/order-edits/order-edit-codes";
import { rewardWidgetScopeSchema, rewardWidgetIssueSchema, rewardWidgetStateSchema, rewardWidgetIssueResultSchema } from "@shared/customer-account/reward-widget";
import type { CustomerRewards } from "../../customer-account/application/customer-rewards";

/** Club's existing issuance and receipt service; ordinary coupons never use it. */
export class ClubOrderEditCodeRedemptions implements OrderEditCodeRedemptions, OrderEditRewards, CustomerRewards {
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
  async state(input: Parameters<CustomerRewards["state"]>[0]) {
    return rewardWidgetStateSchema.parse(await this.request("rewards/state", rewardWidgetScopeSchema.parse(input), true));
  }
  async issue(input: Parameters<CustomerRewards["issue"]>[0]) {
    return rewardWidgetIssueResultSchema.parse(await this.request("rewards/issue", rewardWidgetIssueSchema.parse(input), true));
  }
  reserve(id: string) {
    return this.command(id, "reserve");
  }
  async identify(input: { customerId: string; codes: string[] }): Promise<string[]> {
    const checked = z.object({ customerId: z.string().regex(/^gid:\/\/shopify\/Customer\/[1-9]\d*$/),
      codes: z.array(z.string().trim().min(1).max(255)).min(1).max(5) }).strict().parse(input);
    return z.object({ codes: z.array(z.string()).max(5) }).strict().parse(await this.request("identify", checked, true)).codes;
  }
  verify(input: Parameters<OrderEditRewards["verify"]>[0]): Promise<void> {
    const checked = z.object({
      customerId: z.string().regex(/^gid:\/\/shopify\/Customer\/[1-9]\d*$/),
      orderId: z.string().regex(/^gid:\/\/shopify\/Order\/[1-9]\d*$/),
      rules: z.array(orderEditCodeRuleSchema.refine((rule) => rule.redemption === "club_reward")).min(1).max(5),
    }).strict().parse(input);
    return this.request("validate", checked).then(() => undefined);
  }
  finalize(id: string) {
    return this.command(id, "finalize");
  }
  release(id: string) {
    return this.command(id, "release");
  }
  private command(id: string, action: string) {
    return this.request(`${z.string().uuid().parse(id)}/${action}`, {}).then(() => undefined);
  }
  private async request(path: string, input: unknown, result = false): Promise<unknown> {
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
      if (response.ok && result) return body;
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
          code: z.string().regex(/^(ORDER_EDIT|REWARD)_[A-Z0-9_]+$/),
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
