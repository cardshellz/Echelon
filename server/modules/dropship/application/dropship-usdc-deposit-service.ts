/**
 * USDC deposits into a Card Shellz wallet (funding design phase 6).
 *
 * Three jobs, one service:
 *
 *  - the vendor's deposit address: derived from the watch-only account key
 *    the first time the vendor asks, then fixed;
 *  - the watcher: a scan tick reads USDC `Transfer` logs to every vendor
 *    address from the chain and credits each one (pending, or settled when
 *    its block is already at or below the safe head); a settlement tick
 *    moves pending credits to available once the safe head passes them, and
 *    voids a credit the network dropped;
 *  - the custody check: the on-chain balance of every address against what
 *    the ledger expects to sit there, so funds the watcher never credited
 *    are seen by a human.
 *
 * Nothing here signs or sends on chain. Money is integer cents; token
 * amounts are atomic-unit strings. The clock, the chain reader, the key
 * deriver and both repositories are injected.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { DropshipError } from "../domain/errors";
import {
  ERC20_SELECTORS,
  addressToTopic,
  decodeAbiString,
  decodeUint256Word,
  decodeUint8Word,
  encodeBalanceOfCall,
  hexQuantityToSafeInteger,
  normalizeEvmAddress,
} from "../domain/evm-abi";
import {
  BASE_MAINNET_CHAIN_ID,
  ERC20_TRANSFER_TOPIC,
  USDC_DECIMALS,
  compareUsdcCustody,
  decideUsdcDepositObservation,
  decideUsdcDepositSettlement,
  decodeUsdcTransferLog,
  usdcAtomicUnitsToCents,
  type UsdcCustodyStatus,
  type UsdcTransferObservation,
} from "../domain/usdc-deposits";
import { DROPSHIP_NOTIFICATION_EVENTS } from "./dropship-notification-events";
import { formatNotificationCurrency, sendDropshipNotificationSafely } from "./dropship-notification-dispatch";
import type { DropshipClock, DropshipLogger, DropshipNotificationSender } from "./dropship-ports";
import type {
  DropshipUsdcDepositLedgerRepository,
  DropshipUsdcDepositLedgerResult,
  DropshipUsdcLedgerEntryRecord,
} from "./dropship-wallet-service";
import type { DropshipVendorStandingService } from "./dropship-vendor-standing-service";
import type { DropshipVendorProvisioningService } from "./dropship-vendor-provisioning-service";

// ---- ports ----

export interface DropshipUsdcDepositAddressRecord {
  depositAddressId: number;
  vendorId: number;
  chainId: number;
  keyFingerprint: string;
  derivationIndex: number;
  /** Lowercase, for matching. */
  address: string;
  /** EIP-55, for showing. */
  checksumAddress: string;
  assignedAt: Date;
}

export interface DropshipUsdcWatcherCursorRecord {
  chainId: number;
  tokenAddress: string;
  lastScannedBlock: number;
  updatedAt: Date;
}

export interface DropshipUsdcCustodyExpectation {
  depositAddressId: number;
  vendorId: number;
  address: string;
  checksumAddress: string;
  /** Every observation not voided, in atomic units: what sits there before any sweep. */
  expectedAtomicUnits: string;
  creditedCents: number;
  observationCount: number;
}

export interface DerivedDropshipUsdcDepositAddress {
  derivationIndex: number;
  address: string;
  checksumAddress: string;
  keyFingerprint: string;
}

export interface AssignDropshipUsdcDepositAddressRepositoryInput {
  vendorId: number;
  chainId: number;
  keyFingerprint: string;
  derive: (derivationIndex: number) => DerivedDropshipUsdcDepositAddress;
  assignedAt: Date;
}

export interface DropshipUsdcDepositRepository {
  findDepositAddress(input: { vendorId: number; chainId: number }): Promise<DropshipUsdcDepositAddressRecord | null>;
  findDepositAddressByAddress(input: { chainId: number; address: string }): Promise<DropshipUsdcDepositAddressRecord | null>;
  listDepositAddresses(input: { chainId: number }): Promise<DropshipUsdcDepositAddressRecord[]>;
  assignDepositAddress(input: AssignDropshipUsdcDepositAddressRepositoryInput): Promise<{ address: DropshipUsdcDepositAddressRecord; created: boolean }>;
  readWatcherCursor(input: { chainId: number; tokenAddress: string }): Promise<DropshipUsdcWatcherCursorRecord | null>;
  advanceWatcherCursor(input: { chainId: number; tokenAddress: string; lastScannedBlock: number; updatedAt: Date }): Promise<DropshipUsdcWatcherCursorRecord>;
  listCustodyExpectations(input: { chainId: number }): Promise<DropshipUsdcCustodyExpectation[]>;
}

export interface DropshipUsdcDepositAddressDeriver {
  readonly keyFingerprint: string;
  deriveDepositAddress(derivationIndex: number): DerivedDropshipUsdcDepositAddress;
}

export interface DropshipUsdcChainLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
}

export type DropshipUsdcBlockTag = "latest" | "safe" | "finalized";

/** The reads the watcher needs from a node; the JSON-RPC client implements it. */
export interface DropshipUsdcChainReader {
  chainId(): Promise<number>;
  blockNumber(): Promise<number>;
  getBlock(reference: number | DropshipUsdcBlockTag): Promise<{ number: number; hash: string; timestamp: number } | null>;
  getLogs(filter: { fromBlock: number; toBlock: number; address: string; topics: (string | string[] | null)[] }): Promise<DropshipUsdcChainLog[]>;
  getTransactionReceipt(transactionHash: string): Promise<{ transactionHash: string; blockNumber: number; blockHash: string; succeeded: boolean; logs: DropshipUsdcChainLog[] } | null>;
  call(input: { to: string; data: string }, block?: DropshipUsdcBlockTag): Promise<string>;
}

