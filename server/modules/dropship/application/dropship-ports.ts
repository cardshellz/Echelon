import type {
  DropshipFaultCategory,
  DropshipSourcePlatform,
} from "../../../../shared/schema/dropship.schema";
import type {
  DropshipEntitlementStatus,
  DropshipSensitiveAction,
  DropshipStepUpMethod,
} from "../domain/auth";

export interface DropshipClock {
  now(): Date;
}

export interface DropshipLogger {
  info(event: DropshipLogEvent): void;
  warn(event: DropshipLogEvent): void;
  error(event: DropshipLogEvent): void;
}

export interface DropshipLogEvent {
  code: string;
  message: string;
  context?: Record<string, unknown>;
}

export type DropshipNotificationDeliveryChannel = "email" | "in_app";

export interface DropshipNotificationSenderInput {
  vendorId: number;
  eventType: string;
  critical: boolean;
  channels?: DropshipNotificationDeliveryChannel[];
  title: string;
  message?: string | null;
  payload?: Record<string, unknown>;
  idempotencyKey: string;
}

export interface DropshipNotificationSender {
  send(input: DropshipNotificationSenderInput): Promise<unknown>;
}

export interface DropshipOmsFulfillmentSync {
  syncOmsOrderToWms(omsOrderId: number): Promise<number | null>;
}

export interface DropshipTransaction {
  readonly id: string;
}

export interface DropshipTransactionManager {
  runInTransaction<T>(
    operation: (transaction: DropshipTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface DropshipAuditEventInput {
  vendorId?: number;
  storeConnectionId?: number;
  entityType: string;
  entityId?: string;
  eventType: string;
  actorType: "vendor" | "admin" | "system" | "job";
  actorId?: string;
  severity: "info" | "warning" | "error";
  payload?: Record<string, unknown>;
}

export interface DropshipAuditRepository {
  record(event: DropshipAuditEventInput, transaction: DropshipTransaction): Promise<void>;
}

export interface DropshipEntitlementSnapshot {
  memberId: string;
  cardShellzEmail: string | null;
  planId: string | null;
  planName: string | null;
  subscriptionId: string | null;
  includesDropship: boolean;
  status: DropshipEntitlementStatus;
  reasonCode: string;
}

export interface DropshipMemberIdentity {
  memberId: string;
  cardShellzEmail: string;
  memberStatus: string | null;
}

export interface DropshipIdentityPort {
  resolveMemberByCardShellzEmail(email: string): Promise<DropshipMemberIdentity | null>;
}

export interface DropshipEntitlementPort {
  getEntitlementByMemberId(memberId: string): Promise<DropshipEntitlementSnapshot | null>;
}

export interface DropshipSensitiveActionChallengeRequest {
  memberId: string;
  action: DropshipSensitiveAction;
  method: DropshipStepUpMethod;
  idempotencyKey: string;
}

export interface DropshipAuthChallengePort {
  createSensitiveActionChallenge(
    request: DropshipSensitiveActionChallengeRequest,
    transaction: DropshipTransaction,
  ): Promise<{ challengeId: number; expiresAt: Date }>;
}

export interface DropshipCatalogPort {
  assertVariantCatalogVisible(input: {
    vendorId: number;
    productVariantId: number;
    transaction: DropshipTransaction;
  }): Promise<void>;
}

export interface DropshipListingPort {
  enqueueListingPush(input: {
    vendorId: number;
    storeConnectionId: number;
    productVariantIds: number[];
    idempotencyKey: string;
    transaction: DropshipTransaction;
  }): Promise<number>;
}

export interface DropshipOrderIntakePort {
  recordMarketplaceIntake(input: {
    vendorId: number;
    storeConnectionId: number;
    platform: DropshipSourcePlatform;
    externalOrderId: string;
    externalOrderNumber?: string;
    rawPayload: Record<string, unknown>;
    payloadHash: string;
    idempotencyKey: string;
    transaction: DropshipTransaction;
  }): Promise<number>;
}

export interface DropshipWalletPort {
  creditFunding(input: {
    vendorId: number;
    walletAccountId: number;
    amountCents: number;
    currency: string;
    referenceType: string;
    referenceId: string;
    idempotencyKey: string;
    transaction: DropshipTransaction;
  }): Promise<void>;

  debitOrder(input: {
    vendorId: number;
    walletAccountId: number;
    intakeId: number;
    amountCents: number;
    currency: string;
    idempotencyKey: string;
    transaction: DropshipTransaction;
  }): Promise<void>;
}

export interface DropshipReservationPort {
  reserveForAcceptedOrder(input: {
    intakeId: number;
    vendorId: number;
    transaction: DropshipTransaction;
  }): Promise<void>;
}

export interface DropshipShippingPort {
  quote(input: {
    vendorId: number;
    storeConnectionId: number;
    warehouseId: number;
    destination: {
      country: string;
      region?: string;
      postalCode: string;
    };
    items: Array<{ productVariantId: number; quantity: number }>;
    idempotencyKey: string;
    transaction: DropshipTransaction;
  }): Promise<number>;
}

export interface DropshipMarketplacePort {
  refreshStoreToken(input: {
    storeConnectionId: number;
    idempotencyKey: string;
    transaction: DropshipTransaction;
  }): Promise<void>;

  pushTracking(input: {
    vendorId: number;
    storeConnectionId: number;
    intakeId: number;
    carrier: string;
    trackingNumber: string;
    shippedAt: Date;
    idempotencyKey: string;
    transaction: DropshipTransaction;
  }): Promise<void>;
}

export interface DropshipReturnPort {
  processInspection(input: {
    rmaId: number;
    inspectorId: string;
    outcome: "approved" | "rejected";
    faultCategory: DropshipFaultCategory;
    creditCents: number;
    feeCents: number;
    notes?: string;
    idempotencyKey: string;
    transaction: DropshipTransaction;
  }): Promise<void>;
}

export interface DropshipNotificationPort {
  send(input: {
    vendorId: number;
    eventType: string;
    critical: boolean;
    channels: Array<"email" | "in_app" | "sms" | "webhook">;
    title: string;
    message?: string;
    payload?: Record<string, unknown>;
    idempotencyKey: string;
    transaction: DropshipTransaction;
  }): Promise<void>;
}

export interface DropshipApplicationPorts {
  clock: DropshipClock;
  logger: DropshipLogger;
  transactions: DropshipTransactionManager;
  auditEvents: DropshipAuditRepository;
  identity: DropshipIdentityPort;
  entitlement: DropshipEntitlementPort;
  authChallenges: DropshipAuthChallengePort;
  catalog: DropshipCatalogPort;
  listings: DropshipListingPort;
  orderIntake: DropshipOrderIntakePort;
  wallet: DropshipWalletPort;
  reservations: DropshipReservationPort;
  shipping: DropshipShippingPort;
  marketplace: DropshipMarketplacePort;
  returns: DropshipReturnPort;
  notifications: DropshipNotificationPort;
}
