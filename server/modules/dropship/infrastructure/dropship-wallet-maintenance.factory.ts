import {
  DEFAULT_WALLET_MAINTENANCE_MAX_ATTEMPTS_PER_DAY,
  DropshipWalletMaintenanceService,
  makeDropshipWalletMaintenanceLogger,
  systemDropshipWalletMaintenanceClock,
} from "../application/dropship-wallet-maintenance-service";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";
import { createDropshipVendorStandingServiceFromEnv } from "./dropship-vendor-standing.factory";
import { PgDropshipWalletMaintenanceRepository } from "./dropship-wallet-maintenance.repository";
import { createDropshipWalletServiceFromEnv } from "./dropship-wallet.factory";

const MAX_ATTEMPTS_ENV = "DROPSHIP_WALLET_MAINTENANCE_MAX_ATTEMPTS_PER_DAY";

export function createDropshipWalletMaintenanceServiceFromEnv(): DropshipWalletMaintenanceService {
  // The reloader is the real wallet service: the daily top-up must go through
  // exactly the code path an order-triggered reload uses, fee and ledger
  // included. When STRIPE_SECRET_KEY is absent the wallet service reports a
  // skip (`funding_provider_not_configured`), which the job records as an
  // our-side failure rather than crashing the worker.
  return new DropshipWalletMaintenanceService({
    repository: new PgDropshipWalletMaintenanceRepository(),
    reloader: createDropshipWalletServiceFromEnv(),
    notificationSender: createDropshipNotificationServiceFromEnv(),
    vendorStanding: createDropshipVendorStandingServiceFromEnv(),
    clock: systemDropshipWalletMaintenanceClock,
    logger: makeDropshipWalletMaintenanceLogger(),
    maxAttemptsPerDay: envPositiveInteger(MAX_ATTEMPTS_ENV, DEFAULT_WALLET_MAINTENANCE_MAX_ATTEMPTS_PER_DAY),
  });
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