// ---- configuration ----

export const dropshipUsdcWatcherConfigSchema = z.object({
  chainId: z.number().int().positive(),
  tokenAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
  /** Blocks a transfer must have (its own counts) before it is credited as pending. */
  minConfirmations: z.number().int().min(1).max(10_000),
  /** The node tag a block must be at or below to settle: `safe` (batched to L1) or `finalized`. */
  settleTag: z.enum(["safe", "finalized"]),
  /** How far the chain must move past a vanished transfer's block before its credit is voided. */
  voidAfterBlocks: z.number().int().min(1).max(100_000),
  /** The most blocks one scan tick covers. */
  maxBlockSpan: z.number().int().min(1).max(100_000),
  /** Where the first scan starts when no cursor exists; null starts at the confirmed head. */
  startBlock: z.number().int().min(0).nullable(),
  /** Vendor addresses per getLogs request. */
  addressBatchSize: z.number().int().min(1).max(1_000),
  /** Pending credits judged per settlement tick. */
  settlementBatchSize: z.number().int().min(1).max(5_000),
}).strict();

export type DropshipUsdcWatcherConfig = z.infer<typeof dropshipUsdcWatcherConfigSchema>;

/**
 * Circle's USDC on Base mainnet. The address is a default, not a trust
 * anchor: before any scan the service checks the contract answers
 * `symbol() == "USDC"` and `decimals() == 6` on chain 8453.
 */
export const BASE_USDC_TOKEN_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const USDC_TOKEN_SYMBOL = "USDC";

export const DEFAULT_USDC_WATCHER_CONFIG: DropshipUsdcWatcherConfig = {
  chainId: BASE_MAINNET_CHAIN_ID,
  tokenAddress: BASE_USDC_TOKEN_ADDRESS,
  minConfirmations: 6,
  settleTag: "safe",
  voidAfterBlocks: 60,
  maxBlockSpan: 2_000,
  startBlock: null,
  addressBatchSize: 200,
  settlementBatchSize: 200,
};

// ---- results ----

export type DropshipUsdcChainVerification =
  | { ok: true; chainId: number; decimals: number; symbol: string }
  | { ok: false; code: string; message: string; context: Record<string, unknown> };

export interface DropshipUsdcOffering {
  /** Vendors can be handed an address: a key is configured. */
  offered: boolean;
  /** Deposits are credited automatically: a node is configured too. */
  watched: boolean;
  chainId: number;
  tokenAddress: string;
  minConfirmations: number;
  settleTag: DropshipUsdcBlockTag;
  keyFingerprint: string | null;
}

export interface DropshipUsdcScanResult {
  outcome: "not_configured" | "chain_unverified" | "chain_unavailable" | "caught_up" | "scanned";
  headBlockNumber: number | null;
  safeBlockNumber: number | null;
  fromBlock: number | null;
  toBlock: number | null;
  /** Where the cursor stands after this tick. */
  scannedToBlock: number | null;
  addressCount: number;
  logCount: number;
  observedCount: number;
  pendingCount: number;
  settledCount: number;
  dustCount: number;
  replayedCount: number;
  failedCount: number;
}

export interface DropshipUsdcSettlementResult {
  outcome: "not_configured" | "chain_unverified" | "chain_unavailable" | "judged";
  headBlockNumber: number | null;
  safeBlockNumber: number | null;
  scannedCount: number;
  settledCount: number;
  waitingCount: number;
  movedCount: number;
  voidedCount: number;
  failedCount: number;
}

export interface DropshipUsdcCustodyAddressReport {
  depositAddressId: number;
  vendorId: number;
  address: string;
  checksumAddress: string;
  expectedAtomicUnits: string;
  onChainAtomicUnits: string | null;
  creditedCents: number;
  observationCount: number;
  status: UsdcCustodyStatus | "unread";
  unrecordedAtomicUnits: string;
}

export interface DropshipUsdcCustodyReport {
  outcome: "not_configured" | "chain_unverified" | "checked";
  checkedAt: Date;
  chainId: number;
  tokenAddress: string;
  addresses: DropshipUsdcCustodyAddressReport[];
  totals: {
    expectedAtomicUnits: string;
    onChainAtomicUnits: string;
    unrecordedAtomicUnits: string;
    reviewCount: number;
    unreadCount: number;
  };
}

const vendorIdSchema = z.number().int().positive();
const workerInputSchema = z.object({ workerId: z.string().trim().min(1).max(120) }).strict();
const WALLET_CURRENCY = "USD";
const USDC_DEPOSIT_REORGED = "DROPSHIP_USDC_DEPOSIT_REORGED";

export class DropshipUsdcDepositService {
  private verifiedChain: Extract<DropshipUsdcChainVerification, { ok: true }> | null = null;
  private lastVerificationFailureCode: string | null = null;

