import { z } from "zod";
import type { CustomerRewards } from "./customer-rewards";
import type { CustomerReturnCustomerSession } from "../../returns/application/customer-return-customer-auth.service";
import type { CustomerReturnOrderAccessService } from "../../returns/application/customer-return-order-access.service";
import type { OrderEditService } from "../../order-edits/application/order-edit.service";
import type { OrderEditStore } from "../../order-edits/application/order-edit-store";
import { customerOrderEditActorId } from "../../order-edits/domain/order-edit-actor";
import { OrderEditError } from "../../order-edits/domain/order-edit-error";
import { orderEditQuoteInputSchema } from "@shared/order-edits/order-edit.contract";
import {
  orderEditPreviewInputSchema,
  orderEditPreviewScopeSchema,
} from "@shared/order-edits/order-edit-preview";
import {
  orderEditCatalogCategoriesInputSchema,
  orderEditCatalogProductsInputSchema,
  orderEditCatalogVariantsInputSchema,
} from "@shared/order-edits/order-edit-catalog";
import {
  customerAccountOrderIdentityInputSchema,
  customerAccountOrderIdentitySchema,
} from "@shared/customer-account/customer-account.contract";
import { customerOrderCancellationInputSchema } from "@shared/customer-account/order-cancellation";

export class CustomerOrderEditService {
  private readonly actorId: string;
  constructor(
    private readonly dependencies: {
      principal: CustomerReturnCustomerSession;
      rewards?: CustomerRewards;
      access: Pick<
        CustomerReturnOrderAccessService,
        "resolve" | "resolveOwned"
      >;
      store: Pick<OrderEditStore, "connections" | "get">;
      edits: Pick<
        OrderEditService,
        | "order"
        | "catalogCategories"
        | "catalogProducts"
        | "catalogVariants"
        | "warmPreview"
        | "preview"
        | "quote"
        | "get"
        | "commit"
        | "reconcile"
        | "resume"
        | "abandon"
        | "cancellations"
      >;
    },
  ) {
    this.actorId = customerOrderEditActorId({
      channelId: dependencies.principal.channelId,
      externalCustomerId: dependencies.principal.externalCustomerId,
    });
  }

