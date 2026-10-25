import { describe, expect, it, vi } from "vitest";
import { ShopifyOrderEditProvider } from "../../infrastructure/shopify-order-edit.provider";
const operation = "11111111-1111-4111-8111-111111111111",
  jobId = "gid://shopify/OrderCancelJobResult/1";
function fixture(
  result: unknown = {
    jobResult: { id: jobId, done: false },
    orderCancelUserErrors: [],
    userErrors: [],
  },
) {
  const request = vi.fn(
    async () =>
      new Response(JSON.stringify({ data: { orderCancel: result } }), {
        status: 200,
      }),
  );
  const provider = new ShopifyOrderEditProvider({
    clock: () => new Date("2026-10-22T12:00:00Z"),
    credentials: {
      get: vi.fn(async () => ({
        connectionId: 4,
        channelId: 36,
        shopDomain: "example.myshopify.com",
        accessToken: "fixture-only",
      })),
    },
    fetch: request,
  });
  return { provider, request };
}
describe("native full-order cancellation adapter", () => {
  it("uses one native cancellation job with original-payment refunds and restocking", async () => {
    const h = fixture();
    expect(await h.provider.cancelOrder(4, "1", operation)).toEqual({
      jobId,
      done: false,
    });
    const [url, init] = h.request.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(String(init.body));
    expect(url).toContain("/admin/api/2026-10/graphql.json");
    expect(body.variables).toEqual({
      id: "gid://shopify/Order/1",
      note: `Customer cancellation ${operation}`,
    });
    expect(body.query).toContain("originalPaymentMethodsRefund: true");
    expect(body.query).toContain("restock: true");
    expect(body.query).not.toMatch(/refundCreate|orderEditCommit/);
    expect(h.request).toHaveBeenCalledTimes(1);
  });
  it.each([
    [
      {
        jobResult: null,
        orderCancelUserErrors: [{ message: "Unavailable", field: [] }],
        userErrors: [],
      },
      "rejected",
    ],
    [{ jobResult: null, orderCancelUserErrors: [], userErrors: [] }, "unknown"],
    [
      {
        jobResult: { id: jobId, done: false },
        orderCancelUserErrors: [{ message: "Conflict", field: [] }],
        userErrors: [],
      },
      "unknown",
    ],
    [null, "unknown"],
  ])(
    "classifies rejection versus uncertain provider outcome",
    async (result, outcome) => {
      const h = fixture(result);
      await expect(
        h.provider.cancelOrder(4, "1", operation),
      ).rejects.toMatchObject({ outcome });
      expect(h.request).toHaveBeenCalledTimes(1);
    },
  );
  it("observes only the matching job and never resends cancellation on an unknown response", async () => {
    const h = fixture();
    h.request.mockImplementationOnce(async () => {
      throw new Error("lost response");
    });
    await expect(
      h.provider.cancelOrder(4, "1", operation),
    ).rejects.toMatchObject({ outcome: "unknown" });
    expect(h.request).toHaveBeenCalledTimes(1);
    h.request.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            node: {
              id: jobId,
              __typename: "OrderCancelJobResult",
              done: true,
              status: "SUCCEEDED",
              errors: [],
              order: { id: "gid://shopify/Order/1" },
            },
          },
        }),
      ),
    );
    expect(await h.provider.cancellationJob(4, jobId)).toEqual({
      done: true,
      failed: false,
      orderId: "gid://shopify/Order/1",
    });
    const body = JSON.parse(
      String(
        (h.request.mock.calls[1] as unknown as [string, RequestInit])[1].body,
      ),
    );
    expect(body.query).toMatch(/^query EchelonCancellationJob/);
  });
});