  constructor(
    private readonly deps: {
      depositRepository: DropshipUsdcDepositRepository;
      ledgerRepository: DropshipUsdcDepositLedgerRepository;
      /** Null when no account key is configured: USDC deposits are not offered. */
      deriver: DropshipUsdcDepositAddressDeriver | null;
      /** Null when no node is configured: nothing is watched. */
      chain: DropshipUsdcChainReader | null;
      config: DropshipUsdcWatcherConfig;
      notificationSender?: DropshipNotificationSender;
      /** Resumes a vendor paused for funding once a settled deposit funds the wallet. */
      vendorStanding?: Pick<DropshipVendorStandingService, "restoreIfFunded">;
      /** Resolves the signed-in member to their vendor for the portal routes. */
      vendorProvisioning?: Pick<DropshipVendorProvisioningService, "provisionForMember">;
      clock: DropshipClock;
      logger: DropshipLogger;
    },
  ) {
    const parsed = dropshipUsdcWatcherConfigSchema.safeParse(deps.config);
    if (!parsed.success) {
      throw new DropshipError(
        "DROPSHIP_USDC_WATCHER_MISCONFIGURED",
        "The USDC watcher configuration is not usable.",
        { issues: parsed.error.issues.slice(0, 5), classification: "fatal" },
      );
    }
  }

  offering(): DropshipUsdcOffering {
    return {
      offered: this.deps.deriver !== null,
      watched: this.deps.deriver !== null && this.deps.chain !== null,
      chainId: this.deps.config.chainId,
      tokenAddress: this.deps.config.tokenAddress,
      minConfirmations: this.deps.config.minConfirmations,
      settleTag: this.deps.config.settleTag,
      keyFingerprint: this.deps.deriver?.keyFingerprint ?? null,
    };
  }

  /**
   * Index 0 under the configured key: the operator compares it with their
   * own wallet's first receiving address once, proving the key and path
   * (docs/DROPSHIP-USDC-CUSTODY-RUNBOOK.md). Null when no key is configured.
   */
  verificationAddress(): string | null {
    return this.deps.deriver?.deriveDepositAddress(0).checksumAddress ?? null;
  }

  /** The signed-in member's vendor is handed their address. */
  async assignDepositAddressForMember(memberId: string): Promise<{ address: DropshipUsdcDepositAddressRecord; created: boolean }> {
    if (!this.deps.vendorProvisioning) {
      throw new DropshipError(
        "DROPSHIP_USDC_DEPOSIT_INVALID_INPUT",
        "Vendor provisioning is not available to resolve the member.",
        { classification: "fatal" },
      );
    }
    const provisioned = await this.deps.vendorProvisioning.provisionForMember(memberId);
    return this.assignDepositAddress(provisioned.vendor.vendorId);
  }

  /** The address the vendor was handed, if any. A read: nothing is assigned here. */
  async getDepositAddress(vendorId: number): Promise<DropshipUsdcDepositAddressRecord | null> {
    return this.deps.depositRepository.findDepositAddress({
      vendorId: parseVendorId(vendorId),
      chainId: this.deps.config.chainId,
    });
  }

  /** Hand the vendor an address under the configured key; the same one every time after. */
  async assignDepositAddress(vendorId: number): Promise<{ address: DropshipUsdcDepositAddressRecord; created: boolean }> {
    const parsedVendorId = parseVendorId(vendorId);
    const deriver = this.deps.deriver;
    if (!deriver) {
      throw new DropshipError(
        "DROPSHIP_USDC_DEPOSITS_NOT_OFFERED",
        "USDC deposits are not offered: no account key is configured.",
        { vendorId: parsedVendorId, classification: "permanent" },
      );
    }
    const result = await this.deps.depositRepository.assignDepositAddress({
      vendorId: parsedVendorId,
      chainId: this.deps.config.chainId,
      keyFingerprint: deriver.keyFingerprint,
      derive: (derivationIndex) => deriver.deriveDepositAddress(derivationIndex),
      assignedAt: this.deps.clock.now(),
    });
    if (result.created) {
      this.deps.logger.info({
        code: "DROPSHIP_USDC_DEPOSIT_ADDRESS_ASSIGNED",
        message: "A vendor was handed their USDC deposit address.",
        context: {
          vendorId: parsedVendorId,
          depositAddressId: result.address.depositAddressId,
          chainId: result.address.chainId,
          keyFingerprint: result.address.keyFingerprint,
          derivationIndex: result.address.derivationIndex,
          address: result.address.address,
        },
      });
    }
    return result;
  }

  /**
   * Prove the node and the token are what the configuration says before any
   * money is read from them: the chain id, `decimals() == 6` and
   * `symbol() == "USDC"`. A pass is remembered for the life of the process.
   */
  async verifyChain(): Promise<DropshipUsdcChainVerification> {
    if (this.verifiedChain) return this.verifiedChain;
    const chain = this.deps.chain;
    if (!chain) {
      return { ok: false, code: "DROPSHIP_USDC_CHAIN_NOT_CONFIGURED", message: "No USDC node is configured.", context: {} };
    }
    const { chainId, tokenAddress } = this.deps.config;
    let verification: DropshipUsdcChainVerification;
    try {
      const reportedChainId = await chain.chainId();
      if (reportedChainId !== chainId) {
        verification = failedVerification("DROPSHIP_USDC_CHAIN_ID_MISMATCH", "The node is not on the configured chain.", { expectedChainId: chainId, reportedChainId });
      } else {
        const decimals = decodeUint8Word(await chain.call({ to: tokenAddress, data: ERC20_SELECTORS.decimals }), "decimals");
        const symbol = decodeAbiString(await chain.call({ to: tokenAddress, data: ERC20_SELECTORS.symbol }), "symbol");
        if (decimals !== USDC_DECIMALS || symbol !== USDC_TOKEN_SYMBOL) {
          verification = failedVerification("DROPSHIP_USDC_TOKEN_MISMATCH", "The configured token contract is not USDC with six decimals.", { tokenAddress, decimals, symbol });
        } else {
          verification = { ok: true, chainId: reportedChainId, decimals, symbol };
        }
      }
    } catch (error) {
      verification = failedVerification(
        error instanceof DropshipError ? error.code : "DROPSHIP_USDC_CHAIN_VERIFICATION_FAILED",
        error instanceof Error ? error.message : String(error),
        { tokenAddress, classification: classificationOf(error) },
      );
    }
    if (verification.ok) {
      this.verifiedChain = verification;
      this.lastVerificationFailureCode = null;
      this.deps.logger.info({
        code: "DROPSHIP_USDC_CHAIN_VERIFIED",
        message: "The USDC node and token contract answer as configured.",
        context: { chainId: verification.chainId, tokenAddress, decimals: verification.decimals, symbol: verification.symbol },
      });
    } else if (verification.code !== this.lastVerificationFailureCode) {
      // Once per distinct failure, not once per tick: a human is needed, and
      // the same line every thirty seconds would only bury it.
      this.lastVerificationFailureCode = verification.code;
      this.deps.logger.error({
        code: "DROPSHIP_USDC_CHAIN_UNVERIFIED",
        message: `USDC deposits are not being watched: ${verification.message}`,
        context: { ...verification.context, verificationCode: verification.code, requiresReview: true },
      });
    }
    return verification;
  }

