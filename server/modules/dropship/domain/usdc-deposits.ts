/**
 * USDC deposits into a Card Shellz-controlled wallet (funding design phase 6).
 *
 * Every vendor gets their own deposit address, derived from one watch-only
 * account key (the spending key never reaches the server). A watcher reads
 * USDC transfers to those addresses from Base and credits the wallet:
 *
 *  - a transfer with at least the configured confirmations is credited to the
 *    pending balance, so the vendor sees it land within a tick;
 *  - it settles (pending → available) once its block is at or below the
 *    network's safe head, which is as far as a sequencer reorg can reach;
 *  - a transfer a reorg removed before settlement is voided;
 *  - the sub-cent remainder of a transfer is dust: recorded, never credited.
 *
 * Pure rules: no clock, no chain, no database. Money is integer cents; token
 * amounts are decimal strings of atomic units (10^-6 USDC), never floats.
 */

import { DropshipError } from "./errors";
import {
  EVM_WORD_PATTERN,
  decodeUint256Word,
  hexQuantityToSafeInteger,
  normalizeEvmAddress,
  topicToAddress,
} from "./evm-abi";

export const DROPSHIP_USDC_DEPOSIT_INVALID = "DROPSHIP_USDC_DEPOSIT_INVALID";
export const DROPSHIP_USDC_TRANSFER_LOG_INVALID = "DROPSHIP_USDC_TRANSFER_LOG_INVALID";

export const BASE_MAINNET_CHAIN_ID = 8453;
export const USDC_DECIMALS = 6;
/** 10^6 atomic units per USDC and 100 cents per dollar: 10^4 atomic units per cent. */
export const USDC_ATOMIC_UNITS_PER_CENT = BigInt(10_000);
export const ERC20_TRANSFER_EVENT_SIGNATURE = "Transfer(address,address,uint256)";
/** keccak256 of the signature above; the RPC client checks it against the hash at boot. */
export const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** BIP-44 external chain: receiving addresses live under 0/i. */
export const USDC_DEPOSIT_EXTERNAL_CHAIN = 0;
/** A watch-only key derives non-hardened children only. */
export const MAX_DEPOSIT_DERIVATION_INDEX = 2 ** 31 - 1;

const ATOMIC_UNITS_PATTERN = /^[0-9]{1,78}$/;
const TRANSFER_TOPIC_COUNT = 3;

export interface UsdcTransferLogInput {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
}

/** One USDC transfer as the chain reported it. */
export interface UsdcTransferObservation {
  chainId: number;
  tokenAddress: string;
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  fromAddress: string;
  toAddress: string;
  amountAtomicUnits: string;
}

/**
 * Decode one `Transfer` log of the expected token. Every field is checked:
 * the watcher only ever asks the node for this token and this topic, so any
 * mismatch is a node or filter fault and the log is refused, never credited.
 */
export function decodeUsdcTransferLog(
  log: UsdcTransferLogInput,
  expected: { chainId: number; tokenAddress: string },
): UsdcTransferObservation {
  const tokenAddress = normalizeEvmAddress(expected.tokenAddress, "tokenAddress");
  if (log.removed === true) {
    throw logInvalid("removed", log, "is a removed (reorged) log and cannot be credited");
  }
  if (normalizeEvmAddress(log.address, "address") !== tokenAddress) {
    throw logInvalid("address", log, "is not the USDC token contract");
  }
  if (!Array.isArray(log.topics) || log.topics.length !== TRANSFER_TOPIC_COUNT) {
    throw logInvalid("topics", log, "does not carry the three Transfer topics");
  }
  if (typeof log.topics[0] !== "string" || log.topics[0].toLowerCase() !== ERC20_TRANSFER_TOPIC) {
    throw logInvalid("topics[0]", log, "is not the Transfer event");
  }
  if (typeof log.blockHash !== "string" || !EVM_WORD_PATTERN.test(log.blockHash)) {
    throw logInvalid("blockHash", log, "must be a 32-byte hex word");
  }
  if (typeof log.transactionHash !== "string" || !EVM_WORD_PATTERN.test(log.transactionHash)) {
    throw logInvalid("transactionHash", log, "must be a 32-byte hex word");
  }
  const amount = decodeUint256Word(log.data, "data");
  if (amount <= BigInt(0)) {
    throw logInvalid("data", log, "transfers nothing");
  }
  return {
    chainId: expected.chainId,
    tokenAddress,
    transactionHash: log.transactionHash.toLowerCase(),
    logIndex: hexQuantityToSafeInteger(log.logIndex, "logIndex"),
    blockNumber: hexQuantityToSafeInteger(log.blockNumber, "blockNumber"),
    blockHash: log.blockHash.toLowerCase(),
    fromAddress: topicToAddress(log.topics[1], "topics[1]"),
    toAddress: topicToAddress(log.topics[2], "topics[2]"),
    amountAtomicUnits: amount.toString(),
  };
}

