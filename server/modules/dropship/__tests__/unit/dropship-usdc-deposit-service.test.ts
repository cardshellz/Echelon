import { describe, expect, it } from "vitest";
import {
  DEFAULT_USDC_WATCHER_CONFIG,
  DropshipUsdcDepositService,
  formatUsdcAmount,
  type DropshipUsdcChainLog,
  type DropshipUsdcChainReader,
  type DropshipUsdcCustodyExpectation,
  type DropshipUsdcDepositAddressDeriver,
  type DropshipUsdcDepositAddressRecord,
  type DropshipUsdcDepositRepository,
  type DropshipUsdcWatcherCursorRecord,
  type DropshipUsdcWatcherConfig,
} from "../../application/dropship-usdc-deposit-service";
import type {
  DropshipUsdcDepositLedgerRepository,
  DropshipUsdcDepositLedgerResult,
  DropshipUsdcLedgerEntryRecord,
  DropshipWalletAccountRecord,
  DropshipWalletLedgerRecord,
  ObserveDropshipUsdcDepositRepositoryInput,
  RecordDropshipUsdcDepositMovedRepositoryInput,
  SettleDropshipUsdcDepositRepositoryInput,
  VoidDropshipUsdcDepositRepositoryInput,
} from "../../application/dropship-wallet-service";
import type { DropshipLogEvent, DropshipNotificationSenderInput } from "../../application/dropship-ports";
import { DropshipError } from "../../domain/errors";
import { ERC20_TRANSFER_TOPIC } from "../../domain/usdc-deposits";

const NOW = new Date("2026-09-21T10:00:00.000Z");
const USDC = DEFAULT_USDC_WATCHER_CONFIG.tokenAddress;
const ADDRESS_A = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const ADDRESS_B = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const SENDER = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const STRANGER = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";

function hash(seed: string): string {
  return `0x${seed.repeat(64).slice(0, 64)}`;
}