  /** One scan tick: credit every USDC transfer to a vendor address in the next block range. */
  async runScan(input: unknown): Promise<DropshipUsdcScanResult> {
    const { workerId } = workerInputSchema.parse(input);
    const result = emptyScanResult();
    const chain = this.deps.chain;
    if (!chain || !this.deps.deriver) {
      return { ...result, outcome: "not_configured" };
    }
    const verification = await this.verifyChain();
    if (!verification.ok) {
      return { ...result, outcome: "chain_unverified" };
    }
    const { chainId, tokenAddress, minConfirmations, maxBlockSpan, addressBatchSize, startBlock, settleTag } = this.deps.config;
    const now = this.deps.clock.now();
    const headBlockNumber = await chain.blockNumber();
    const safeBlock = await chain.getBlock(settleTag);
    if (!safeBlock) {
      this.deps.logger.warn({
        code: "DROPSHIP_USDC_CHAIN_UNAVAILABLE",
        message: `The node did not answer for the ${settleTag} block; the scan waits for the next tick.`,
        context: { workerId, chainId, settleTag, headBlockNumber },
      });
      return { ...result, outcome: "chain_unavailable", headBlockNumber };
    }
    result.headBlockNumber = headBlockNumber;
    result.safeBlockNumber = safeBlock.number;

    const cursor = await this.deps.depositRepository.readWatcherCursor({ chainId, tokenAddress });
    // A transfer in block b has head - b + 1 confirmations: the newest block
    // this tick may credit is the one with exactly minConfirmations.
    const confirmedHead = headBlockNumber - (minConfirmations - 1);
    const fromBlock = cursor ? cursor.lastScannedBlock + 1 : (startBlock ?? confirmedHead);
    const toBlock = Math.min(confirmedHead, fromBlock + maxBlockSpan - 1);
    if (toBlock < fromBlock) {
      return { ...result, outcome: "caught_up", fromBlock, toBlock: null, scannedToBlock: cursor?.lastScannedBlock ?? null };
    }
    result.fromBlock = fromBlock;
    result.toBlock = toBlock;

    const addresses = await this.deps.depositRepository.listDepositAddresses({ chainId });
    result.addressCount = addresses.length;
    const byAddress = new Map(addresses.map((record) => [record.address, record] as const));
    const logs: DropshipUsdcChainLog[] = [];
    for (let offset = 0; offset < addresses.length; offset += addressBatchSize) {
      const chunk = addresses.slice(offset, offset + addressBatchSize);
      logs.push(...await chain.getLogs({
        fromBlock,
        toBlock,
        address: tokenAddress,
        topics: [ERC20_TRANSFER_TOPIC, null, chunk.map((record) => addressToTopic(record.address))],
      }));
    }
    result.logCount = logs.length;
    const ordered = logs
      .map((log) => ({ log, blockNumber: hexQuantityToSafeInteger(log.blockNumber, "log.blockNumber"), logIndex: hexQuantityToSafeInteger(log.logIndex, "log.logIndex") }))
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

    let stoppedAtBlock: number | null = null;
    for (const { log, blockNumber } of ordered) {
      try {
        const transfer = decodeUsdcTransferLog(log, { chainId, tokenAddress });
        const depositAddress = byAddress.get(transfer.toAddress);
        if (!depositAddress) {
          // Not one of ours: the filter asked only for our addresses, so this
          // is a node answering outside its filter. Ignored, never credited.
          this.deps.logger.warn({
            code: "DROPSHIP_USDC_DEPOSIT_UNMATCHED",
            message: "The node returned a USDC transfer to an address that is not a vendor deposit address.",
            context: { workerId, transactionHash: transfer.transactionHash, logIndex: transfer.logIndex, toAddress: transfer.toAddress },
          });
          continue;
        }
        const decision = decideUsdcDepositObservation({
          transferBlockNumber: transfer.blockNumber,
          headBlockNumber,
          safeBlockNumber: safeBlock.number,
          minConfirmations,
        });
        if (decision.outcome === "wait") {
          stoppedAtBlock = transfer.blockNumber - 1;
          break;
        }
        const conversion = usdcAtomicUnitsToCents(transfer.amountAtomicUnits);
        const status = conversion.cents === 0 ? "dust" : decision.outcome;
        const observed = await this.deps.ledgerRepository.observeUsdcDeposit({
          vendorId: depositAddress.vendorId,
          depositAddressId: depositAddress.depositAddressId,
          transfer,
          amountCents: conversion.cents,
          dustAtomicUnits: conversion.dustAtomicUnits,
          confirmations: decision.confirmations,
          status,
          currency: WALLET_CURRENCY,
          requestHash: hashObservation(transfer, depositAddress),
          occurredAt: now,
        });
        if (observed.idempotentReplay) {
          result.replayedCount += 1;
          if (observed.usdcLedgerEntry.status === "voided") {
            // The credit was voided as reorged and the transfer is back on the
            // canonical chain. Automation never re-credits a voided row; a
            // human credits it by hand with the transaction on file.
            this.deps.logger.error({
              code: "DROPSHIP_USDC_DEPOSIT_REAPPEARED",
              message: "A voided USDC deposit reappeared on chain; credit it manually.",
              context: { workerId, vendorId: depositAddress.vendorId, usdcLedgerEntryId: observed.usdcLedgerEntry.usdcLedgerEntryId, transactionHash: transfer.transactionHash, logIndex: transfer.logIndex, requiresReview: true },
            });
          }
          continue;
        }
        result.observedCount += 1;
        if (status === "dust") result.dustCount += 1;
        else if (status === "settled") result.settledCount += 1;
        else result.pendingCount += 1;
        this.deps.logger.info({
          code: "DROPSHIP_USDC_DEPOSIT_OBSERVED",
          message: `A USDC deposit was recorded as ${status}.`,
          context: {
            workerId,
            vendorId: depositAddress.vendorId,
            depositAddressId: depositAddress.depositAddressId,
            usdcLedgerEntryId: observed.usdcLedgerEntry.usdcLedgerEntryId,
            ledgerEntryId: observed.ledgerEntry?.ledgerEntryId ?? null,
            transactionHash: transfer.transactionHash,
            logIndex: transfer.logIndex,
            blockNumber: transfer.blockNumber,
            confirmations: decision.confirmations,
            amountAtomicUnits: transfer.amountAtomicUnits,
            amountCents: conversion.cents,
            dustAtomicUnits: conversion.dustAtomicUnits,
            status,
          },
        });
        if (status !== "dust") {
          await this.notifyLanded(observed, transfer, status);
        }
        if (status === "settled") {
          await this.restoreStanding(depositAddress.vendorId, {
            source: "usdc_deposit_settled",
            usdcLedgerEntryId: observed.usdcLedgerEntry.usdcLedgerEntryId,
            ledgerEntryId: observed.ledgerEntry?.ledgerEntryId ?? null,
            amountCents: conversion.cents,
          });
        }
      } catch (error) {
        // Fail closed: the cursor stops before this block, so the next tick
        // sees the same transfer again. Nothing after it is credited out of
        // order, and a permanent fault stays visible until a human acts.
        result.failedCount += 1;
        stoppedAtBlock = blockNumber - 1;
        const classification = classificationOf(error);
        const event = {
          code: "DROPSHIP_USDC_SCAN_STOPPED",
          message: `The USDC scan stopped at block ${blockNumber}: ${error instanceof Error ? error.message : String(error)}`,
          context: {
            workerId,
            blockNumber,
            transactionHash: log.transactionHash,
            logIndex: log.logIndex,
            errorCode: error instanceof DropshipError ? error.code : null,
            classification,
            requiresReview: classification !== "transient",
          },
        };
        if (classification === "transient") this.deps.logger.warn(event);
        else this.deps.logger.error(event);
        break;
      }
    }

    // A misbehaving node can answer with a log beyond the range asked for;
    // the cursor never moves past what was actually asked.
    const scannedToBlock = stoppedAtBlock === null ? toBlock : Math.min(stoppedAtBlock, toBlock);
    const cursorStands = cursor?.lastScannedBlock ?? null;
    if (scannedToBlock >= fromBlock - 1 && (cursorStands === null || scannedToBlock > cursorStands)) {
      await this.deps.depositRepository.advanceWatcherCursor({ chainId, tokenAddress, lastScannedBlock: scannedToBlock, updatedAt: now });
      result.scannedToBlock = scannedToBlock;
    } else {
      result.scannedToBlock = cursorStands;
    }
    return { ...result, outcome: "scanned" };
  }

