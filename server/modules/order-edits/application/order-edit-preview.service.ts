import { z } from "zod";
import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  ORDER_EDIT_PREVIEW_TTL_MS,
  orderEditPreviewInputSchema,
  orderEditPreviewSchema,
  orderEditPreviewScopeSchema,
  orderEditPreviewWarmSchema,
  type OrderEditPreview,
  type OrderEditPreviewInput,
  type OrderEditPreviewScope,
} from "@shared/order-edits/order-edit-preview";
import { OrderEditError } from "../domain/order-edit-error";
import type { OrderEditProvider } from "./order-edit-provider";
import type {
  OrderEditPreviewContext,
  OrderEditPreviewProvider,
} from "./order-edit-preview-provider";
import type {
  OrderEditOrderReference,
  OrderEditStore,
  OrderEditWarehouse,
} from "./order-edit-store";
import {
  assertOrderEditIdentity,
  orderEditEligibilityReasons,
} from "./order-edit-identity";
import { OrderEditPreviewCache } from "./order-edit-preview-cache";

// Bound memory and outstanding Shopify calculations independently of staff/browser activity.
const MAX_PREVIEW_CONTEXTS = 128;
const MAX_PREVIEW_RESULTS = 256;
const MAX_CONCURRENT_PREVIEWS = 8;
function previewCacheKey(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export class OrderEditPreviewService {
  private readonly contexts: OrderEditPreviewCache<OrderEditPreviewContext>;
  private readonly results: OrderEditPreviewCache<OrderEditPreview>;
  constructor(
    private readonly store: Pick<OrderEditStore, "settings" | "orderReference">,
    private readonly provider: Pick<OrderEditProvider, "readOrder"> &
      OrderEditPreviewProvider,
    private readonly warehouse: Pick<OrderEditWarehouse, "inspect">,
    private readonly clock: () => Date,
  ) {
    this.contexts = new OrderEditPreviewCache(
      clock,
      MAX_PREVIEW_CONTEXTS,
      MAX_CONCURRENT_PREVIEWS,
    );
    this.results = new OrderEditPreviewCache(
      clock,
      MAX_PREVIEW_RESULTS,
      MAX_CONCURRENT_PREVIEWS,
    );
  }
  async warm(raw: OrderEditPreviewScope, actorId: string) {
    const scope = orderEditPreviewScopeSchema.parse(raw);
    const reference = await this.reference(scope);
    const context = await this.context(scope, reference, actorId);
    return orderEditPreviewWarmSchema.parse({
      scope,
      expiresAt: new Date(context.expiresAt).toISOString(),
    });
  }
  async preview(
    raw: OrderEditPreviewInput,
    actorId: string,
  ): Promise<OrderEditPreview> {
    const input = orderEditPreviewInputSchema.parse(raw);
    const scope = orderEditPreviewScopeSchema.parse({
      connectionId: input.connectionId,
      omsOrderId: input.omsOrderId,
      expectedRevision: input.expectedRevision,
    });
    // Check current settings and OMS ownership even on a cache hit. Cached context is only provisional.
    const reference = await this.reference(scope);
    const context = await this.context(scope, reference, actorId);
    const key = previewCacheKey([
      actorId,
      input,
      context.value.snapshot,
      context.value.variants,
    ]);
    return (
      await this.results.getOrLoad(key, async () => {
        const calculation = await this.provider.preview(context.value, {
          changes: input.changes,
          additions: input.additions,
        });
        const value = orderEditPreviewSchema.parse({
          phase: "preview",
          input,
          ...calculation,
          calculatedAt: this.clock().toISOString(),
          expiresAt: new Date(context.expiresAt).toISOString(),
        });
        return { value, expiresAt: context.expiresAt };
      })
    ).value;
  }
  private async reference(
    scope: OrderEditPreviewScope,
  ): Promise<OrderEditOrderReference> {
    const settings = await this.store.settings(scope.connectionId);
    if (!settings.enabled || settings.paymentWindowMinutes === null)
      throw new OrderEditError(
        "ORDER_EDIT_DISABLED",
        "Staff order editing is disabled for this Shopify connection.",
      );
    const reference = await this.store.orderReference(
      scope.connectionId,
      scope.omsOrderId,
    );
    if (reference.activeOperationId)
      throw new OrderEditError(
        "ORDER_EDIT_ALREADY_ACTIVE",
        "Close or resume the current edit before preparing another preview.",
      );
    return reference;
  }
  private context(
    scope: OrderEditPreviewScope,
    reference: OrderEditOrderReference,
    actorId: string,
  ) {
    z.string().min(1).max(200).parse(actorId);
    // Scope includes the server-owned channel/customer/order mapping, not just a browser's order number.
    const key = previewCacheKey([actorId, scope, reference]);
    return this.contexts.getOrLoad(key, async () => {
      const expiresAt = this.clock().getTime() + ORDER_EDIT_PREVIEW_TTL_MS;
      const snapshot = await this.provider.readOrder(
        scope.connectionId,
        reference.externalOrderId,
      );
      assertOrderEditIdentity(reference, snapshot);
      if (snapshot.fingerprint !== scope.expectedRevision)
        throw new OrderEditError(
          "ORDER_EDIT_ORDER_CHANGED",
          "The order changed. Refresh it before reviewing changes.",
        );
      const warehouse = await this.warehouse.inspect(scope.omsOrderId);
      const reasons = [
        ...warehouse.reasons,
        ...orderEditEligibilityReasons(snapshot),
      ];
      if (!warehouse.editable || reasons.length)
        throw new OrderEditError(
          "ORDER_EDIT_UNAVAILABLE",
          reasons.join(" ") || "Order editing is unavailable.",
        );
      return { value: await this.provider.preparePreview(snapshot), expiresAt };
    });
  }
}