function topic(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2)}`;
}

function word(value: bigint | number): string {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function abiString(value: string): string {
  const bytes = Buffer.from(value, "utf8").toString("hex");
  return `0x${"0".repeat(62)}20${word(value.length).slice(2)}${bytes.padEnd(64, "0")}`;
}

function transferLog(input: { to: string; amount: bigint | number; block: number; logIndex: number; tx: string; blockHash?: string }): DropshipUsdcChainLog {
  return {
    address: USDC,
    topics: [ERC20_TRANSFER_TOPIC, topic(SENDER), topic(input.to)],
    data: word(input.amount),
    blockNumber: `0x${input.block.toString(16)}`,
    blockHash: input.blockHash ?? hash(String(input.block % 10)),
    transactionHash: input.tx,
    logIndex: `0x${input.logIndex.toString(16)}`,
  };
}

class ScriptedChain implements DropshipUsdcChainReader {
  calls: { method: string; args: unknown }[] = [];
  reportedChainId = 8453;
  head = 1_000;
  safe: { number: number; hash: string } | null = { number: 950, hash: hash("5") };
  logs: DropshipUsdcChainLog[] = [];
  receipts = new Map<string, { blockNumber: number; blockHash: string; succeeded: boolean; logs: DropshipUsdcChainLog[] } | null>();
  balances = new Map<string, bigint>();
  decimals = 6;
  symbol = "USDC";
  failures: Record<string, Error> = {};

  private fail(method: string): void {
    const failure = this.failures[method];
    if (failure) throw failure;
  }

  async chainId(): Promise<number> {
    this.calls.push({ method: "chainId", args: null });
    this.fail("chainId");
    return this.reportedChainId;
  }

  async blockNumber(): Promise<number> {
    this.calls.push({ method: "blockNumber", args: null });
    this.fail("blockNumber");
    return this.head;
  }

  async getBlock(reference: number | "latest" | "safe" | "finalized") {
    this.calls.push({ method: "getBlock", args: reference });
    if (reference === "safe" || reference === "finalized") {
      return this.safe ? { ...this.safe, timestamp: 1_700_000_000 } : null;
    }
    return { number: typeof reference === "number" ? reference : this.head, hash: hash("9"), timestamp: 1_700_000_000 };
  }

  async getLogs(filter: { fromBlock: number; toBlock: number; address: string; topics: (string | string[] | null)[] }) {
    this.calls.push({ method: "getLogs", args: filter });
    this.fail("getLogs");
    return this.logs;
  }

  async getTransactionReceipt(transactionHash: string) {
    this.calls.push({ method: "getTransactionReceipt", args: transactionHash });
    this.fail("getTransactionReceipt");
    const receipt = this.receipts.get(transactionHash);
    return receipt ? { transactionHash, ...receipt } : null;
  }

  async call(input: { to: string; data: string }, block?: "latest" | "safe" | "finalized"): Promise<string> {
    this.calls.push({ method: "call", args: { ...input, block: block ?? "latest" } });
    this.fail("call");
    const selector = input.data.slice(0, 10);
    if (selector === "0x313ce567") return word(this.decimals);
    if (selector === "0x95d89b41") return abiString(this.symbol);
    if (selector === "0x70a08231") return word(this.balances.get(`0x${input.data.slice(-40)}`) ?? BigInt(0));
    throw new Error(`unexpected call ${selector}`);
  }
}

class FakeDepositRepository implements DropshipUsdcDepositRepository {
  addresses: DropshipUsdcDepositAddressRecord[] = [];
  cursor: DropshipUsdcWatcherCursorRecord | null = null;
  expectations: DropshipUsdcCustodyExpectation[] = [];
  advanced: number[] = [];

  async findDepositAddress(input: { vendorId: number; chainId: number }) {
    return this.addresses.find((record) => record.vendorId === input.vendorId && record.chainId === input.chainId) ?? null;
  }

  async findDepositAddressByAddress(input: { chainId: number; address: string }) {
    return this.addresses.find((record) => record.chainId === input.chainId && record.address === input.address) ?? null;
  }

  async listDepositAddresses(input: { chainId: number }) {
    return this.addresses.filter((record) => record.chainId === input.chainId);
  }

  async assignDepositAddress(input: Parameters<DropshipUsdcDepositRepository["assignDepositAddress"]>[0]) {
    const existing = await this.findDepositAddress(input);
    if (existing) return { address: existing, created: false };
    const derivationIndex = this.addresses.filter((record) => record.keyFingerprint === input.keyFingerprint).length;
    const derived = input.derive(derivationIndex);
    const address: DropshipUsdcDepositAddressRecord = {
      depositAddressId: this.addresses.length + 1,
      vendorId: input.vendorId,
      chainId: input.chainId,
      keyFingerprint: derived.keyFingerprint,
      derivationIndex: derived.derivationIndex,
      address: derived.address,
      checksumAddress: derived.checksumAddress,
      assignedAt: input.assignedAt,
    };
    this.addresses.push(address);
    return { address, created: true };
  }

  async readWatcherCursor() {
    return this.cursor;
  }

  async advanceWatcherCursor(input: { chainId: number; tokenAddress: string; lastScannedBlock: number; updatedAt: Date }) {
    if (this.cursor && input.lastScannedBlock < this.cursor.lastScannedBlock) throw new Error("cursor regression");
    this.cursor = { chainId: input.chainId, tokenAddress: input.tokenAddress, lastScannedBlock: input.lastScannedBlock, updatedAt: input.updatedAt };
    this.advanced.push(input.lastScannedBlock);
    return this.cursor;
  }

  async listCustodyExpectations() {
    return this.expectations;
  }
}

class FakeLedgerRepository implements DropshipUsdcDepositLedgerRepository {
  entries: DropshipUsdcLedgerEntryRecord[] = [];
  ledger: DropshipWalletLedgerRecord[] = [];
  accounts = new Map<number, DropshipWalletAccountRecord>();
  calls: string[] = [];
  failObserveWith: Error | null = null;
  failObserveOnLogIndex: number | null = null;

  account(vendorId: number): DropshipWalletAccountRecord {
    let account = this.accounts.get(vendorId);
    if (!account) {
      account = { walletAccountId: vendorId * 100, vendorId, availableBalanceCents: 0, pendingBalanceCents: 0, currency: "USD", status: "active", createdAt: NOW, updatedAt: NOW };
      this.accounts.set(vendorId, account);
    }
    return account;
  }

  private result(entry: DropshipUsdcLedgerEntryRecord, idempotentReplay: boolean): DropshipUsdcDepositLedgerResult {
    return {
      account: this.account(entry.vendorId),
      ledgerEntry: entry.walletLedgerId === null ? null : this.ledger.find((row) => row.ledgerEntryId === entry.walletLedgerId) ?? null,
      usdcLedgerEntry: entry,
      idempotentReplay,
    };
  }

  async findUsdcDepositByLog(input: { chainId: number; transactionHash: string; logIndex: number }) {
    return this.entries.find((entry) => entry.chainId === input.chainId && entry.transactionHash === input.transactionHash && entry.logIndex === input.logIndex) ?? null;
  }

  async listPendingUsdcDeposits(input: { chainId: number; limit: number }) {
    return this.entries.filter((entry) => entry.chainId === input.chainId && entry.status === "pending").slice(0, input.limit);
  }

  async observeUsdcDeposit(input: ObserveDropshipUsdcDepositRepositoryInput) {
    this.calls.push(`observe:${input.transfer.logIndex}:${input.status}`);
    if (this.failObserveWith && (this.failObserveOnLogIndex === null || this.failObserveOnLogIndex === input.transfer.logIndex)) {
      throw this.failObserveWith;
    }
    const existing = await this.findUsdcDepositByLog(input.transfer);
    if (existing) return this.result(existing, true);
    const account = this.account(input.vendorId);
    let walletLedgerId: number | null = null;
    if (input.status !== "dust") {
      if (input.status === "pending") account.pendingBalanceCents += input.amountCents;
      else account.availableBalanceCents += input.amountCents;
      const ledgerEntry: DropshipWalletLedgerRecord = {
        ledgerEntryId: this.ledger.length + 1,
        walletAccountId: account.walletAccountId,
        vendorId: input.vendorId,
        type: "funding",
        status: input.status,
        amountCents: input.amountCents,
        currency: input.currency,
        availableBalanceAfterCents: account.availableBalanceCents,
        pendingBalanceAfterCents: account.pendingBalanceCents,
        referenceType: "usdc_base_transaction",
        referenceId: `${input.transfer.chainId}:${input.transfer.transactionHash}:${input.transfer.logIndex}`,
        idempotencyKey: null,
        fundingMethodId: null,
        externalTransactionId: input.transfer.transactionHash,
        metadata: { requestHash: input.requestHash },
        createdAt: input.occurredAt,
        settledAt: input.status === "settled" ? input.occurredAt : null,
      };
      this.ledger.push(ledgerEntry);
      walletLedgerId = ledgerEntry.ledgerEntryId;
    }
    const entry: DropshipUsdcLedgerEntryRecord = {
      usdcLedgerEntryId: this.entries.length + 1,
      vendorId: input.vendorId,
      walletLedgerId,
      chainId: input.transfer.chainId,
      transactionHash: input.transfer.transactionHash,
      fromAddress: input.transfer.fromAddress,
      toAddress: input.transfer.toAddress,
      amountAtomicUnits: input.transfer.amountAtomicUnits,
      confirmations: input.confirmations,
      status: input.status,
      observedAt: input.occurredAt,
      settledAt: input.status === "settled" ? input.occurredAt : null,
      logIndex: input.transfer.logIndex,
      blockNumber: input.transfer.blockNumber,
      blockHash: input.transfer.blockHash,
      tokenAddress: input.transfer.tokenAddress,
      depositAddressId: input.depositAddressId,
      dustAtomicUnits: input.dustAtomicUnits,
      voidedAt: null,
    };
    this.entries.push(entry);
    return this.result(entry, false);
  }

  async settleUsdcDeposit(input: SettleDropshipUsdcDepositRepositoryInput) {
    this.calls.push(`settle:${input.usdcLedgerEntryId}`);
    const entry = this.entries.find((row) => row.usdcLedgerEntryId === input.usdcLedgerEntryId)!;
    if (entry.status !== "pending") return this.result(entry, true);
    const ledgerEntry = this.ledger.find((row) => row.ledgerEntryId === entry.walletLedgerId)!;
    const account = this.account(entry.vendorId);
    account.pendingBalanceCents -= ledgerEntry.amountCents;
    account.availableBalanceCents += ledgerEntry.amountCents;
    ledgerEntry.status = "settled";
    ledgerEntry.settledAt = input.occurredAt;
    entry.status = "settled";
    entry.settledAt = input.occurredAt;
    entry.confirmations = input.confirmations;
    entry.blockNumber = input.current.blockNumber;
    entry.blockHash = input.current.blockHash;
    return this.result(entry, false);
  }

  async voidUsdcDeposit(input: VoidDropshipUsdcDepositRepositoryInput) {
    this.calls.push(`void:${input.usdcLedgerEntryId}:${input.reasonCode}`);
    const entry = this.entries.find((row) => row.usdcLedgerEntryId === input.usdcLedgerEntryId)!;
    if (entry.status !== "pending") return this.result(entry, true);
    const ledgerEntry = this.ledger.find((row) => row.ledgerEntryId === entry.walletLedgerId)!;
    const account = this.account(entry.vendorId);
    account.pendingBalanceCents -= ledgerEntry.amountCents;
    ledgerEntry.status = "failed";
    entry.status = "voided";
    entry.voidedAt = input.occurredAt;
    return this.result(entry, false);
  }

  async recordUsdcDepositMoved(input: RecordDropshipUsdcDepositMovedRepositoryInput) {
    this.calls.push(`moved:${input.usdcLedgerEntryId}:${input.current.blockNumber}`);
    const entry = this.entries.find((row) => row.usdcLedgerEntryId === input.usdcLedgerEntryId)!;
    entry.blockNumber = input.current.blockNumber;
    entry.blockHash = input.current.blockHash;
    entry.confirmations = input.confirmations;
    return entry;
  }
}

const deriver: DropshipUsdcDepositAddressDeriver = {
  keyFingerprint: "3bf95407",
  deriveDepositAddress(derivationIndex: number) {
    const address = [ADDRESS_A, ADDRESS_B, STRANGER][derivationIndex] ?? `0x${derivationIndex.toString(16).padStart(40, "0")}`;
    return { derivationIndex, address, checksumAddress: address.toUpperCase().replace("0X", "0x"), keyFingerprint: "3bf95407" };
  },
};

function makeService(overrides: {
  chain?: ScriptedChain | null;
  deriver?: DropshipUsdcDepositAddressDeriver | null;
  config?: Partial<DropshipUsdcWatcherConfig>;
  vendorStanding?: { restoreIfFunded: (input: unknown) => Promise<unknown> } | undefined;
} = {}) {
  const chain = overrides.chain === undefined ? new ScriptedChain() : overrides.chain;
  const depositRepository = new FakeDepositRepository();
  const ledgerRepository = new FakeLedgerRepository();
  const logs: { level: string; event: DropshipLogEvent }[] = [];
  const sent: DropshipNotificationSenderInput[] = [];
  const restored: unknown[] = [];
  const service = new DropshipUsdcDepositService({
    depositRepository,
    ledgerRepository,
    deriver: overrides.deriver === undefined ? deriver : overrides.deriver,
    chain,
    config: { ...DEFAULT_USDC_WATCHER_CONFIG, ...overrides.config },
    notificationSender: { send: async (input) => { sent.push(input); return null; } },
    vendorStanding: overrides.vendorStanding === undefined
      ? { restoreIfFunded: async (input: unknown) => { restored.push(input); return { outcome: "unchanged" }; } } as never
      : overrides.vendorStanding as never,
    clock: { now: () => NOW },
    logger: {
      info: (event) => logs.push({ level: "info", event }),
      warn: (event) => logs.push({ level: "warn", event }),
      error: (event) => logs.push({ level: "error", event }),
    },
  });
  return { service, chain, depositRepository, ledgerRepository, logs, sent, restored };
}

async function seedAddresses(harness: ReturnType<typeof makeService>) {
  await harness.service.assignDepositAddress(10);
  await harness.service.assignDepositAddress(11);
}

describe("DropshipUsdcDepositService (funding design phase 6)", () => {
  describe("offering and addresses", () => {
    it("says what is offered from what is configured", () => {
      expect(makeService().service.offering()).toMatchObject({ offered: true, watched: true, chainId: 8453, tokenAddress: USDC, minConfirmations: 6, settleTag: "safe", keyFingerprint: "3bf95407" });
      expect(makeService({ chain: null }).service.offering()).toMatchObject({ offered: true, watched: false });
      expect(makeService({ deriver: null }).service.offering()).toMatchObject({ offered: false, watched: false, keyFingerprint: null });
    });

    it("hands each vendor the next index under the key, the same address every time after", async () => {
      const harness = makeService();
      const first = await harness.service.assignDepositAddress(10);
      const second = await harness.service.assignDepositAddress(11);
      const again = await harness.service.assignDepositAddress(10);
      expect(first).toMatchObject({ created: true, address: { vendorId: 10, derivationIndex: 0, address: ADDRESS_A, keyFingerprint: "3bf95407", assignedAt: NOW } });
      expect(second).toMatchObject({ created: true, address: { vendorId: 11, derivationIndex: 1, address: ADDRESS_B } });
      expect(again).toMatchObject({ created: false, address: { depositAddressId: first.address.depositAddressId } });
      expect(await harness.service.getDepositAddress(10)).toEqual(first.address);
      expect(await harness.service.getDepositAddress(12)).toBeNull();
      expect(harness.logs.filter((log) => log.event.code === "DROPSHIP_USDC_DEPOSIT_ADDRESS_ASSIGNED")).toHaveLength(2);
    });

    it("refuses to hand out an address without a key, and refuses a bad vendor id", async () => {
      await expect(makeService({ deriver: null }).service.assignDepositAddress(10)).rejects.toMatchObject({ code: "DROPSHIP_USDC_DEPOSITS_NOT_OFFERED" });
      await expect(makeService().service.assignDepositAddress(0)).rejects.toMatchObject({ code: "DROPSHIP_USDC_DEPOSIT_INVALID_INPUT" });
      await expect(makeService().service.getDepositAddress(1.5)).rejects.toMatchObject({ code: "DROPSHIP_USDC_DEPOSIT_INVALID_INPUT" });
    });

    it("refuses an unusable configuration at construction", () => {
      expect(() => makeService({ config: { minConfirmations: 0 } })).toThrowError(expect.objectContaining({ code: "DROPSHIP_USDC_WATCHER_MISCONFIGURED" }));
      expect(() => makeService({ config: { tokenAddress: "0xABC" } })).toThrowError(expect.objectContaining({ code: "DROPSHIP_USDC_WATCHER_MISCONFIGURED" }));
    });
  });

  describe("verifyChain", () => {
    it("checks the chain id, decimals and symbol once and remembers a pass", async () => {
      const harness = makeService();
      expect(await harness.service.verifyChain()).toEqual({ ok: true, chainId: 8453, decimals: 6, symbol: "USDC" });
      const callsAfterFirst = harness.chain.calls.length;
      expect(await harness.service.verifyChain()).toEqual({ ok: true, chainId: 8453, decimals: 6, symbol: "USDC" });
      expect(harness.chain.calls.length).toBe(callsAfterFirst);
      expect(harness.logs.map((log) => log.event.code)).toContain("DROPSHIP_USDC_CHAIN_VERIFIED");
    });

    it("refuses another chain, another token, and a node it cannot reach, logging each failure once", async () => {
      const wrongChain = makeService();
      wrongChain.chain.reportedChainId = 1;
      expect(await wrongChain.service.verifyChain()).toMatchObject({ ok: false, code: "DROPSHIP_USDC_CHAIN_ID_MISMATCH" });
      await wrongChain.service.verifyChain();
      expect(wrongChain.logs.filter((log) => log.event.code === "DROPSHIP_USDC_CHAIN_UNVERIFIED")).toHaveLength(1);
      expect(wrongChain.logs[0]?.event.context).toMatchObject({ requiresReview: true, verificationCode: "DROPSHIP_USDC_CHAIN_ID_MISMATCH" });

      const wrongToken = makeService();
      wrongToken.chain.decimals = 18;
      expect(await wrongToken.service.verifyChain()).toMatchObject({ ok: false, code: "DROPSHIP_USDC_TOKEN_MISMATCH", context: { decimals: 18, symbol: "USDC" } });

      const unreachable = makeService();
      unreachable.chain.failures.chainId = new DropshipError("DROPSHIP_USDC_RPC_TRANSPORT_FAILED", "down", { classification: "transient" });
      expect(await unreachable.service.verifyChain()).toMatchObject({ ok: false, code: "DROPSHIP_USDC_RPC_TRANSPORT_FAILED", context: { classification: "transient" } });
      expect(await makeService({ chain: null }).service.verifyChain()).toMatchObject({ ok: false, code: "DROPSHIP_USDC_CHAIN_NOT_CONFIGURED" });
    });
  });

  describe("runScan", () => {
    it("does nothing without a node or a key, and stops when the chain is not verified or the safe head is unavailable", async () => {
      expect(await makeService({ chain: null }).service.runScan({ workerId: "w" })).toMatchObject({ outcome: "not_configured" });
      expect(await makeService({ deriver: null }).service.runScan({ workerId: "w" })).toMatchObject({ outcome: "not_configured" });
      const wrongChain = makeService();
      wrongChain.chain.reportedChainId = 1;
      expect(await wrongChain.service.runScan({ workerId: "w" })).toMatchObject({ outcome: "chain_unverified" });
      const noSafe = makeService();
      noSafe.chain.safe = null;
      expect(await noSafe.service.runScan({ workerId: "w" })).toMatchObject({ outcome: "chain_unavailable", headBlockNumber: 1_000 });
      expect(noSafe.depositRepository.advanced).toEqual([]);
      expect(noSafe.logs.some((log) => log.event.code === "DROPSHIP_USDC_CHAIN_UNAVAILABLE" && log.level === "warn")).toBe(true);
    });

    it("starts at the confirmed head when nothing was scanned before, and reports caught up when there is nothing new", async () => {
      const harness = makeService();
      await seedAddresses(harness);
      const first = await harness.service.runScan({ workerId: "w" });
      // head 1000, six confirmations: block 995 is the newest with six.
      expect(first).toMatchObject({ outcome: "scanned", fromBlock: 995, toBlock: 995, scannedToBlock: 995, logCount: 0, observedCount: 0 });
      expect(harness.chain.calls.find((call) => call.method === "getLogs")?.args).toMatchObject({ fromBlock: 995, toBlock: 995, address: USDC });
      const second = await harness.service.runScan({ workerId: "w" });
      expect(second).toMatchObject({ outcome: "caught_up", fromBlock: 996, scannedToBlock: 995 });
    });

    it("honours a configured start block and covers at most the block span per tick", async () => {
      const harness = makeService({ config: { startBlock: 100, maxBlockSpan: 50 } });
      await seedAddresses(harness);
      expect(await harness.service.runScan({ workerId: "w" })).toMatchObject({ fromBlock: 100, toBlock: 149, scannedToBlock: 149 });
      expect(await harness.service.runScan({ workerId: "w" })).toMatchObject({ fromBlock: 150, toBlock: 199, scannedToBlock: 199 });
    });

    it("advances the cursor without asking the node for logs while no vendor has an address", async () => {
      const harness = makeService();
      expect(await harness.service.runScan({ workerId: "w" })).toMatchObject({ outcome: "scanned", addressCount: 0, logCount: 0, scannedToBlock: 995 });
      expect(harness.chain.calls.some((call) => call.method === "getLogs")).toBe(false);
    });

    it("credits every transfer to a vendor address: settled at or below the safe head, pending above it, dust recorded, strangers ignored", async () => {
      const harness = makeService();
      await seedAddresses(harness);
      harness.depositRepository.cursor = { chainId: 8453, tokenAddress: USDC, lastScannedBlock: 900, updatedAt: NOW };
      harness.chain.logs = [
        transferLog({ to: ADDRESS_A, amount: 250_000_000, block: 940, logIndex: 3, tx: hash("a") }),
        transferLog({ to: ADDRESS_A, amount: 25_123_456, block: 960, logIndex: 1, tx: hash("b") }),
        transferLog({ to: ADDRESS_B, amount: 100_000_000, block: 960, logIndex: 2, tx: hash("b") }),
        transferLog({ to: ADDRESS_A, amount: 9_999, block: 961, logIndex: 0, tx: hash("c") }),
        transferLog({ to: STRANGER, amount: 1_000_000, block: 962, logIndex: 0, tx: hash("d") }),
      ];

      const result = await harness.service.runScan({ workerId: "w" });

      expect(result).toMatchObject({
        outcome: "scanned", fromBlock: 901, toBlock: 995, scannedToBlock: 995, headBlockNumber: 1_000, safeBlockNumber: 950,
        addressCount: 2, logCount: 5, observedCount: 4, settledCount: 1, pendingCount: 2, dustCount: 1, replayedCount: 0, failedCount: 0,
      });
      expect(harness.chain.calls.find((call) => call.method === "getLogs")?.args).toEqual({
        fromBlock: 901, toBlock: 995, address: USDC, topics: [ERC20_TRANSFER_TOPIC, null, [topic(ADDRESS_A), topic(ADDRESS_B)]],
      });
      expect(harness.ledgerRepository.calls).toEqual(["observe:3:settled", "observe:1:pending", "observe:2:pending", "observe:0:dust"]);
      expect(harness.ledgerRepository.account(10)).toMatchObject({ availableBalanceCents: 25_000, pendingBalanceCents: 2_512 });
      expect(harness.ledgerRepository.account(11)).toMatchObject({ availableBalanceCents: 0, pendingBalanceCents: 10_000 });
      expect(harness.ledgerRepository.entries.map((entry) => [entry.vendorId, entry.status, entry.dustAtomicUnits, entry.confirmations])).toEqual([
        [10, "settled", "0", 61], [10, "pending", "3456", 41], [11, "pending", "0", 41], [10, "dust", "9999", 40],
      ]);
      // The vendor hears about money, not about dust; the settled one is available now.
      expect(harness.sent.map((notice) => [notice.vendorId, notice.eventType, notice.critical, notice.idempotencyKey])).toEqual([
        [10, "dropship_usdc_deposit_landed", false, `usdc-deposit-landed:8453:${hash("a")}:3`],
        [10, "dropship_usdc_deposit_landed", false, `usdc-deposit-landed:8453:${hash("b")}:1`],
        [11, "dropship_usdc_deposit_landed", false, `usdc-deposit-landed:8453:${hash("b")}:2`],
      ]);
      expect(harness.sent[0]?.message).toBe("250.00 USDC landed in your wallet as USD $250.00. It is available now. No fee.");
      expect(harness.sent[1]?.message).toBe("25.123456 USDC landed in your wallet as USD $25.12. It becomes available once the network settles it, usually within a few minutes. No fee.");
      // Only a settled credit can fund a paused vendor back to life.
      expect(harness.restored).toEqual([{ vendorId: 10, evidence: expect.objectContaining({ source: "usdc_deposit_settled", amountCents: 25_000 }) }]);
      expect(harness.logs.filter((log) => log.event.code === "DROPSHIP_USDC_DEPOSIT_UNMATCHED")).toHaveLength(1);
      expect(harness.logs.filter((log) => log.event.code === "DROPSHIP_USDC_DEPOSIT_OBSERVED")).toHaveLength(4);
    });

    it("replays a scan of the same blocks without crediting or notifying twice", async () => {
      const harness = makeService();
      await seedAddresses(harness);
      harness.depositRepository.cursor = { chainId: 8453, tokenAddress: USDC, lastScannedBlock: 900, updatedAt: NOW };
      harness.chain.logs = [transferLog({ to: ADDRESS_A, amount: 25_123_456, block: 960, logIndex: 1, tx: hash("b") })];
      await harness.service.runScan({ workerId: "w" });
      harness.depositRepository.cursor = { chainId: 8453, tokenAddress: USDC, lastScannedBlock: 900, updatedAt: NOW };
      const replay = await harness.service.runScan({ workerId: "w" });
      expect(replay).toMatchObject({ observedCount: 0, replayedCount: 1, scannedToBlock: 995 });
      expect(harness.ledgerRepository.account(10).pendingBalanceCents).toBe(2_512);
      expect(harness.sent).toHaveLength(1);
    });

    it("flags a voided deposit that came back on chain for a human instead of crediting it again", async () => {
      const harness = makeService();
      await seedAddresses(harness);
      harness.depositRepository.cursor = { chainId: 8453, tokenAddress: USDC, lastScannedBlock: 900, updatedAt: NOW };
      harness.chain.logs = [transferLog({ to: ADDRESS_A, amount: 25_123_456, block: 960, logIndex: 1, tx: hash("b") })];
      await harness.service.runScan({ workerId: "w" });
      harness.ledgerRepository.entries[0]!.status = "voided";
      harness.depositRepository.cursor = { chainId: 8453, tokenAddress: USDC, lastScannedBlock: 900, updatedAt: NOW };
      expect(await harness.service.runScan({ workerId: "w" })).toMatchObject({ replayedCount: 1, observedCount: 0 });
      expect(harness.logs.find((log) => log.event.code === "DROPSHIP_USDC_DEPOSIT_REAPPEARED")).toMatchObject({ level: "error", event: { context: expect.objectContaining({ requiresReview: true }) } });
    });

    it("stops before a transfer it cannot record and leaves the cursor there, so nothing after it is credited out of order", async () => {
      const harness = makeService();
      await seedAddresses(harness);
      harness.depositRepository.cursor = { chainId: 8453, tokenAddress: USDC, lastScannedBlock: 900, updatedAt: NOW };
      harness.chain.logs = [
        transferLog({ to: ADDRESS_A, amount: 250_000_000, block: 940, logIndex: 3, tx: hash("a") }),
        transferLog({ to: ADDRESS_A, amount: 25_123_456, block: 960, logIndex: 1, tx: hash("b") }),
        transferLog({ to: ADDRESS_B, amount: 100_000_000, block: 970, logIndex: 2, tx: hash("c") }),
      ];
      harness.ledgerRepository.failObserveWith = new DropshipError("DROPSHIP_WALLET_ACCOUNT_NOT_ACTIVE", "closed", { classification: "permanent" });
      harness.ledgerRepository.failObserveOnLogIndex = 1;

      const stopped = await harness.service.runScan({ workerId: "w" });

      expect(stopped).toMatchObject({ outcome: "scanned", observedCount: 1, failedCount: 1, scannedToBlock: 959 });
      expect(harness.ledgerRepository.calls).toEqual(["observe:3:settled", "observe:1:pending"]);
      expect(harness.logs.find((log) => log.event.code === "DROPSHIP_USDC_SCAN_STOPPED")).toMatchObject({
        level: "error",
        event: { context: expect.objectContaining({ blockNumber: 960, errorCode: "DROPSHIP_WALLET_ACCOUNT_NOT_ACTIVE", classification: "permanent", requiresReview: true }) },
      });

      // Once the fault is fixed the next tick picks up exactly where it stopped.
      harness.ledgerRepository.failObserveWith = null;
      harness.chain.logs = harness.chain.logs.slice(1);
      const resumed = await harness.service.runScan({ workerId: "w" });
      expect(resumed).toMatchObject({ fromBlock: 960, observedCount: 2, scannedToBlock: 995 });
      expect(harness.ledgerRepository.account(11).pendingBalanceCents).toBe(10_000);
    });

    it("treats an unclassified failure as transient: a warning, and the same block again next tick", async () => {
      const harness = makeService();
      await seedAddresses(harness);
      harness.depositRepository.cursor = { chainId: 8453, tokenAddress: USDC, lastScannedBlock: 900, updatedAt: NOW };
      harness.chain.logs = [transferLog({ to: ADDRESS_A, amount: 25_123_456, block: 901, logIndex: 1, tx: hash("b") })];
      harness.ledgerRepository.failObserveWith = new Error("connection reset");
      expect(await harness.service.runScan({ workerId: "w" })).toMatchObject({ failedCount: 1, scannedToBlock: 900 });
      expect(harness.depositRepository.advanced).toEqual([]);
      expect(harness.logs.find((log) => log.event.code === "DROPSHIP_USDC_SCAN_STOPPED")?.level).toBe("warn");
    });

    it("never moves the cursor past the range it asked for when a node answers with a later log", async () => {
      const harness = makeService();
      await seedAddresses(harness);
      harness.depositRepository.cursor = { chainId: 8453, tokenAddress: USDC, lastScannedBlock: 900, updatedAt: NOW };
      harness.chain.logs = [transferLog({ to: ADDRESS_A, amount: 25_123_456, block: 999, logIndex: 1, tx: hash("b") })];
      expect(await harness.service.runScan({ workerId: "w" })).toMatchObject({ observedCount: 0, scannedToBlock: 995 });
      expect(harness.ledgerRepository.calls).toEqual([]);
    });

    it("refuses a log the node should never have sent, without crediting anything", async () => {
      const harness = makeService();
      await seedAddresses(harness);
      harness.depositRepository.cursor = { chainId: 8453, tokenAddress: USDC, lastScannedBlock: 900, updatedAt: NOW };
      harness.chain.logs = [{ ...transferLog({ to: ADDRESS_A, amount: 1, block: 940, logIndex: 0, tx: hash("a") }), address: SENDER }];
      expect(await harness.service.runScan({ workerId: "w" })).toMatchObject({ observedCount: 0, failedCount: 1, scannedToBlock: 939 });
      expect(harness.logs.find((log) => log.event.code === "DROPSHIP_USDC_SCAN_STOPPED")?.event.context).toMatchObject({ errorCode: "DROPSHIP_USDC_TRANSFER_LOG_INVALID", classification: "permanent" });
    });
  });

  describe("runSettlement", () => {
    async function pendingHarness(block = 960) {
      const harness = makeService();
      await seedAddresses(harness);
      harness.depositRepository.cursor = { chainId: 8453, tokenAddress: USDC, lastScannedBlock: 900, updatedAt: NOW };
      const log = transferLog({ to: ADDRESS_A, amount: 25_123_456, block, logIndex: 1, tx: hash("b"), blockHash: hash("b") });
      harness.chain.logs = [log];
      await harness.service.runScan({ workerId: "w" });
      harness.sent.length = 0;
      harness.chain.receipts.set(hash("b"), { blockNumber: block, blockHash: hash("b"), succeeded: true, logs: [log] });
      return { harness, log };
    }

    it("does nothing without configuration, an unverified chain, or an unavailable safe head", async () => {
      expect(await makeService({ chain: null }).service.runSettlement({ workerId: "w" })).toMatchObject({ outcome: "not_configured" });
      const wrongChain = makeService();
      wrongChain.chain.reportedChainId = 1;
      expect(await wrongChain.service.runSettlement({ workerId: "w" })).toMatchObject({ outcome: "chain_unverified" });
      const { harness } = await pendingHarness();
      harness.chain.safe = null;
      expect(await harness.service.runSettlement({ workerId: "w" })).toMatchObject({ outcome: "chain_unavailable", scannedCount: 0 });
    });

    it("waits while the transfer's block is above the safe head, then settles it: pending becomes available", async () => {
      const { harness } = await pendingHarness();
      expect(await harness.service.runSettlement({ workerId: "w" })).toMatchObject({ outcome: "judged", scannedCount: 1, waitingCount: 1, settledCount: 0 });
      harness.chain.safe = { number: 960, hash: hash("6") };
      expect(await harness.service.runSettlement({ workerId: "w" })).toMatchObject({ scannedCount: 1, settledCount: 1, waitingCount: 0 });
      expect(harness.ledgerRepository.account(10)).toMatchObject({ availableBalanceCents: 2_512, pendingBalanceCents: 0 });
      expect(harness.ledgerRepository.entries[0]).toMatchObject({ status: "settled", confirmations: 41, settledAt: NOW });
      expect(harness.restored).toEqual([{ vendorId: 10, evidence: expect.objectContaining({ source: "usdc_deposit_settled", amountCents: 2_512 }) }]);
      expect(harness.logs.some((log) => log.event.code === "DROPSHIP_USDC_DEPOSIT_SETTLED")).toBe(true);
      // Nothing left to judge.
      expect(await harness.service.runSettlement({ workerId: "w" })).toMatchObject({ scannedCount: 0 });
    });

    it("re-records a transfer that moved to another block and judges it again next tick", async () => {
      const { harness, log } = await pendingHarness();
      harness.chain.receipts.set(hash("b"), { blockNumber: 963, blockHash: hash("e"), succeeded: true, logs: [log] });
      expect(await harness.service.runSettlement({ workerId: "w" })).toMatchObject({ movedCount: 1, settledCount: 0 });
      expect(harness.ledgerRepository.calls.at(-1)).toBe("moved:1:963");
      expect(harness.ledgerRepository.entries[0]).toMatchObject({ status: "pending", blockNumber: 963, blockHash: hash("e") });
      harness.chain.safe = { number: 970, hash: hash("7") };
      expect(await harness.service.runSettlement({ workerId: "w" })).toMatchObject({ settledCount: 1 });
    });

    it("voids a transfer whose receipt is gone only after the grace, telling the vendor and a human", async () => {
      const { harness } = await pendingHarness(960);
      harness.chain.receipts.set(hash("b"), null);
      // Head 1000, recorded at 960, grace 60: not yet.
      expect(await harness.service.runSettlement({ workerId: "w" })).toMatchObject({ waitingCount: 1, voidedCount: 0 });
      harness.chain.head = 1_020;
      expect(await harness.service.runSettlement({ workerId: "w" })).toMatchObject({ voidedCount: 1, waitingCount: 0 });
      expect(harness.ledgerRepository.account(10)).toMatchObject({ availableBalanceCents: 0, pendingBalanceCents: 0 });
      expect(harness.ledgerRepository.entries[0]).toMatchObject({ status: "voided", voidedAt: NOW });
      expect(harness.ledgerRepository.calls.at(-1)).toBe("void:1:DROPSHIP_USDC_DEPOSIT_REORGED");
      expect(harness.sent).toEqual([expect.objectContaining({
        vendorId: 10,
        eventType: "dropship_usdc_deposit_voided",
        critical: true,
        idempotencyKey: `usdc-deposit-voided:8453:${hash("b")}:1`,
        message: `The network did not confirm your transfer of 25.123456 USDC (transaction ${hash("b").slice(0, 10)}…${hash("b").slice(-6)}). USD $25.12 has been removed from your wallet balance. Check the transaction in the wallet you sent from; if it completes later, contact support with the transaction id.`,
      })]);
      expect(harness.logs.find((log) => log.event.code === "DROPSHIP_USDC_DEPOSIT_VOIDED")).toMatchObject({ level: "error", event: { context: expect.objectContaining({ requiresReview: true }) } });
    });

    it("treats a reverted transaction, or a receipt without the credited log, as a missing receipt", async () => {
      const reverted = await pendingHarness(960);
      reverted.harness.chain.receipts.set(hash("b"), { blockNumber: 960, blockHash: hash("b"), succeeded: false, logs: [reverted.log] });
      reverted.harness.chain.head = 1_020;
      expect(await reverted.harness.service.runSettlement({ workerId: "w" })).toMatchObject({ voidedCount: 1 });
      const otherLog = await pendingHarness(960);
      otherLog.harness.chain.receipts.set(hash("b"), { blockNumber: 960, blockHash: hash("b"), succeeded: true, logs: [{ ...otherLog.log, logIndex: "0x7" }] });
      otherLog.harness.chain.head = 1_020;
      expect(await otherLog.harness.service.runSettlement({ workerId: "w" })).toMatchObject({ voidedCount: 1 });
    });

    it("keeps judging the rest when one credit fails, warning for a transient fault and alerting for a permanent one", async () => {
      const { harness } = await pendingHarness();
      harness.ledgerRepository.entries.push({
        ...harness.ledgerRepository.entries[0]!,
        usdcLedgerEntryId: 2,
        transactionHash: hash("c"),
        logIndex: null,
        walletLedgerId: null,
      });
      harness.chain.failures.getTransactionReceipt = new DropshipError("DROPSHIP_USDC_RPC_TRANSPORT_FAILED", "down", { classification: "transient" });
      const result = await harness.service.runSettlement({ workerId: "w" });
      expect(result).toMatchObject({ scannedCount: 2, failedCount: 2, settledCount: 0 });
      const failures = harness.logs.filter((log) => log.event.code === "DROPSHIP_USDC_SETTLEMENT_FAILED");
      expect(failures.map((log) => [log.level, log.event.context?.errorCode])).toEqual([
        ["warn", "DROPSHIP_USDC_RPC_TRANSPORT_FAILED"],
        ["error", "DROPSHIP_USDC_DEPOSIT_CHAIN_FACTS_MISSING"],
      ]);
    });
  });

  describe("runCustodyCheck", () => {
    it("compares every address with its on-chain balance, alerting on funds the ledger never credited", async () => {
      const harness = makeService();
      harness.depositRepository.expectations = [
        { depositAddressId: 1, vendorId: 10, address: ADDRESS_A, checksumAddress: ADDRESS_A, expectedAtomicUnits: "25123456", creditedCents: 2_512, observationCount: 1 },
        { depositAddressId: 2, vendorId: 11, address: ADDRESS_B, checksumAddress: ADDRESS_B, expectedAtomicUnits: "100000000", creditedCents: 10_000, observationCount: 1 },
        { depositAddressId: 3, vendorId: 12, address: STRANGER, checksumAddress: STRANGER, expectedAtomicUnits: "0", creditedCents: 0, observationCount: 0 },
      ];
      harness.chain.balances.set(ADDRESS_A, BigInt(25_123_456));
      harness.chain.balances.set(ADDRESS_B, BigInt(150_000_000));

      const report = await harness.service.runCustodyCheck();

      expect(report).toMatchObject({ outcome: "checked", checkedAt: NOW, chainId: 8453, tokenAddress: USDC });
      expect(report.addresses.map((row) => [row.vendorId, row.status, row.onChainAtomicUnits, row.unrecordedAtomicUnits])).toEqual([
        [10, "holding", "25123456", "0"],
        [11, "unrecorded_funds", "150000000", "50000000"],
        [12, "empty", "0", "0"],
      ]);
      expect(report.totals).toEqual({ expectedAtomicUnits: "125123456", onChainAtomicUnits: "175123456", unrecordedAtomicUnits: "50000000", reviewCount: 1, unreadCount: 0 });
      expect(harness.logs.find((log) => log.event.code === "DROPSHIP_USDC_CUSTODY_UNRECORDED_FUNDS")).toMatchObject({ level: "error", event: { context: expect.objectContaining({ vendorId: 11, requiresReview: true }) } });
      expect(harness.chain.calls.filter((call) => call.method === "call" && (call.args as { data: string }).data.startsWith("0x70a08231"))).toHaveLength(3);
    });

    it("reports an address whose balance could not be read as unread, and does nothing when not configured or unverified", async () => {
      const harness = makeService();
      harness.depositRepository.expectations = [
        { depositAddressId: 1, vendorId: 10, address: ADDRESS_A, checksumAddress: ADDRESS_A, expectedAtomicUnits: "25123456", creditedCents: 2_512, observationCount: 1 },
      ];
      await harness.service.verifyChain();
      harness.chain.failures.call = new Error("timeout");
      const report = await harness.service.runCustodyCheck();
      expect(report.addresses[0]).toMatchObject({ status: "unread", onChainAtomicUnits: null });
      expect(report.totals).toMatchObject({ unreadCount: 1, reviewCount: 0 });
      expect(harness.logs.some((log) => log.event.code === "DROPSHIP_USDC_CUSTODY_BALANCE_UNREAD" && log.level === "warn")).toBe(true);

      expect((await makeService({ chain: null }).service.runCustodyCheck()).outcome).toBe("not_configured");
      const wrongChain = makeService();
      wrongChain.chain.reportedChainId = 1;
      expect((await wrongChain.service.runCustodyCheck()).outcome).toBe("chain_unverified");
    });
  });

  describe("formatUsdcAmount", () => {
    it("prints whole USDC with at least two decimals and never more than the token has", () => {
      expect(formatUsdcAmount("25123456")).toBe("25.123456");
      expect(formatUsdcAmount("25000000")).toBe("25.00");
      expect(formatUsdcAmount("25100000")).toBe("25.10");
      expect(formatUsdcAmount("1")).toBe("0.000001");
      expect(formatUsdcAmount("0")).toBe("0.00");
      expect(formatUsdcAmount("123456789012345678")).toBe("123456789012.345678");
    });
  });
});