  /** One settlement tick: judge every pending credit against where its transfer sits now. */
  async runSettlement(input: unknown): Promise<DropshipUsdcSettlementResult> {
    const { workerId } = workerInputSchema.parse(input);
    const result: DropshipUsdcSettlementResult = {
      outcome: "judged",
      headBlockNumber: null,
      safeBlockNumber: null,
      scannedCount: 0,
      settledCount: 0,
      waitingCount: 0,
      movedCount: 0,
      voidedCount: 0,
      failedCount: 0,
    };
    const chain = this.deps.chain;
    if (!chain || !this.deps.deriver) {
      return { ...result, outcome: "not_configured" };
    }
    const verification = await this.verifyChain();
    if (!verification.ok) {
      return { ...result, outcome: "chain_unverified" };
    }
    const { chainId, tokenAddress, settleTag, voidAfterBlocks, settlementBatchSize } = this.deps.config;
    const now = this.deps.clock.now();
    const headBlockNumber = await chain.blockNumber();
    const safeBlock = await chain.getBlock(settleTag);
    if (!safeBlock) {
      this.deps.logger.warn({
        code: "DROPSHIP_USDC_CHAIN_UNAVAILABLE",
        message: `The node did not answer for the ${settleTag} block; settlement waits for the next tick.`,
        context: { workerId, chainId, settleTag, headBlockNumber },
      });
      return { ...result, outcome: "chain_unavailable", headBlockNumber };
    }
    result.headBlockNumber = headBlockNumber;
    result.safeBlockNumber = safeBlock.number;

    const pending = await this.deps.ledgerRepository.listPendingUsdcDeposits({ chainId, limit: settlementBatchSize });
    for (const entry of pending) {
      result.scannedCount += 1;
      try {
        if (entry.logIndex === null || entry.blockNumber === null || entry.blockHash === null) {
          throw new DropshipError(
            "DROPSHIP_USDC_DEPOSIT_CHAIN_FACTS_MISSING",
            "A pending USDC deposit carries no log index or block; it cannot be judged automatically.",
            { usdcLedgerEntryId: entry.usdcLedgerEntryId, classification: "permanent" },
          );
        }
        const receipt = await chain.getTransactionReceipt(entry.transactionHash);
        const current = receipt && receipt.succeeded && receiptCarriesTransfer(receipt.logs, entry.logIndex, tokenAddress)
          ? { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash }
          : null;
        const decision = decideUsdcDepositSettlement({
          recordedBlockNumber: entry.blockNumber,
          recordedBlockHash: entry.blockHash,
          current,
          headBlockNumber,
          safeBlockNumber: safeBlock.number,
          voidAfterBlocks,
        });
        switch (decision.outcome) {
          case "settle": {
            const settled = await this.deps.ledgerRepository.settleUsdcDeposit({
              vendorId: entry.vendorId,
              usdcLedgerEntryId: entry.usdcLedgerEntryId,
              confirmations: decision.confirmations,
              current: current as { blockNumber: number; blockHash: string },
              occurredAt: now,
            });
            if (settled.idempotentReplay) break;
            result.settledCount += 1;
            this.deps.logger.info({
              code: "DROPSHIP_USDC_DEPOSIT_SETTLED",
              message: "A pending USDC deposit settled: the amount is available.",
              context: { workerId, vendorId: entry.vendorId, usdcLedgerEntryId: entry.usdcLedgerEntryId, ledgerEntryId: settled.ledgerEntry?.ledgerEntryId ?? null, transactionHash: entry.transactionHash, logIndex: entry.logIndex, confirmations: decision.confirmations, amountCents: settled.ledgerEntry?.amountCents ?? null },
            });
            await this.restoreStanding(entry.vendorId, {
              source: "usdc_deposit_settled",
              usdcLedgerEntryId: entry.usdcLedgerEntryId,
              ledgerEntryId: settled.ledgerEntry?.ledgerEntryId ?? null,
              amountCents: settled.ledgerEntry?.amountCents ?? null,
            });
            break;
          }
          case "void": {
            const voided = await this.deps.ledgerRepository.voidUsdcDeposit({
              vendorId: entry.vendorId,
              usdcLedgerEntryId: entry.usdcLedgerEntryId,
              reasonCode: USDC_DEPOSIT_REORGED,
              reasonMessage: `The transfer's receipt disappeared and the chain moved ${voidAfterBlocks} blocks past block ${entry.blockNumber}.`,
              occurredAt: now,
            });
            if (voided.idempotentReplay) break;
            result.voidedCount += 1;
            this.deps.logger.error({
              code: "DROPSHIP_USDC_DEPOSIT_VOIDED",
              message: "A pending USDC deposit was voided: the network dropped its transaction.",
              context: { workerId, vendorId: entry.vendorId, usdcLedgerEntryId: entry.usdcLedgerEntryId, ledgerEntryId: voided.ledgerEntry?.ledgerEntryId ?? null, transactionHash: entry.transactionHash, logIndex: entry.logIndex, recordedBlockNumber: entry.blockNumber, headBlockNumber, requiresReview: true },
            });
            await this.notifyVoided(voided, entry);
            break;
          }
          case "moved": {
            await this.deps.ledgerRepository.recordUsdcDepositMoved({
              vendorId: entry.vendorId,
              usdcLedgerEntryId: entry.usdcLedgerEntryId,
              confirmations: decision.confirmations,
              current: current as { blockNumber: number; blockHash: string },
              occurredAt: now,
            });
            result.movedCount += 1;
            this.deps.logger.info({
              code: "DROPSHIP_USDC_DEPOSIT_MOVED",
              message: "A pending USDC deposit was re-included in another block; it is judged again next tick.",
              context: { workerId, vendorId: entry.vendorId, usdcLedgerEntryId: entry.usdcLedgerEntryId, transactionHash: entry.transactionHash, logIndex: entry.logIndex, previousBlockNumber: entry.blockNumber, blockNumber: current?.blockNumber ?? null },
            });
            break;
          }
          case "wait":
            result.waitingCount += 1;
            break;
        }
      } catch (error) {
        result.failedCount += 1;
        const classification = classificationOf(error);
        const event = {
          code: "DROPSHIP_USDC_SETTLEMENT_FAILED",
          message: `A pending USDC deposit could not be judged: ${error instanceof Error ? error.message : String(error)}`,
          context: { workerId, vendorId: entry.vendorId, usdcLedgerEntryId: entry.usdcLedgerEntryId, transactionHash: entry.transactionHash, errorCode: error instanceof DropshipError ? error.code : null, classification, requiresReview: classification !== "transient" },
        };
        if (classification === "transient") this.deps.logger.warn(event);
        else this.deps.logger.error(event);
      }
    }
    return result;
  }