export interface UsdcCentsConversion {
  /** Whole cents the wallet is credited. */
  cents: number;
  /** The remainder under one cent, left at the address and never credited. */
  dustAtomicUnits: string;
}

/** Atomic units (10^-6 USDC) to whole cents, rounding down; the remainder is dust. */
export function usdcAtomicUnitsToCents(amountAtomicUnits: string): UsdcCentsConversion {
  const atomic = parseAtomicUnits(amountAtomicUnits, "amountAtomicUnits");
  const cents = atomic / USDC_ATOMIC_UNITS_PER_CENT;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw depositInvalid("amountAtomicUnits", amountAtomicUnits, "is more cents than the wallet can hold");
  }
  return {
    cents: Number(cents),
    dustAtomicUnits: (atomic % USDC_ATOMIC_UNITS_PER_CENT).toString(),
  };
}

/** Whole cents to atomic units, exact. */
export function usdcCentsToAtomicUnits(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw depositInvalid("cents", cents, "must be a non-negative safe integer");
  }
  return (BigInt(cents) * USDC_ATOMIC_UNITS_PER_CENT).toString();
}

export type UsdcDepositObservationDecision =
  | { outcome: "wait"; confirmations: number }
  | { outcome: "pending"; confirmations: number }
  | { outcome: "settled"; confirmations: number };

/**
 * What to do with a transfer the scan just found. `confirmations` counts the
 * transfer's own block: a transfer in the head block has one.
 */
export function decideUsdcDepositObservation(input: {
  transferBlockNumber: number;
  headBlockNumber: number;
  safeBlockNumber: number;
  minConfirmations: number;
}): UsdcDepositObservationDecision {
  assertBlockNumber(input.transferBlockNumber, "transferBlockNumber");
  assertBlockNumber(input.headBlockNumber, "headBlockNumber");
  assertBlockNumber(input.safeBlockNumber, "safeBlockNumber");
  if (!Number.isSafeInteger(input.minConfirmations) || input.minConfirmations < 1) {
    throw depositInvalid("minConfirmations", input.minConfirmations, "must be at least 1");
  }
  if (input.transferBlockNumber > input.headBlockNumber) {
    // The node answered the log query from a later view than the head query:
    // count nothing and look again next tick.
    return { outcome: "wait", confirmations: 0 };
  }
  const confirmations = input.headBlockNumber - input.transferBlockNumber + 1;
  if (confirmations < input.minConfirmations) {
    return { outcome: "wait", confirmations };
  }
  if (input.transferBlockNumber <= input.safeBlockNumber) {
    return { outcome: "settled", confirmations };
  }
  return { outcome: "pending", confirmations };
}

export type UsdcDepositSettlementDecision =
  | { outcome: "settle"; confirmations: number }
  | { outcome: "wait"; confirmations: number }
  | { outcome: "moved"; confirmations: number }
  | { outcome: "void"; confirmations: 0 };

/**
 * What to do with a pending credit on a later tick, given where the transfer
 * sits now (from its receipt) and where the safe head is. A transfer whose
 * receipt is gone was reorged out; a reorged transaction is usually
 * re-included within moments, so the credit is voided only once the chain
 * has moved `voidAfterBlocks` past the block it was recorded in. One that
 * moved to another block is re-recorded and judged again next tick.
 */
export function decideUsdcDepositSettlement(input: {
  recordedBlockNumber: number;
  recordedBlockHash: string;
  current: { blockNumber: number; blockHash: string } | null;
  headBlockNumber: number;
  safeBlockNumber: number;
  voidAfterBlocks: number;
}): UsdcDepositSettlementDecision {
  assertBlockNumber(input.recordedBlockNumber, "recordedBlockNumber");
  assertBlockNumber(input.headBlockNumber, "headBlockNumber");
  assertBlockNumber(input.safeBlockNumber, "safeBlockNumber");
  if (!Number.isSafeInteger(input.voidAfterBlocks) || input.voidAfterBlocks < 1) {
    throw depositInvalid("voidAfterBlocks", input.voidAfterBlocks, "must be at least 1");
  }
  if (typeof input.recordedBlockHash !== "string" || !EVM_WORD_PATTERN.test(input.recordedBlockHash)) {
    throw depositInvalid("recordedBlockHash", input.recordedBlockHash, "must be a 32-byte hex word");
  }
  if (input.current === null) {
    return input.headBlockNumber - input.recordedBlockNumber >= input.voidAfterBlocks
      ? { outcome: "void", confirmations: 0 }
      : { outcome: "wait", confirmations: 0 };
  }
  assertBlockNumber(input.current.blockNumber, "current.blockNumber");
  if (typeof input.current.blockHash !== "string" || !EVM_WORD_PATTERN.test(input.current.blockHash)) {
    throw depositInvalid("current.blockHash", input.current.blockHash, "must be a 32-byte hex word");
  }
  const confirmations = input.current.blockNumber > input.headBlockNumber
    ? 0
    : input.headBlockNumber - input.current.blockNumber + 1;
  if (input.current.blockHash.toLowerCase() !== input.recordedBlockHash.toLowerCase()) {
    return { outcome: "moved", confirmations };
  }
  if (input.current.blockNumber <= input.safeBlockNumber) {
    return { outcome: "settle", confirmations };
  }
  return { outcome: "wait", confirmations };
}

