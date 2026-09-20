import { describe, expect, it } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  BASE_MAINNET_CHAIN_ID,
  DROPSHIP_USDC_DEPOSIT_INVALID,
  DROPSHIP_USDC_TRANSFER_LOG_INVALID,
  ERC20_TRANSFER_TOPIC,
  MAX_DEPOSIT_DERIVATION_INDEX,
  compareUsdcCustody,
  decideUsdcDepositObservation,
  decideUsdcDepositSettlement,
  decodeUsdcTransferLog,
  depositDerivationPath,
  toChecksumAddress,
  usdcAtomicUnitsToCents,
  usdcCentsToAtomicUnits,
} from "../../domain/usdc-deposits";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const VENDOR_ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const SENDER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const TX = `0x${"ab".repeat(32)}`;
const BLOCK_HASH = `0x${"cd".repeat(32)}`;
const OTHER_BLOCK_HASH = `0x${"ef".repeat(32)}`;

function topic(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2)}`;
}

function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function transferLog(overrides: Partial<Parameters<typeof decodeUsdcTransferLog>[0]> = {}) {
  return {
    address: USDC,
    topics: [ERC20_TRANSFER_TOPIC, topic(SENDER), topic(VENDOR_ADDRESS)],
    data: word(BigInt(25_123_456)),
    blockNumber: "0x2160ec0",
    blockHash: BLOCK_HASH,
    transactionHash: TX,
    logIndex: "0x7",
    ...overrides,
  };
}

describe("decodeUsdcTransferLog", () => {
  it("reads the sender, the vendor address, the amount and the log's place from a Transfer log", () => {
    expect(decodeUsdcTransferLog(transferLog(), { chainId: BASE_MAINNET_CHAIN_ID, tokenAddress: USDC })).toEqual({
      chainId: 8453,
      tokenAddress: USDC,
      transactionHash: TX,
      logIndex: 7,
      blockNumber: 35_000_000,
      blockHash: BLOCK_HASH,
      fromAddress: SENDER,
      toAddress: VENDOR_ADDRESS,
      amountAtomicUnits: "25123456",
    });
  });

  it("lowercases what the node capitalizes and accepts a checksummed token address", () => {
    const decoded = decodeUsdcTransferLog(
      transferLog({ transactionHash: TX.toUpperCase().replace("0X", "0x"), blockHash: BLOCK_HASH.toUpperCase().replace("0X", "0x") }),
      { chainId: BASE_MAINNET_CHAIN_ID, tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    );
    expect(decoded.transactionHash).toBe(TX);
    expect(decoded.blockHash).toBe(BLOCK_HASH);
  });

  it("refuses a log that is not this token's Transfer, a removed log, a zero amount and malformed fields", () => {
    const expected = { chainId: BASE_MAINNET_CHAIN_ID, tokenAddress: USDC };
    const refused = (log: ReturnType<typeof transferLog>) =>
      expect(() => decodeUsdcTransferLog(log, expected)).toThrowError(expect.objectContaining({ code: DROPSHIP_USDC_TRANSFER_LOG_INVALID }));
    refused(transferLog({ address: SENDER }));
    refused(transferLog({ topics: [`0x${"11".repeat(32)}`, topic(SENDER), topic(VENDOR_ADDRESS)] }));
    refused(transferLog({ topics: [ERC20_TRANSFER_TOPIC, topic(SENDER)] }));
    refused(transferLog({ removed: true }));
    refused(transferLog({ data: word(BigInt(0)) }));
    refused(transferLog({ blockHash: "0x1234" }));
    refused(transferLog({ transactionHash: "0x1234" }));
    // An indexed value whose leading bytes are not zero is not an address.
    expect(() => decodeUsdcTransferLog(transferLog({ topics: [ERC20_TRANSFER_TOPIC, `0x1${"0".repeat(63)}`, topic(VENDOR_ADDRESS)] }), expected))
      .toThrowError(expect.objectContaining({ code: "DROPSHIP_EVM_ABI_INVALID" }));
  });
});

describe("usdcAtomicUnitsToCents", () => {
  it("credits whole cents and leaves the remainder as dust", () => {
    expect(usdcAtomicUnitsToCents("25123456")).toEqual({ cents: 2512, dustAtomicUnits: "3456" });
    expect(usdcAtomicUnitsToCents("10000")).toEqual({ cents: 1, dustAtomicUnits: "0" });
    expect(usdcAtomicUnitsToCents("9999")).toEqual({ cents: 0, dustAtomicUnits: "9999" });
    expect(usdcAtomicUnitsToCents("0")).toEqual({ cents: 0, dustAtomicUnits: "0" });
    expect(usdcAtomicUnitsToCents("1000000000000")).toEqual({ cents: 100_000_000, dustAtomicUnits: "0" });
  });

  it("is exact for amounts a float would mangle, and round-trips whole cents", () => {
    expect(usdcAtomicUnitsToCents("12345678901234567890")).toEqual({ cents: 1_234_567_890_123_456, dustAtomicUnits: "7890" });
    expect(usdcCentsToAtomicUnits(2512)).toBe("25120000");
    expect(usdcCentsToAtomicUnits(0)).toBe("0");
  });

  it("refuses malformed amounts and more cents than the wallet can hold", () => {
    for (const bad of ["", "-1", "1.5", "0x10", " 12", "1".repeat(79)]) {
      expect(() => usdcAtomicUnitsToCents(bad)).toThrowError(expect.objectContaining({ code: DROPSHIP_USDC_DEPOSIT_INVALID }));
    }
    expect(() => usdcAtomicUnitsToCents(`${(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1)) * BigInt(10_000)}`))
      .toThrowError(expect.objectContaining({ code: DROPSHIP_USDC_DEPOSIT_INVALID }));
    expect(() => usdcCentsToAtomicUnits(-1)).toThrowError(expect.objectContaining({ code: DROPSHIP_USDC_DEPOSIT_INVALID }));
    expect(() => usdcCentsToAtomicUnits(1.5)).toThrowError(expect.objectContaining({ code: DROPSHIP_USDC_DEPOSIT_INVALID }));
  });
});

describe("decideUsdcDepositObservation", () => {
  const base = { headBlockNumber: 1_000, safeBlockNumber: 900, minConfirmations: 6 };

  it("waits until the transfer has the configured confirmations, counting its own block", () => {
    expect(decideUsdcDepositObservation({ ...base, transferBlockNumber: 1_000 })).toEqual({ outcome: "wait", confirmations: 1 });
    expect(decideUsdcDepositObservation({ ...base, transferBlockNumber: 996 })).toEqual({ outcome: "wait", confirmations: 5 });
    expect(decideUsdcDepositObservation({ ...base, transferBlockNumber: 995 })).toEqual({ outcome: "pending", confirmations: 6 });
  });

  it("records a confirmed transfer as pending above the safe head and settled at or below it", () => {
    expect(decideUsdcDepositObservation({ ...base, transferBlockNumber: 901 })).toEqual({ outcome: "pending", confirmations: 100 });
    expect(decideUsdcDepositObservation({ ...base, transferBlockNumber: 900 })).toEqual({ outcome: "settled", confirmations: 101 });
    expect(decideUsdcDepositObservation({ ...base, transferBlockNumber: 0 })).toEqual({ outcome: "settled", confirmations: 1_001 });
  });

  it("waits when the node's log view runs ahead of its head, and refuses malformed input", () => {
    expect(decideUsdcDepositObservation({ ...base, transferBlockNumber: 1_001 })).toEqual({ outcome: "wait", confirmations: 0 });
    expect(() => decideUsdcDepositObservation({ ...base, transferBlockNumber: -1 })).toThrowError(expect.objectContaining({ code: DROPSHIP_USDC_DEPOSIT_INVALID }));
    expect(() => decideUsdcDepositObservation({ ...base, transferBlockNumber: 1, minConfirmations: 0 })).toThrowError(expect.objectContaining({ code: DROPSHIP_USDC_DEPOSIT_INVALID }));
    expect(() => decideUsdcDepositObservation({ ...base, transferBlockNumber: 1.5 })).toThrowError(expect.objectContaining({ code: DROPSHIP_USDC_DEPOSIT_INVALID }));
  });
});

describe("decideUsdcDepositSettlement", () => {
  const base = { recordedBlockNumber: 901, recordedBlockHash: BLOCK_HASH, headBlockNumber: 1_000, safeBlockNumber: 900, voidAfterBlocks: 60 };

  it("settles once the transfer's block is at or below the safe head, and waits above it", () => {
    expect(decideUsdcDepositSettlement({ ...base, current: { blockNumber: 900, blockHash: BLOCK_HASH } })).toEqual({ outcome: "settle", confirmations: 101 });
    expect(decideUsdcDepositSettlement({ ...base, current: { blockNumber: 901, blockHash: BLOCK_HASH } })).toEqual({ outcome: "wait", confirmations: 100 });
  });

  it("voids a transfer whose receipt is gone once the chain has moved the grace past its block, and waits before that", () => {
    expect(decideUsdcDepositSettlement({ ...base, current: null })).toEqual({ outcome: "void", confirmations: 0 });
    expect(decideUsdcDepositSettlement({ ...base, recordedBlockNumber: 941, current: null })).toEqual({ outcome: "wait", confirmations: 0 });
    expect(decideUsdcDepositSettlement({ ...base, recordedBlockNumber: 940, current: null })).toEqual({ outcome: "void", confirmations: 0 });
    expect(() => decideUsdcDepositSettlement({ ...base, voidAfterBlocks: 0, current: null })).toThrowError(expect.objectContaining({ code: DROPSHIP_USDC_DEPOSIT_INVALID }));
  });

  it("re-records a transfer that moved to another block", () => {
    expect(decideUsdcDepositSettlement({ ...base, current: { blockNumber: 902, blockHash: OTHER_BLOCK_HASH } })).toEqual({ outcome: "moved", confirmations: 99 });
    // Moved is judged before settle: a block hash change is never settled on the old record.
    expect(decideUsdcDepositSettlement({ ...base, current: { blockNumber: 800, blockHash: OTHER_BLOCK_HASH } })).toEqual({ outcome: "moved", confirmations: 201 });
  });

  it("compares block hashes without regard to case and refuses malformed hashes", () => {
    expect(decideUsdcDepositSettlement({ ...base, current: { blockNumber: 900, blockHash: BLOCK_HASH.toUpperCase().replace("0X", "0x") } }).outcome).toBe("settle");
    expect(() => decideUsdcDepositSettlement({ ...base, recordedBlockHash: "0x12", current: null })).toThrowError(expect.objectContaining({ code: DROPSHIP_USDC_DEPOSIT_INVALID }));
    expect(() => decideUsdcDepositSettlement({ ...base, current: { blockNumber: 900, blockHash: "0x12" } })).toThrowError(expect.objectContaining({ code: DROPSHIP_USDC_DEPOSIT_INVALID }));
  });
});

describe("depositDerivationPath", () => {
  it("places every vendor under the external chain, within the non-hardened range", () => {
    expect(depositDerivationPath(0)).toEqual({ change: 0, index: 0 });
    expect(depositDerivationPath(MAX_DEPOSIT_DERIVATION_INDEX)).toEqual({ change: 0, index: 2_147_483_647 });
    for (const bad of [-1, 1.5, MAX_DEPOSIT_DERIVATION_INDEX + 1, Number.NaN]) {
      expect(() => depositDerivationPath(bad)).toThrowError(expect.objectContaining({ code: DROPSHIP_USDC_DEPOSIT_INVALID }));
    }
  });
});

describe("toChecksumAddress", () => {
  it("produces the EIP-55 form of well-known addresses", () => {
    expect(toChecksumAddress(VENDOR_ADDRESS, keccak_256)).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    expect(toChecksumAddress("0x70997970C51812DC3A010C7D01B50E0D17DC79C8", keccak_256)).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(toChecksumAddress(USDC, keccak_256)).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });
});

describe("compareUsdcCustody", () => {
  it("tells holding, partly swept, swept and empty apart from the on-chain balance", () => {
    expect(compareUsdcCustody({ expectedAtomicUnits: "25123456", onChainAtomicUnits: "25123456" })).toEqual({ status: "holding", unrecordedAtomicUnits: "0" });
    expect(compareUsdcCustody({ expectedAtomicUnits: "25123456", onChainAtomicUnits: "3456" })).toEqual({ status: "partly_swept", unrecordedAtomicUnits: "0" });
    expect(compareUsdcCustody({ expectedAtomicUnits: "25123456", onChainAtomicUnits: "0" })).toEqual({ status: "swept", unrecordedAtomicUnits: "0" });
    expect(compareUsdcCustody({ expectedAtomicUnits: "0", onChainAtomicUnits: "0" })).toEqual({ status: "empty", unrecordedAtomicUnits: "0" });
  });

  it("flags on-chain funds the ledger never credited", () => {
    expect(compareUsdcCustody({ expectedAtomicUnits: "25123456", onChainAtomicUnits: "30000000" })).toEqual({ status: "unrecorded_funds", unrecordedAtomicUnits: "4876544" });
    expect(compareUsdcCustody({ expectedAtomicUnits: "0", onChainAtomicUnits: "1" })).toEqual({ status: "unrecorded_funds", unrecordedAtomicUnits: "1" });
    expect(() => compareUsdcCustody({ expectedAtomicUnits: "1.0", onChainAtomicUnits: "1" })).toThrowError(expect.objectContaining({ code: DROPSHIP_USDC_DEPOSIT_INVALID }));
  });
});