  /** The on-chain balance of every deposit address against what the ledger expects there. */
  async runCustodyCheck(): Promise<DropshipUsdcCustodyReport> {
    const { chainId, tokenAddress } = this.deps.config;
    const checkedAt = this.deps.clock.now();
    const empty: DropshipUsdcCustodyReport = {
      outcome: "checked",
      checkedAt,
      chainId,
      tokenAddress,
      addresses: [],
      totals: { expectedAtomicUnits: "0", onChainAtomicUnits: "0", unrecordedAtomicUnits: "0", reviewCount: 0, unreadCount: 0 },
    };
    const chain = this.deps.chain;
    if (!chain || !this.deps.deriver) {
      return { ...empty, outcome: "not_configured" };
    }
    const verification = await this.verifyChain();
    if (!verification.ok) {
      return { ...empty, outcome: "chain_unverified" };
    }
    const expectations = await this.deps.depositRepository.listCustodyExpectations({ chainId });
    const addresses: DropshipUsdcCustodyAddressReport[] = [];
    let expectedTotal = BigInt(0);
    let onChainTotal = BigInt(0);
    let unrecordedTotal = BigInt(0);
    let reviewCount = 0;
    let unreadCount = 0;
    for (const expectation of expectations) {
      expectedTotal += BigInt(expectation.expectedAtomicUnits);
      let onChainAtomicUnits: string | null = null;
      try {
        onChainAtomicUnits = decodeUint256Word(await chain.call({ to: tokenAddress, data: encodeBalanceOfCall(expectation.address) }), "balanceOf").toString();
      } catch (error) {
        unreadCount += 1;
        this.deps.logger.warn({
          code: "DROPSHIP_USDC_CUSTODY_BALANCE_UNREAD",
          message: "The on-chain balance of a deposit address could not be read.",
          context: { depositAddressId: expectation.depositAddressId, address: expectation.address, error: error instanceof Error ? error.message : String(error) },
        });
        addresses.push({ ...expectation, onChainAtomicUnits: null, status: "unread", unrecordedAtomicUnits: "0" });
        continue;
      }
      const comparison = compareUsdcCustody({ expectedAtomicUnits: expectation.expectedAtomicUnits, onChainAtomicUnits });
      onChainTotal += BigInt(onChainAtomicUnits);
      unrecordedTotal += BigInt(comparison.unrecordedAtomicUnits);
      if (comparison.status === "unrecorded_funds") {
        reviewCount += 1;
        this.deps.logger.error({
          code: "DROPSHIP_USDC_CUSTODY_UNRECORDED_FUNDS",
          message: "A deposit address holds USDC the ledger never credited.",
          context: { vendorId: expectation.vendorId, depositAddressId: expectation.depositAddressId, address: expectation.address, expectedAtomicUnits: expectation.expectedAtomicUnits, onChainAtomicUnits, unrecordedAtomicUnits: comparison.unrecordedAtomicUnits, requiresReview: true },
        });
      }
      addresses.push({ ...expectation, onChainAtomicUnits, status: comparison.status, unrecordedAtomicUnits: comparison.unrecordedAtomicUnits });
    }
    return {
      ...empty,
      addresses,
      totals: {
        expectedAtomicUnits: expectedTotal.toString(),
        onChainAtomicUnits: onChainTotal.toString(),
        unrecordedAtomicUnits: unrecordedTotal.toString(),
        reviewCount,
        unreadCount,
      },
    };
  }

