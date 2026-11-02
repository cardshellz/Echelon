import { randomUUID } from "node:crypto";
import { PostgresCustomerReturnProgressReader } from "./customer-return-progress.reader";
import { z } from "zod";
import type { ReturnCustomerAuthConfig } from "../application/customer-return-customer-auth.service";
import { CustomerReturnCustomerAccessError } from "../application/customer-return-customer-auth.service";
import { CustomerReturnGuestService } from "../application/customer-return-guest.service";
import { PostgresCustomerReturnGuestStore } from "./customer-return-guest.repository";
import { ShopifyGuestReturnPurchaseGateway } from "./customer-return-guest-shopify.gateway";
import { CustomerReturnOrderAccessService } from "../application/customer-return-order-access.service";
import type { GuestPurchase } from "../application/customer-return-guest.ports";
import { PostgresCustomerReturnOrderAccessRepository } from "./customer-return-order-access.repository";
import { CustomerReturnCustomerOrdersService } from "../application/customer-return-customer-orders.service";
import { CustomerReturnCustomerOperationsService } from "../application/customer-return-customer-operations.service";
import { PostgresCustomerReturnCustomerOwnershipReader } from "./customer-return-customer-ownership.repository";
import { PostgresCustomerReturnWorkflowStore } from "./customer-return-workflow.repository";
import { createCustomerReturnLiveService } from "./customer-return-live.composition";
import { createCustomerReturnLabelServices } from "./customer-return-label.composition";
import { PostgresCustomerReturnSettingsStore } from "./customer-return-label-settings.repository";
import { CustomerReturnGuestOrdersService } from "../application/customer-return-guest-orders.service";

export async function createCustomerReturnGuestService(config: ReturnCustomerAuthConfig) {
  // Separate authentication key: the existing recovery-storage key must never
  // become a credential. Missing guest configuration leaves signed-in returns intact.
  const secret = z.string().min(32).max(1024).safeParse(process.env.CUSTOMER_RETURN_GUEST_SECRET);
  if (!secret.success || secret.data === config.storageSecret || Object.values(config.shops).some(shop => shop.shopifySecret === secret.data))
    throw new CustomerReturnCustomerAccessError("RETURN_GUEST_CONFIGURATION_REQUIRED", "Guest returns are not available yet. Please sign in or contact us.", 503);
  const [{ pool, db }, { ChannelIdentityService }] = await Promise.all([import("../../../db"), import("../../channels/channel-identity.service")]);
  const identity = new ChannelIdentityService(db);
  return new CustomerReturnGuestService({ secret: secret.data, store: new PostgresCustomerReturnGuestStore(pool, secret.data), now: () => new Date(), randomId: randomUUID,
    purchases: new ShopifyGuestReturnPurchaseGateway({ database: pool, connection: channel => identity.shopifyConnection(channel), request: fetch,
      storefrontOrigin: shop => new URL(config.shops[shop].proxyUrl).origin }),
    email: { send: async input => {
      const { sendEmail } = await import("../../notifications/email.service");
      const result = await sendEmail({ to: input.to, subject: "Your Card Shellz return verification code",
        messageId: `<return-guest-${input.challengeId}@cardshellz.com>`,
        text: `Your return verification code is ${input.code}. Codes expire 10 minutes after the first request. If you didn't request this, ignore this email.`,
        html: `<p>Your Card Shellz return verification code is:</p><p style="font-size:24px;font-weight:700;letter-spacing:3px">${input.code}</p><p>Codes expire 10 minutes after the first request. If you didn't request this, ignore this email.</p>` });
      if (!result.accepted.some(email => email.toLowerCase() === input.to.toLowerCase())) throw new Error("RETURN_GUEST_EMAIL_NOT_ACCEPTED");
    } },
  });
}
export async function createGuestReturnServices(purchase: GuestPurchase) {
  const [{ pool, db }, live, internal] = await Promise.all([import("../../../db"), createCustomerReturnLiveService(), createCustomerReturnLabelServices()]);
  const principal = { channelId: purchase.channelId, externalCustomerId: purchase.externalCustomerId, verifiedPurchase: purchase.verifiedPurchase };
  const access = new CustomerReturnOrderAccessService({ channelId: purchase.channelId,
    principalReader: { getVerifiedPrincipal: async () => ({ kind: "order", channelId: purchase.channelId, omsOrderId: purchase.omsOrderId, externalOrderId: purchase.externalOrderId }) },
    repository: new PostgresCustomerReturnOrderAccessRepository(pool) });
  const settings = new PostgresCustomerReturnSettingsStore(db);
  const orders = new CustomerReturnCustomerOrdersService({ principal, access, live,
      choices: { read: async () => { throw new CustomerReturnCustomerAccessError("RETURN_GUEST_ORDER_ONLY", "Verify another order to view its items.", 403); } },
      shippingVersion: () => settings.customerVersion(purchase.channelId), reportUnavailableOrder: context => console.warn(JSON.stringify({ event: "guest_return_order_unavailable", ...context })) });
  return {
    orders: new CustomerReturnGuestOrdersService({ omsOrderId: purchase.omsOrderId, access, orders }),
    operations: new CustomerReturnCustomerOperationsService({ principal: { ...principal, orderScope: { omsOrderId: purchase.omsOrderId, externalOrderId: purchase.externalOrderId } },
      orderAccess: access, ownership: new PostgresCustomerReturnCustomerOwnershipReader(pool), submissions: internal.submissions, labels: internal.labels,
      historyProgress: new PostgresCustomerReturnProgressReader(pool),
      reportHistoryUnavailable: () => console.warn(JSON.stringify({ event: "guest_return_history_progress_unavailable", code: "RETURN_HISTORY_PROGRESS_UNAVAILABLE", channelId: purchase.channelId, omsOrderId: purchase.omsOrderId })),
      workflows: new PostgresCustomerReturnWorkflowStore(pool), now: () => new Date() }),
    download: internal.download,
  };
}