/** The BIP-44 position of a vendor's deposit address under the account key. */
export function depositDerivationPath(index: number): { change: number; index: number } {
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_DEPOSIT_DERIVATION_INDEX) {
    throw depositInvalid("index", index, `must be an integer from 0 to ${MAX_DEPOSIT_DERIVATION_INDEX}`);
  }
  return { change: USDC_DEPOSIT_EXTERNAL_CHAIN, index };
}

/**
 * EIP-55 mixed-case checksum of an address: each hex letter is upper-cased
 * when the matching nibble of keccak256(lowercase hex) is 8 or more. The
 * hash function is injected so this rule stays pure.
 */
export function toChecksumAddress(
  address: string,
  keccak256: (bytes: Uint8Array) => Uint8Array,
): string {
  const lower = normalizeEvmAddress(address).slice(2);
  const hash = keccak256(new TextEncoder().encode(lower));
  let checksummed = "0x";
  for (let index = 0; index < lower.length; index += 1) {
    const character = lower[index] as string;
    const nibble = index % 2 === 0
      ? (hash[index / 2] as number) >> 4
      : (hash[(index - 1) / 2] as number) & 0x0f;
    checksummed += nibble >= 8 ? character.toUpperCase() : character;
  }
  return checksummed;
}

export type UsdcCustodyStatus =
  | "empty"
  | "holding"
  | "partly_swept"
  | "swept"
  | "unrecorded_funds";

export interface UsdcCustodyComparison {
  status: UsdcCustodyStatus;
  /** On-chain funds the ledger never credited: needs a human. */
  unrecordedAtomicUnits: string;
}

/**
 * Compare what the ledger expects to sit at an address (credited amounts plus
 * dust, before any sweep) with the on-chain USDC balance. Sweeps happen with
 * the offline key, so a balance below the expectation is normal; a balance
 * above it is money the watcher never credited.
 */
export function compareUsdcCustody(input: {
  expectedAtomicUnits: string;
  onChainAtomicUnits: string;
}): UsdcCustodyComparison {
  const expected = parseAtomicUnits(input.expectedAtomicUnits, "expectedAtomicUnits");
  const onChain = parseAtomicUnits(input.onChainAtomicUnits, "onChainAtomicUnits");
  if (onChain > expected) {
    return { status: "unrecorded_funds", unrecordedAtomicUnits: (onChain - expected).toString() };
  }
  if (onChain === BigInt(0)) {
    return { status: expected === BigInt(0) ? "empty" : "swept", unrecordedAtomicUnits: "0" };
  }
  return { status: onChain === expected ? "holding" : "partly_swept", unrecordedAtomicUnits: "0" };
}

export function parseAtomicUnits(value: string, field: string): bigint {
  if (typeof value !== "string" || !ATOMIC_UNITS_PATTERN.test(value)) {
    throw depositInvalid(field, value, "must be a decimal string of atomic units");
  }
  return BigInt(value);
}

function assertBlockNumber(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw depositInvalid(field, value, "must be a non-negative safe integer block number");
  }
}

function depositInvalid(field: string, value: unknown, reason: string): DropshipError {
  return new DropshipError(
    DROPSHIP_USDC_DEPOSIT_INVALID,
    `USDC deposit value ${field} ${reason}.`,
    { field, value, classification: "permanent" },
  );
}

function logInvalid(field: string, log: UsdcTransferLogInput, reason: string): DropshipError {
  return new DropshipError(
    DROPSHIP_USDC_TRANSFER_LOG_INVALID,
    `USDC transfer log ${field} ${reason}.`,
    {
      field,
      transactionHash: typeof log.transactionHash === "string" ? log.transactionHash : null,
      logIndex: typeof log.logIndex === "string" ? log.logIndex : null,
      classification: "permanent",
    },
  );
}