  private async notifyLanded(observed: DropshipUsdcDepositLedgerResult, transfer: UsdcTransferObservation, status: "pending" | "settled"): Promise<void> {
    const cents = observed.ledgerEntry?.amountCents ?? 0;
    const referenceId = `${transfer.chainId}:${transfer.transactionHash}:${transfer.logIndex}`;
    await sendDropshipNotificationSafely(this.deps, {
      vendorId: observed.usdcLedgerEntry.vendorId,
      eventType: DROPSHIP_NOTIFICATION_EVENTS.USDC_DEPOSIT_LANDED,
      critical: false,
      channels: ["email", "in_app"],
      title: "Your USDC deposit landed",
      message: `${formatUsdcAmount(transfer.amountAtomicUnits)} USDC landed in your wallet as ${formatNotificationCurrency(cents, observed.account.currency)}. ${status === "settled" ? "It is available now." : "It becomes available once the network settles it, usually within a few minutes."} No fee.`,
      payload: {
        vendorId: observed.usdcLedgerEntry.vendorId,
        usdcLedgerEntryId: observed.usdcLedgerEntry.usdcLedgerEntryId,
        ledgerEntryId: observed.ledgerEntry?.ledgerEntryId ?? null,
        transactionHash: transfer.transactionHash,
        logIndex: transfer.logIndex,
        amountAtomicUnits: transfer.amountAtomicUnits,
        amountCents: cents,
        status,
      },
      idempotencyKey: `usdc-deposit-landed:${referenceId}`,
    }, {
      code: "DROPSHIP_USDC_DEPOSIT_NOTIFICATION_FAILED",
      message: "The USDC deposit notice failed after the deposit was recorded.",
      context: { vendorId: observed.usdcLedgerEntry.vendorId, usdcLedgerEntryId: observed.usdcLedgerEntry.usdcLedgerEntryId },
    });
  }