  async connection() {
    const { principal, store } = this.dependencies;
    const matches = (await store.connections()).filter(
      (row) =>
        row.channelId === principal.channelId &&
        row.shopDomain === principal.shopDomain,
    );
    if (matches.length !== 1)
      throw new OrderEditError(
        "CUSTOMER_ACCOUNT_CONNECTION_UNAVAILABLE",
        "Order editing is temporarily unavailable.",
        503,
      );
    return matches[0];
  }
  async resolve(raw: unknown) {
    const input = customerAccountOrderIdentityInputSchema.parse(raw);
    const owned = await this.dependencies.access.resolve({
      orderReference: input.orderReference,
    });
    if (
      owned.externalOrderId.replace(/^gid:\/\/shopify\/Order\//, "") !==
      input.externalOrderId
    )
      throw unavailable();
    return customerAccountOrderIdentitySchema.parse({
      omsOrderId: owned.omsOrderId,
      connectionId: (await this.connection()).connectionId,
      externalOrderId: input.externalOrderId,
    });
  }
  async order(
    connectionId: number,
    omsOrderId: number,
    codeEntryVersion?: "v1",
  ) {
    await this.ownedScope(connectionId, omsOrderId);
    const order = await this.dependencies.edits.order(
      connectionId,
      omsOrderId,
      codeEntryVersion,
      this.actorId,
    );
    if (order.activeOperationId) {
      const active = await this.dependencies.store.get(order.activeOperationId);
      if (!this.ownsOperation(active))
        return {
          ...order,
          activeOperationId: null,
          eligibility: {
            editable: false,
            reasons: [
              "An edit is already in progress for this order. Contact support for help.",
            ],
          },
        };
    }
    return order;
  }
  async cancellationReview(connectionId: number, omsOrderId: number) {
    await this.ownedScope(connectionId, omsOrderId);
    return this.cancellations().review(connectionId, omsOrderId);
  }
  async submitCancellation(connectionId: number, omsOrderId: number, raw: unknown, commandKey: string) {
    const body = customerOrderCancellationInputSchema.omit({ connectionId: true, omsOrderId: true }).parse(raw);
    if (body.requestKey !== z.string().uuid().parse(commandKey)) throw new OrderEditError("ORDER_CANCELLATION_KEY_MISMATCH", "The cancellation reference does not match.", 400);
    await this.ownedScope(connectionId, omsOrderId);
    return this.cancellations().submit({ connectionId, omsOrderId, ...body }, this.actorId);
  }
  async cancellationStatus(connectionId: number, omsOrderId: number, requestKey: string) {
    await this.ownedScope(connectionId, omsOrderId);
    return this.cancellations().get(connectionId, omsOrderId, requestKey, this.actorId);
  }
  private cancellations() {
    const service = this.dependencies.edits.cancellations;
    if (!service) throw new OrderEditError("ORDER_CANCELLATION_UNAVAILABLE", "Online cancellation is temporarily unavailable.", 503);
    return service;
  }
  async catalogCategories(connectionId: number, raw: unknown) {
    await this.ownedConnection(connectionId);
    return this.dependencies.edits.catalogCategories(
      connectionId,
      orderEditCatalogCategoriesInputSchema.parse(raw),
    );
  }
  async catalogProducts(connectionId: number, raw: unknown) {
    await this.ownedConnection(connectionId);
    return this.dependencies.edits.catalogProducts(
      connectionId,
      orderEditCatalogProductsInputSchema.parse(raw),
      "available",
    );
  }
  async catalogVariants(connectionId: number, raw: unknown) {
    const input = orderEditCatalogVariantsInputSchema.parse(raw);
    if (input.omsOrderId === null) throw unavailable();
    await this.ownedScope(connectionId, input.omsOrderId);
    return this.dependencies.edits.catalogVariants(
      connectionId,
      input,
      this.actorId,
      "available",
    );
  }
  async warmPreview(raw: unknown) {
    const input = orderEditPreviewScopeSchema.parse(raw);
    await this.ownedScope(input.connectionId, input.omsOrderId);
    return this.dependencies.edits.warmPreview(input, this.actorId);
  }
  async rewardsState(connectionId: number, omsOrderId: number) {
    await this.ownedScope(connectionId, omsOrderId);
    return this.rewardService().state(this.rewardScope());
  }
  async manageRewards(connectionId: number, omsOrderId: number) {
    await this.ownedScope(connectionId, omsOrderId);
    return this.rewardService().manage(this.rewardScope());
  }
  async cancelReward(connectionId: number, omsOrderId: number, raw: unknown, commandKey: string) {
    const input = z.object({ rewardId: z.string().uuid(), requestKey: z.string().uuid() }).strict().parse(raw);
    if (input.requestKey !== z.string().uuid().parse(commandKey))
      throw new OrderEditError("REWARD_KEY_MISMATCH", "The saved reward request does not match.", 400);
    await this.ownedScope(connectionId, omsOrderId);
    return this.rewardService().cancel({ ...this.rewardScope(), rewardId: input.rewardId });
  }
  async issueReward(connectionId: number, omsOrderId: number, raw: unknown, commandKey: string) {
    const input = z.object({ points: z.number().int().positive().max(99_999_999), requestKey: z.string().uuid() }).strict().parse(raw);
    if (input.requestKey !== z.string().uuid().parse(commandKey))
      throw new OrderEditError("REWARD_KEY_MISMATCH", "The saved reward request does not match.", 400);
    await this.ownedScope(connectionId, omsOrderId);
    return this.rewardService().issue({ ...this.rewardScope(), ...input });
  }
  private rewardScope() {
    const principal = this.dependencies.principal;
    return { customerId: `gid://shopify/Customer/${principal.externalCustomerId}`, channelId: principal.channelId };
  }
  private rewardService() {
    if (!this.dependencies.rewards) throw new OrderEditError("REWARD_UNAVAILABLE", "Rewards are temporarily unavailable.", 503);
    return this.dependencies.rewards;
  }
  async preview(raw: unknown) {
    const input = orderEditPreviewInputSchema.parse(raw);
    await this.ownedScope(input.connectionId, input.omsOrderId);
    return this.dependencies.edits.preview(input, this.actorId);
  }
  async quote(raw: unknown, key: string) {
    const input = orderEditQuoteInputSchema.parse(raw);
    if (input.requestKey !== z.string().uuid().parse(key))
      throw new OrderEditError(
        "ORDER_EDIT_KEY_MISMATCH",
        "The saved edit reference does not match.",
        400,
      );
    await this.ownedScope(input.connectionId, input.omsOrderId);
    return this.dependencies.edits.quote(input, this.actorId);
  }
  async operation(raw: string, codeEntryVersion?: "v1") {
    await this.ownedOperation(raw);
    return this.dependencies.edits.get(raw, codeEntryVersion);
  }
  async progress(
    raw: string,
    action: "commit" | "reconcile" | "abandon" | "resume",
    key: string,
  ) {
    z.string().uuid().parse(key);
    await this.ownedOperation(raw);
    return action === "commit"
      ? this.dependencies.edits.commit(raw, key, this.actorId)
      : this.dependencies.edits[action](raw, this.actorId);
  }
  private async ownedConnection(connectionId: number) {
    if ((await this.connection()).connectionId !== connectionId)
      throw unavailable();
  }
  private async ownedScope(connectionId: number, omsOrderId: number) {
    await this.ownedConnection(connectionId);
    return this.dependencies.access.resolveOwned({ omsOrderId });
  }
  private ownsOperation(
    record: Awaited<ReturnType<OrderEditStore["get"]>>,
  ): boolean {
    const principal = this.dependencies.principal;
    return (
      record.actorId === this.actorId &&
      record.baseline.channelId === principal.channelId &&
      record.baseline.customerId?.replace(
        /^gid:\/\/shopify\/Customer\//,
        "",
      ) === principal.externalCustomerId
    );
  }
  private async ownedOperation(raw: string) {
    const record = await this.dependencies.store.get(
      z.string().uuid().parse(raw),
    );
    if (!this.ownsOperation(record)) throw unavailable();
    await this.ownedScope(record.connectionId, record.omsOrderId);
  }
}
function unavailable() {
  return new OrderEditError(
    "CUSTOMER_ACCOUNT_ORDER_UNAVAILABLE",
    "This order or edit is unavailable in your account.",
    404,
  );
}
