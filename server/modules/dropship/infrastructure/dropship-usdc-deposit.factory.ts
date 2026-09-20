/**
 * Builds the USDC deposit service from the environment (funding design
 * phase 6). Two variables decide what is offered:
 *
 *  - `DROPSHIP_USDC_BASE_XPUB`: the account extended PUBLIC key. Unset, no
 *    vendor is handed a deposit address.
 *  - `DROPSHIP_USDC_BASE_RPC_URL`: the Base node. Unset, nothing is watched
 *    (addresses can still be handed out and credited by hand).
 *
 * The rest tunes the watcher and has documented defaults. A malformed
 * value is refused at boot rather than silently replaced: a wrong token
 * address or confirmation count would move money on the wrong facts.
 */

import { DropshipError } from "../domain/errors";
import {
  DEFAULT_USDC_WATCHER_CONFIG,
  DropshipUsdcDepositService,
  dropshipUsdcWatcherConfigSchema,
  makeDropshipUsdcDepositLogger,
  systemDropshipUsdcDepositClock,
  type DropshipUsdcWatcherConfig,
} from "../application/dropship-usdc-deposit-service";
import { createBaseJsonRpcClientFromEnv } from "./base-json-rpc.client";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";
import { PgDropshipUsdcDepositRepository } from "./dropship-usdc-deposit.repository";
import { createDropshipVendorStandingServiceFromEnv } from "./dropship-vendor-standing.factory";
import { PgDropshipWalletRepository } from "./dropship-wallet.repository";
import { HdUsdcDepositAddressDeriver } from "./usdc-hd-address-deriver";

export const USDC_WATCHER_ENV = {
  tokenAddress: "DROPSHIP_USDC_BASE_TOKEN_ADDRESS",
  minConfirmations: "DROPSHIP_USDC_WATCHER_MIN_CONFIRMATIONS",
  settleTag: "DROPSHIP_USDC_WATCHER_SETTLE_TAG",
  voidAfterBlocks: "DROPSHIP_USDC_WATCHER_VOID_AFTER_BLOCKS",
  maxBlockSpan: "DROPSHIP_USDC_WATCHER_MAX_BLOCK_SPAN",
  startBlock: "DROPSHIP_USDC_WATCHER_START_BLOCK",
  addressBatchSize: "DROPSHIP_USDC_WATCHER_ADDRESS_BATCH_SIZE",
  settlementBatchSize: "DROPSHIP_USDC_WATCHER_SETTLEMENT_BATCH_SIZE",
} as const;

export function resolveDropshipUsdcWatcherConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DropshipUsdcWatcherConfig {
  const candidate = {
    chainId: DEFAULT_USDC_WATCHER_CONFIG.chainId,
    tokenAddress: (readText(env, USDC_WATCHER_ENV.tokenAddress) ?? DEFAULT_USDC_WATCHER_CONFIG.tokenAddress).toLowerCase(),
    minConfirmations: readInteger(env, USDC_WATCHER_ENV.minConfirmations) ?? DEFAULT_USDC_WATCHER_CONFIG.minConfirmations,
    settleTag: readText(env, USDC_WATCHER_ENV.settleTag) ?? DEFAULT_USDC_WATCHER_CONFIG.settleTag,
    voidAfterBlocks: readInteger(env, USDC_WATCHER_ENV.voidAfterBlocks) ?? DEFAULT_USDC_WATCHER_CONFIG.voidAfterBlocks,
    maxBlockSpan: readInteger(env, USDC_WATCHER_ENV.maxBlockSpan) ?? DEFAULT_USDC_WATCHER_CONFIG.maxBlockSpan,
    startBlock: readInteger(env, USDC_WATCHER_ENV.startBlock) ?? DEFAULT_USDC_WATCHER_CONFIG.startBlock,
    addressBatchSize: readInteger(env, USDC_WATCHER_ENV.addressBatchSize) ?? DEFAULT_USDC_WATCHER_CONFIG.addressBatchSize,
    settlementBatchSize: readInteger(env, USDC_WATCHER_ENV.settlementBatchSize) ?? DEFAULT_USDC_WATCHER_CONFIG.settlementBatchSize,
  };
  const parsed = dropshipUsdcWatcherConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new DropshipError(
      "DROPSHIP_USDC_WATCHER_MISCONFIGURED",
      "The USDC watcher environment is not usable.",
      { issues: parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join("."), message: issue.message })), classification: "fatal" },
    );
  }
  return parsed.data;
}

export function createDropshipUsdcDepositServiceFromEnv(env: NodeJS.ProcessEnv = process.env): DropshipUsdcDepositService {
  const logger = makeDropshipUsdcDepositLogger();
  return new DropshipUsdcDepositService({
    depositRepository: new PgDropshipUsdcDepositRepository(),
    ledgerRepository: new PgDropshipWalletRepository(),
    deriver: HdUsdcDepositAddressDeriver.fromEnv(env),
    chain: createBaseJsonRpcClientFromEnv(env, globalThis.fetch, logger),
    config: resolveDropshipUsdcWatcherConfigFromEnv(env),
    notificationSender: createDropshipNotificationServiceFromEnv(),
    vendorStanding: createDropshipVendorStandingServiceFromEnv(),
    clock: systemDropshipUsdcDepositClock,
    logger,
  });
}

function readText(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** A set variable must be a whole number; anything else is refused, not defaulted. */
function readInteger(env: NodeJS.ProcessEnv, name: string): number | null {
  const text = readText(env, name);
  if (text === null) return null;
  if (!/^-?\d+$/.test(text)) {
    throw new DropshipError(
      "DROPSHIP_USDC_WATCHER_MISCONFIGURED",
      `${name} must be a whole number.`,
      { env: name, value: text, classification: "fatal" },
    );
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new DropshipError(
      "DROPSHIP_USDC_WATCHER_MISCONFIGURED",
      `${name} is outside the safe integer range.`,
      { env: name, value: text, classification: "fatal" },
    );
  }
  return value;
}