  private async notifyVoided(voided: DropshipUsdcDepositLedgerResult, entry: DropshipUsdcLedgerEntryRecord): Promise<void> {
    const cents = voided.ledgerEntry?.amountCents ?? 0;
    const referenceId = `${entry.chainId}:${entry.transactionHash}:${entry.logIndex ?? -1}`;
    await sendDropshipNotificationSafely(this.deps, {
      vendorId: entry.vendorId,
      eventType: DROPSHIP_NOTIFICATION_EVENTS.USDC_DEPOSIT_VOIDED,
      critical: true,
      channels: ["email", "in_app"],
      title: "A USDC deposit was not confirmed",
      message: `The network did not confirm your transfer of ${formatUsdcAmount(entry.amountAtomicUnits)} USDC (transaction ${shortenHash(entry.transactionHash)}). ${formatNotificationCurrency(cents, voided.account.currency)} has been removed from your wallet balance. Check the transaction in the wallet you sent from; if it completes later, contact support with the transaction id.`,
      payload: {
        vendorId: entry.vendorId,
        usdcLedgerEntryId: entry.usdcLedgerEntryId,
        ledgerEntryId: voided.ledgerEntry?.ledgerEntryId ?? null,
        transactionHash: entry.transactionHash,
        logIndex: entry.logIndex,
        amountAtomicUnits: entry.amountAtomicUnits,
        amountCents: cents,
      },
      idempotencyKey: `usdc-deposit-voided:${referenceId}`,
    }, {
      code: "DROPSHIP_USDC_DEPOSIT_NOTIFICATION_FAILED",
      message: "The USDC deposit void notice failed after the void committed.",
      context: { vendorId: entry.vendorId, usdcLedgerEntryId: entry.usdcLedgerEntryId },
    });
  }

  private async restoreStanding(vendorId: number, evidence: Record<string, unknown>): Promise<void> {
    if (!this.deps.vendorStanding) return;
    try {
      await this.deps.vendorStanding.restoreIfFunded({ vendorId, evidence });
    } catch (error) {
      this.deps.logger.error({
        code: "DROPSHIP_USDC_VENDOR_RESTORE_FAILED",
        message: "Dropship vendor standing could not be checked after a settled USDC deposit; the hourly reconcile retries.",
        context: { vendorId, error: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}

// ---- helpers ----

function emptyScanResult(): DropshipUsdcScanResult {
  return {
    outcome: "scanned",
    headBlockNumber: null,
    safeBlockNumber: null,
    fromBlock: null,
    toBlock: null,
    scannedToBlock: null,
    addressCount: 0,
    logCount: 0,
    observedCount: 0,
    pendingCount: 0,
    settledCount: 0,
    dustCount: 0,
    replayedCount: 0,
    failedCount: 0,
  };
}

function failedVerification(code: string, message: string, context: Record<string, unknown>): DropshipUsdcChainVerification {
  return { ok: false, code, message, context };
}

function parseVendorId(vendorId: number): number {
  const parsed = vendorIdSchema.safeParse(vendorId);
  if (!parsed.success) {
    throw new DropshipError(
      "DROPSHIP_USDC_DEPOSIT_INVALID_INPUT",
      "A vendor id must be a positive integer.",
      { vendorId, classification: "permanent" },
    );
  }
  return parsed.data;
}

/** The transfer's receipt still carries the very log that was credited. */
function receiptCarriesTransfer(logs: DropshipUsdcChainLog[], logIndex: number, tokenAddress: string): boolean {
  return logs.some((log) =>
    hexQuantityToSafeInteger(log.logIndex, "receipt.log.logIndex") === logIndex
    && normalizeEvmAddress(log.address, "receipt.log.address") === tokenAddress
    && (log.topics[0] ?? "").toLowerCase() === ERC20_TRANSFER_TOPIC);
}

/** Pins the observation's facts so a replay with different details is caught, not merged. */
function hashObservation(transfer: UsdcTransferObservation, depositAddress: DropshipUsdcDepositAddressRecord): string {
  return createHash("sha256").update(JSON.stringify({
    chainId: transfer.chainId,
    tokenAddress: transfer.tokenAddress,
    transactionHash: transfer.transactionHash,
    logIndex: transfer.logIndex,
    fromAddress: transfer.fromAddress,
    toAddress: transfer.toAddress,
    amountAtomicUnits: transfer.amountAtomicUnits,
    vendorId: depositAddress.vendorId,
    depositAddressId: depositAddress.depositAddressId,
  })).digest("hex");
}

/** "25123456" → "25.123456"; "25000000" → "25.00". Integer arithmetic only. */
export function formatUsdcAmount(amountAtomicUnits: string): string {
  const atomic = BigInt(amountAtomicUnits);
  // 10^USDC_DECIMALS, spelled out: `**` on bigints is not available at this compile target.
  const scale = BigInt(1_000_000);
  const whole = atomic / scale;
  const fraction = (atomic % scale).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fraction.length < 2 ? fraction.padEnd(2, "0") : fraction}`;
}

function shortenHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

function classificationOf(error: unknown): "transient" | "permanent" | "fatal" {
  if (error instanceof DropshipError) {
    const classification = error.context?.classification;
    if (classification === "transient" || classification === "permanent" || classification === "fatal") {
      return classification;
    }
    return "permanent";
  }
  // A database or runtime failure with no classification: the next tick
  // retries it, and the log line carries it to a human.
  return "transient";
}

export const systemDropshipUsdcDepositClock: DropshipClock = { now: () => new Date() };

export function makeDropshipUsdcDepositLogger(): DropshipLogger {
  return {
    info: (event) => console.info(JSON.stringify({ level: "info", ...event })),
    warn: (event) => console.warn(JSON.stringify({ level: "warn", ...event })),
    error: (event) => console.error(JSON.stringify({ level: "error", ...event })),
  };
}
