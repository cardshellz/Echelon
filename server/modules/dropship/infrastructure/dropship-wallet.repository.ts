import type { Pool, PoolClient } from "pg";
import type { DropshipVendorStatus } from "../../../../shared/schema/dropship.schema";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import {
  FUNDING_METHOD_ARCHIVED_AT_KEY,
  FUNDING_METHOD_ARCHIVED_BY_MEMBER_KEY,
  FUNDING_METHOD_FINANCIAL_CONNECTIONS_ACCOUNT_KEY,
  FUNDING_METHOD_PROVIDER_DETACH_KEY,
} from "../domain/funding-method";
import { decideFundingMethodRemoval } from "../domain/funding-method-removal";
import type { DropshipAdvanceContext } from "../domain/acceptance-funding";
import { decideFundingReversal } from "../domain/funding-reversal";
import { decideRewardsAccrual, decideRewardsClawback, type DropshipRewardsRail } from "../domain/wallet-rewards";
import { loadRewardsRatesInForceWithClient } from "./dropship-wallet-rewards.reader";
import { pauseDropshipVendorWithClient } from "./dropship-vendor-standing.repository";
import { usdcTransactionReferenceId } from "../application/dropship-wallet-service";
import { loadAdvancePolicyWithClient, loadAdvanceSourcesWithClient } from "./dropship-advance.reader";
import type {
  SetDropshipRewardsSpendPreferenceRepositoryInput,
  ArchiveDropshipFundingMethodRepositoryInput,
  ConfigureDropshipAutoReloadRepositoryInput,
  CreateDropshipConfirmedUsdcFundingRepositoryInput,
  CreateDropshipWalletFundingLedgerInput,
  CreateDropshipWalletOrderDebitInput,
  DropshipAutoReloadSettingRecord,
  DropshipBankBalanceVerificationRecord,
  DropshipConfirmedUsdcFundingResult,
  DropshipFundingReinstatementRepositoryResult,
  DropshipFundingReversalRepositoryResult,
  DropshipFundingMethodMutationResult,
  DropshipFundingMethodRecord,
  DropshipUsdcLedgerEntryRecord,
  DropshipWalletAccountRecord,
  DropshipWalletLedgerRecord,
  DropshipWalletFundingFailureRepositoryResult,
  DropshipWalletMutationResult,
  DropshipWalletOverview,
  DropshipWalletRepository,
  FailDropshipPendingFundingRepositoryInput,
  RecordDropshipBankBalanceVerificationRepositoryInput,
  RecordDropshipFundingMethodDetachOutcomeRepositoryInput,
  ReinstateDropshipReversedFundingRepositoryInput,
  ReverseDropshipSettledFundingRepositoryInput,
  UpsertDropshipFundingMethodRepositoryInput,
  DropshipUsdcDepositLedgerRepository,
  DropshipUsdcDepositLedgerResult,
  ObserveDropshipUsdcDepositRepositoryInput,
  RecordDropshipUsdcDepositMovedRepositoryInput,
  SettleDropshipUsdcDepositRepositoryInput,
  VoidDropshipUsdcDepositRepositoryInput,
} from "../application/dropship-wallet-service";

interface WalletAccountRow {
  id: number;
  vendor_id: number;
  available_balance_cents: string | number;
  pending_balance_cents: string | number;
  rewards_balance_cents: string | number;
  currency: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

interface FundingMethodRow {
  id: number;
  vendor_id: number;
  rail: DropshipFundingMethodRecord["rail"];
  status: string;
  provider_customer_id: string | null;
  provider_payment_method_id: string | null;
  usdc_wallet_address: string | null;
  display_label: string | null;
  is_default: boolean;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

interface FundingMethodMutationRow extends FundingMethodRow {
  inserted: boolean;
}

interface AutoReloadRow {
  id: number;
  vendor_id: number;
  funding_method_id: number | null;
  enabled: boolean;
  minimum_balance_cents: string | number;
  max_single_reload_cents: string | number | null;
  top_up_amount_cents: string | number | null;
  payment_hold_timeout_minutes: number;
  acknowledged_card_fee_bps: number | null;
  acknowledged_at: Date | null;
  spend_rewards_first: boolean;
  created_at: Date;
  updated_at: Date;
}

interface WalletLedgerRow {
  id: number;
  wallet_account_id: number | null;
  vendor_id: number;
  type: DropshipWalletLedgerRecord["type"];
  status: DropshipWalletLedgerRecord["status"];
  amount_cents: string | number;
  currency: string;
  available_balance_after_cents: string | number | null;
  pending_balance_after_cents: string | number | null;
  rewards_balance_after_cents: string | number | null;
  reference_type: string | null;
  reference_id: string | null;
  idempotency_key: string | null;
  funding_method_id: number | null;
  external_transaction_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  settled_at: Date | null;
}

interface BalanceVerificationRow {
  id: number;
  vendor_id: number;
  funding_method_id: number;
  provider: string;
  provider_account_id: string;
  status: string;
  source: string;
  available_cents: string | number | null;
  currency: string | null;
  balance_as_of: Date | null;
  provider_event_id: string | null;
  created_at: Date;
}

interface UsdcLedgerRow {
  id: number;
  vendor_id: number;
  wallet_ledger_id: number | null;
  chain_id: number;
  transaction_hash: string;
  from_address: string | null;
  to_address: string | null;
  amount_atomic_units: string | number;
  confirmations: number;
  status: string;
  observed_at: Date;
  settled_at: Date | null;
  log_index: number | null;
  block_number: string | number | null;
  block_hash: string | null;
  token_address: string | null;
  deposit_address_id: number | null;
  dust_atomic_units: string | number | null;
  voided_at: Date | null;
}

/** Every column of a USDC observation, for SELECT and RETURNING alike. */
const USDC_LEDGER_COLUMNS = `id, vendor_id, wallet_ledger_id, chain_id, transaction_hash,
            from_address, to_address, amount_atomic_units, confirmations,
            status, observed_at, settled_at, log_index, block_number, block_hash,
            token_address, deposit_address_id, dust_atomic_units, voided_at`;

export class PgDropshipWalletRepository implements DropshipWalletRepository, DropshipUsdcDepositLedgerRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async getOrCreateWalletAccount(input: {
    vendorId: number;
    currency: string;
    now: Date;
  }): Promise<DropshipWalletAccountRecord> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const account = await getOrCreateWalletAccountWithClient(client, input);
      await client.query("COMMIT");
      return account;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async getOverview(input: {
    vendorId: number;
    ledgerLimit: number;
    now: Date;
  }): Promise<DropshipWalletOverview> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const account = await getOrCreateWalletAccountWithClient(client, {
        vendorId: input.vendorId,
        currency: "USD",
        now: input.now,
      });
      const fundingMethods = await listFundingMethodsWithClient(client, input.vendorId);
      const autoReload = await getAutoReloadSettingWithClient(client, input.vendorId);
      const recentLedger = await listLedgerWithClient(client, input.vendorId, input.ledgerLimit);
      await client.query("COMMIT");
      return {
        account,
        fundingMethods,
        autoReload,
        recentLedger,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async creditFunding(input: CreateDropshipWalletFundingLedgerInput): Promise<DropshipWalletMutationResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const account = await loadWalletAccountForMutation(client, input);
      const fundingMethod = await assertFundingMethodCanBeUsed(client, {
        vendorId: input.vendorId,
        fundingMethodId: input.fundingMethodId ?? null,
      });
      if (fundingMethod && fundingMethod.rail !== input.rail) {
        throw new DropshipError(
          "DROPSHIP_FUNDING_METHOD_RAIL_MISMATCH",
          "Dropship funding method rail does not match the funding event rail.",
          {
            vendorId: input.vendorId,
            fundingMethodId: input.fundingMethodId,
            fundingMethodRail: fundingMethod.rail,
            eventRail: input.rail,
          },
        );
      }

      const replay = await findReplayLedgerWithClient(client, {
        vendorId: input.vendorId,
        idempotencyKey: input.idempotencyKey,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
      });
      if (replay) {
        if (replay.status === "settled" && input.status === "pending") {
          assertLedgerReplayMatches(replay, {
            type: "funding",
            amountCents: input.amountCents,
            currency: input.currency,
            status: "settled",
            referenceType: input.referenceType,
            referenceId: input.referenceId,
            requestHash: input.requestHash,
          });
          await client.query("COMMIT");
          return {
            account,
            ledgerEntry: replay,
            idempotentReplay: true,
          };
        }
        if (replay.status === "pending" && input.status === "settled") {
          assertLedgerReplayMatches(replay, {
            type: "funding",
            amountCents: input.amountCents,
            currency: input.currency,
            status: "pending",
            referenceType: input.referenceType,
            referenceId: input.referenceId,
            requestHash: input.requestHash,
          });
          const settled = await settlePendingFundingWithClient(client, {
            account,
            ledgerEntry: replay,
            fundingMethodId: input.fundingMethodId ?? null,
            externalTransactionId: input.externalTransactionId ?? null,
            metadata: {
              ...fundingLedgerMetadata(input),
              settledFromPending: true,
            },
            settledAt: input.occurredAt,
          });
          await recordWalletAuditEvent(client, {
            vendorId: input.vendorId,
            entityType: "dropship_wallet_ledger",
            entityId: String(settled.ledgerEntry.ledgerEntryId),
            eventType: "wallet_funding_settled",
            payload: serializeLedgerForAudit(settled.ledgerEntry),
            createdAt: input.occurredAt,
          });
          const accrued = await accrueRewardsForSettledCreditWithClient(client, {
            account: settled.account,
            credit: settled.ledgerEntry,
            rail: input.rail,
            occurredAt: input.occurredAt,
          });
          await client.query("COMMIT");
          return {
            account: accrued?.account ?? settled.account,
            ledgerEntry: settled.ledgerEntry,
            idempotentReplay: false,
          };
        }
        assertLedgerReplayMatches(replay, {
          type: "funding",
          amountCents: input.amountCents,
          currency: input.currency,
          status: input.status,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          requestHash: input.requestHash,
        });
        await client.query("COMMIT");
        return {
          account,
          ledgerEntry: replay,
          idempotentReplay: true,
        };
      }

      const nextAvailable = input.status === "settled"
        ? account.availableBalanceCents + input.amountCents
        : account.availableBalanceCents;
      const nextPending = input.status === "pending"
        ? account.pendingBalanceCents + input.amountCents
        : account.pendingBalanceCents;
      const updatedAccount = await updateWalletBalancesWithClient(client, {
        walletAccountId: account.walletAccountId,
        vendorId: input.vendorId,
        availableBalanceCents: nextAvailable,
        pendingBalanceCents: nextPending,
        updatedAt: input.occurredAt,
      });
      const ledgerEntry = await insertLedgerEntryWithClient(client, {
        walletAccountId: account.walletAccountId,
        vendorId: input.vendorId,
        type: "funding",
        status: input.status,
        amountCents: input.amountCents,
        currency: input.currency,
        availableBalanceAfterCents: nextAvailable,
        pendingBalanceAfterCents: nextPending,
        rewardsBalanceAfterCents: account.rewardsBalanceCents,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        idempotencyKey: input.idempotencyKey,
        fundingMethodId: input.fundingMethodId ?? null,
        externalTransactionId: input.externalTransactionId ?? null,
        metadata: fundingLedgerMetadata(input),
        createdAt: input.occurredAt,
        settledAt: input.status === "settled" ? input.occurredAt : null,
      });
      await recordWalletAuditEvent(client, {
        vendorId: input.vendorId,
        entityType: "dropship_wallet_ledger",
        entityId: String(ledgerEntry.ledgerEntryId),
        eventType: input.status === "settled" ? "wallet_funding_settled" : "wallet_funding_pending",
        payload: serializeLedgerForAudit(ledgerEntry),
        createdAt: input.occurredAt,
      });
      // A settled credit earns its rewards here, in the same transaction; a
      // pending one earns them when it settles.
      const accrued = input.status === "settled"
        ? await accrueRewardsForSettledCreditWithClient(client, {
            account: updatedAccount,
            credit: ledgerEntry,
            rail: input.rail,
            occurredAt: input.occurredAt,
          })
        : null;
      await client.query("COMMIT");
      return {
        account: accrued?.account ?? updatedAccount,
        ledgerEntry,
        idempotentReplay: false,
      };
    } catch (error) {
      await rollbackQuietly(client);
      if (isUniqueViolation(error)) {
        const replay = await this.findLedgerReplayAfterUniqueConflict(input);
        if (replay) return replay;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async creditConfirmedUsdcFunding(
    input: CreateDropshipConfirmedUsdcFundingRepositoryInput,
  ): Promise<DropshipConfirmedUsdcFundingResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const existingUsdc = await findUsdcLedgerByTransactionWithClient(client, {
        chainId: input.chainId,
        transactionHash: input.transactionHash,
        logIndex: input.logIndex,
      });
      if (existingUsdc) {
        const replay = await replayConfirmedUsdcFundingWithClient(client, input, existingUsdc);
        await client.query("COMMIT");
        return replay;
      }

      const account = await loadWalletAccountForMutation(client, {
        vendorId: input.vendorId,
        walletAccountId: null,
        currency: input.currency,
        occurredAt: input.occurredAt,
      });
      const fundingMethod = await assertFundingMethodCanBeUsed(client, {
        vendorId: input.vendorId,
        fundingMethodId: input.fundingMethodId,
      });
      if (fundingMethod && fundingMethod.rail !== "usdc_base") {
        throw new DropshipError(
          "DROPSHIP_FUNDING_METHOD_RAIL_MISMATCH",
          "Dropship funding method rail does not match the USDC funding event rail.",
          {
            vendorId: input.vendorId,
            fundingMethodId: input.fundingMethodId,
            fundingMethodRail: fundingMethod.rail,
            eventRail: "usdc_base",
          },
        );
      }

      const referenceType = "usdc_base_transaction";
      const referenceId = usdcTransactionReferenceId(input);
      const replay = await findReplayLedgerWithClient(client, {
        vendorId: input.vendorId,
        idempotencyKey: input.idempotencyKey,
        referenceType,
        referenceId,
      });
      if (replay) {
        assertLedgerReplayMatches(replay, {
          type: "funding",
          amountCents: input.amountCents,
          currency: input.currency,
          status: "settled",
          referenceType,
          referenceId,
          requestHash: input.requestHash,
        });
        const usdcLedgerEntry = await insertUsdcLedgerEntryWithClient(client, {
          vendorId: input.vendorId,
          walletLedgerId: replay.ledgerEntryId,
          chainId: input.chainId,
          transactionHash: input.transactionHash,
          fromAddress: input.fromAddress ?? null,
          toAddress: input.toAddress,
          logIndex: input.logIndex,
          amountAtomicUnits: input.amountAtomicUnits,
          confirmations: input.confirmations,
          status: "settled",
          observedAt: input.observedAt,
          settledAt: input.occurredAt,
        });
        await recordWalletAuditEvent(client, {
          vendorId: input.vendorId,
          entityType: "dropship_usdc_ledger_entries",
          entityId: String(usdcLedgerEntry.usdcLedgerEntryId),
          eventType: "wallet_usdc_funding_observed",
          payload: serializeUsdcLedgerForAudit(usdcLedgerEntry),
          createdAt: input.occurredAt,
        });
        await client.query("COMMIT");
        return {
          account,
          ledgerEntry: replay,
          usdcLedgerEntry,
          idempotentReplay: true,
        };
      }

      const nextAvailable = account.availableBalanceCents + input.amountCents;
      const updatedAccount = await updateWalletBalancesWithClient(client, {
        walletAccountId: account.walletAccountId,
        vendorId: input.vendorId,
        availableBalanceCents: nextAvailable,
        pendingBalanceCents: account.pendingBalanceCents,
        updatedAt: input.occurredAt,
      });
      const ledgerEntry = await insertLedgerEntryWithClient(client, {
        walletAccountId: account.walletAccountId,
        vendorId: input.vendorId,
        type: "funding",
        status: "settled",
        amountCents: input.amountCents,
        currency: input.currency,
        availableBalanceAfterCents: nextAvailable,
        pendingBalanceAfterCents: account.pendingBalanceCents,
        rewardsBalanceAfterCents: account.rewardsBalanceCents,
        referenceType,
        referenceId,
        idempotencyKey: input.idempotencyKey,
        fundingMethodId: input.fundingMethodId,
        externalTransactionId: input.transactionHash,
        metadata: {
          amountAtomicUnits: input.amountAtomicUnits,
          chainId: input.chainId,
          transactionHash: input.transactionHash,
          fromAddress: input.fromAddress ?? null,
          toAddress: input.toAddress,
          confirmations: input.confirmations,
          actorType: input.actor.actorType,
          actorId: input.actor.actorId ?? null,
          rail: "usdc_base",
          requestHash: input.requestHash,
        },
        createdAt: input.occurredAt,
        settledAt: input.occurredAt,
      });
      const usdcLedgerEntry = await insertUsdcLedgerEntryWithClient(client, {
        vendorId: input.vendorId,
        walletLedgerId: ledgerEntry.ledgerEntryId,
        chainId: input.chainId,
        transactionHash: input.transactionHash,
        fromAddress: input.fromAddress ?? null,
        toAddress: input.toAddress,
        logIndex: input.logIndex,
        amountAtomicUnits: input.amountAtomicUnits,
        confirmations: input.confirmations,
        status: "settled",
        observedAt: input.observedAt,
        settledAt: input.occurredAt,
      });
      await recordWalletAuditEvent(client, {
        vendorId: input.vendorId,
        entityType: "dropship_wallet_ledger",
        entityId: String(ledgerEntry.ledgerEntryId),
        eventType: "wallet_funding_settled",
        payload: serializeLedgerForAudit(ledgerEntry),
        createdAt: input.occurredAt,
      });
      await recordWalletAuditEvent(client, {
        vendorId: input.vendorId,
        entityType: "dropship_usdc_ledger_entries",
        entityId: String(usdcLedgerEntry.usdcLedgerEntryId),
        eventType: "wallet_usdc_funding_observed",
        payload: serializeUsdcLedgerForAudit(usdcLedgerEntry),
        createdAt: input.occurredAt,
      });
      const accrued = await accrueRewardsForSettledCreditWithClient(client, {
        account: updatedAccount,
        credit: ledgerEntry,
        rail: "usdc_base",
        occurredAt: input.occurredAt,
      });
      await client.query("COMMIT");
      return {
        account: accrued?.account ?? updatedAccount,
        ledgerEntry,
        usdcLedgerEntry,
        idempotentReplay: false,
      };
    } catch (error) {
      await rollbackQuietly(client);
      if (isUniqueViolation(error)) {
        const replay = await this.findConfirmedUsdcFundingReplayAfterUniqueConflict(input);
        if (replay) return replay;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async debitOrder(input: CreateDropshipWalletOrderDebitInput): Promise<DropshipWalletMutationResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const account = await loadWalletAccountForMutation(client, input);
      const referenceType = "order_intake";
      const referenceId = String(input.intakeId);

      const replay = await findReplayLedgerWithClient(client, {
        vendorId: input.vendorId,
        idempotencyKey: input.idempotencyKey,
        referenceType,
        referenceId,
      });
      if (replay) {
        assertLedgerReplayMatches(replay, {
          type: "order_debit",
          amountCents: -input.amountCents,
          currency: input.currency,
          status: "settled",
          referenceType,
          referenceId,
          requestHash: input.requestHash,
        });
        await client.query("COMMIT");
        return {
          account,
          ledgerEntry: replay,
          idempotentReplay: true,
        };
      }

      if (account.availableBalanceCents < input.amountCents) {
        throw new DropshipError(
          "DROPSHIP_WALLET_INSUFFICIENT_FUNDS",
          "Dropship wallet has insufficient available funds for order acceptance.",
          {
            vendorId: input.vendorId,
            walletAccountId: account.walletAccountId,
            intakeId: input.intakeId,
            availableBalanceCents: account.availableBalanceCents,
            requiredCents: input.amountCents,
          },
        );
      }

      const nextAvailable = account.availableBalanceCents - input.amountCents;
      const updatedAccount = await updateWalletBalancesWithClient(client, {
        walletAccountId: account.walletAccountId,
        vendorId: input.vendorId,
        availableBalanceCents: nextAvailable,
        pendingBalanceCents: account.pendingBalanceCents,
        updatedAt: input.occurredAt,
      });
      const ledgerEntry = await insertLedgerEntryWithClient(client, {
        walletAccountId: account.walletAccountId,
        vendorId: input.vendorId,
        type: "order_debit",
        status: "settled",
        amountCents: -input.amountCents,
        currency: input.currency,
        availableBalanceAfterCents: nextAvailable,
        pendingBalanceAfterCents: account.pendingBalanceCents,
        rewardsBalanceAfterCents: account.rewardsBalanceCents,
        referenceType,
        referenceId,
        idempotencyKey: input.idempotencyKey,
        fundingMethodId: null,
        externalTransactionId: null,
        metadata: {
          ...(input.metadata ?? {}),
          requestHash: input.requestHash,
        },
        createdAt: input.occurredAt,
        settledAt: input.occurredAt,
      });
      await recordWalletAuditEvent(client, {
        vendorId: input.vendorId,
        entityType: "dropship_wallet_ledger",
        entityId: String(ledgerEntry.ledgerEntryId),
        eventType: "wallet_order_debited",
        payload: serializeLedgerForAudit(ledgerEntry),
        createdAt: input.occurredAt,
      });
      await client.query("COMMIT");
      return {
        account: updatedAccount,
        ledgerEntry,
        idempotentReplay: false,
      };
    } catch (error) {
      await rollbackQuietly(client);
      if (isUniqueViolation(error)) {
        const replay = await this.findLedgerReplayAfterUniqueConflict({
          ...input,
          referenceType: "order_intake",
          referenceId: String(input.intakeId),
          amountCents: -input.amountCents,
          status: "settled",
          type: "order_debit",
        });
        if (replay) return replay;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async configureAutoReload(
    input: ConfigureDropshipAutoReloadRepositoryInput,
  ): Promise<DropshipAutoReloadSettingRecord> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      await assertFundingMethodCanBeUsed(client, {
        vendorId: input.vendorId,
        fundingMethodId: input.fundingMethodId,
      });
      const result = await client.query<AutoReloadRow>(
        `INSERT INTO dropship.dropship_auto_reload_settings
          (vendor_id, funding_method_id, enabled, minimum_balance_cents,
           max_single_reload_cents, payment_hold_timeout_minutes, created_at, updated_at,
           top_up_amount_cents, acknowledged_card_fee_bps, acknowledged_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10)
         ON CONFLICT (vendor_id) DO UPDATE
           SET funding_method_id = EXCLUDED.funding_method_id,
               enabled = EXCLUDED.enabled,
               minimum_balance_cents = EXCLUDED.minimum_balance_cents,
               max_single_reload_cents = EXCLUDED.max_single_reload_cents,
               top_up_amount_cents = EXCLUDED.top_up_amount_cents,
               payment_hold_timeout_minutes = EXCLUDED.payment_hold_timeout_minutes,
               acknowledged_card_fee_bps = EXCLUDED.acknowledged_card_fee_bps,
               acknowledged_at = EXCLUDED.acknowledged_at,
               updated_at = EXCLUDED.updated_at
         RETURNING id, vendor_id, funding_method_id, enabled, minimum_balance_cents,
                   max_single_reload_cents, top_up_amount_cents, payment_hold_timeout_minutes,
                   acknowledged_card_fee_bps, acknowledged_at, spend_rewards_first, created_at, updated_at`,
        [
          input.vendorId,
          input.fundingMethodId,
          input.enabled,
          input.minimumBalanceCents,
          input.maxSingleReloadCents,
          input.paymentHoldTimeoutMinutes,
          input.updatedAt,
          input.topUpAmountCents,
          // The rate the vendor agreed to is stored with the row (migration
          // 0701), so an unattended charge can be held to it; a client that
          // sent none leaves it null and pays the live rate.
          input.acknowledgedCardFeeBps ?? null,
          input.acknowledgedCardFeeBps === undefined ? null : input.updatedAt,
        ],
      );
      const setting = mapAutoReloadRow(requiredRow(
        result.rows[0],
        "Dropship auto-reload upsert did not return a row.",
      ));
      await recordWalletAuditEvent(client, {
        vendorId: input.vendorId,
        entityType: "dropship_auto_reload_settings",
        entityId: String(setting.autoReloadSettingId),
        eventType: "wallet_auto_reload_configured",
        payload: {
          enabled: setting.enabled,
          fundingMethodId: setting.fundingMethodId,
          minimumBalanceCents: setting.minimumBalanceCents,
          topUpAmountCents: setting.topUpAmountCents,
          maxSingleReloadCents: setting.maxSingleReloadCents,
          paymentHoldTimeoutMinutes: setting.paymentHoldTimeoutMinutes,
          // The fee rate the vendor agreed to is part of the mandate: it is
          // recorded with the configuration, not looked up later.
          cardFundingFeeBps: input.cardFundingFeeBps,
          acknowledgedCardFeeBps: input.acknowledgedCardFeeBps ?? null,
        },
        createdAt: input.updatedAt,
      });
      await client.query("COMMIT");
      return setting;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  // ---- USDC deposits watched on chain (funding design phase 6) ----

  async findUsdcDepositByLog(input: { chainId: number; transactionHash: string; logIndex: number }): Promise<DropshipUsdcLedgerEntryRecord | null> {
    const result = await this.dbPool.query<UsdcLedgerRow>(
      `SELECT ${USDC_LEDGER_COLUMNS}
       FROM dropship.dropship_usdc_ledger_entries
       WHERE chain_id = $1
         AND transaction_hash = $2
         AND log_index = $3
       LIMIT 1`,
      [input.chainId, input.transactionHash, input.logIndex],
    );
    return result.rows[0] ? mapUsdcLedgerRow(result.rows[0]) : null;
  }

  async listPendingUsdcDeposits(input: { chainId: number; limit: number }): Promise<DropshipUsdcLedgerEntryRecord[]> {
    const result = await this.dbPool.query<UsdcLedgerRow>(
      `SELECT ${USDC_LEDGER_COLUMNS}
       FROM dropship.dropship_usdc_ledger_entries
       WHERE chain_id = $1
         AND status = 'pending'
         AND log_index IS NOT NULL
       ORDER BY block_number ASC NULLS FIRST, id ASC
       LIMIT $2`,
      [input.chainId, input.limit],
    );
    return result.rows.map(mapUsdcLedgerRow);
  }

  /**
   * Record a transfer the watcher found. Pending or settled, the wallet
   * balance and the chain observation are written in one transaction; dust
   * is recorded and moves nothing. A replayed scan (the cursor did not
   * advance after a failure) finds its own row and moves nothing twice.
   */
  async setRewardsSpendPreference(
    input: SetDropshipRewardsSpendPreferenceRepositoryInput,
  ): Promise<DropshipAutoReloadSettingRecord> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      // The settings row exists for every provisioned vendor; a vendor whose
      // scaffolding predates it gets the defaults first, then the choice.
      await ensureDropshipWalletScaffoldingForVendor(client, { vendorId: input.vendorId, now: input.updatedAt });
      const result = await client.query<AutoReloadRow>(
        `UPDATE dropship.dropship_auto_reload_settings
         SET spend_rewards_first = $2,
             updated_at = $3
         WHERE vendor_id = $1
         RETURNING id, vendor_id, funding_method_id, enabled, minimum_balance_cents,
                   max_single_reload_cents, top_up_amount_cents, payment_hold_timeout_minutes,
                   acknowledged_card_fee_bps, acknowledged_at, spend_rewards_first, created_at, updated_at`,
        [input.vendorId, input.spendRewardsFirst, input.updatedAt],
      );
      const setting = mapAutoReloadRow(requiredRow(
        result.rows[0],
        "Dropship rewards preference update did not return a row.",
      ));
      await recordWalletAuditEvent(client, {
        vendorId: input.vendorId,
        entityType: "dropship_auto_reload_settings",
        entityId: String(setting.autoReloadSettingId),
        eventType: "wallet_rewards_preference_saved",
        payload: { spendRewardsFirst: setting.spendRewardsFirst },
        createdAt: input.updatedAt,
        actor: { type: "member", id: input.actorMemberId },
      });
      await client.query("COMMIT");
      return setting;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async observeUsdcDeposit(input: ObserveDropshipUsdcDepositRepositoryInput): Promise<DropshipUsdcDepositLedgerResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const existing = await findUsdcLedgerByTransactionWithClient(client, {
        chainId: input.transfer.chainId,
        transactionHash: input.transfer.transactionHash,
        logIndex: input.transfer.logIndex,
      });
      if (existing) {
        assertUsdcObservationMatches(existing, input);
        const replay = await readUsdcDepositLedgerResultWithClient(client, {
          vendorId: input.vendorId,
          currency: input.currency,
          usdcLedgerEntry: existing,
          now: input.occurredAt,
        });
        await client.query("COMMIT");
        return replay;
      }

      const account = await loadWalletAccountForMutation(client, {
        vendorId: input.vendorId,
        walletAccountId: null,
        currency: input.currency,
        occurredAt: input.occurredAt,
      });
      const chainFacts = {
        vendorId: input.vendorId,
        chainId: input.transfer.chainId,
        transactionHash: input.transfer.transactionHash,
        fromAddress: input.transfer.fromAddress,
        toAddress: input.transfer.toAddress,
        amountAtomicUnits: input.transfer.amountAtomicUnits,
        confirmations: input.confirmations,
        observedAt: input.occurredAt,
        logIndex: input.transfer.logIndex,
        blockNumber: input.transfer.blockNumber,
        blockHash: input.transfer.blockHash,
        tokenAddress: input.transfer.tokenAddress,
        depositAddressId: input.depositAddressId,
        dustAtomicUnits: input.dustAtomicUnits,
      };

      if (input.status === "dust") {
        const usdcLedgerEntry = await insertUsdcLedgerEntryWithClient(client, {
          ...chainFacts,
          walletLedgerId: null,
          status: "dust",
          settledAt: null,
        });
        await recordWalletAuditEvent(client, {
          vendorId: input.vendorId,
          entityType: "dropship_usdc_ledger_entries",
          entityId: String(usdcLedgerEntry.usdcLedgerEntryId),
          eventType: "wallet_usdc_deposit_dust",
          payload: serializeUsdcLedgerForAudit(usdcLedgerEntry),
          createdAt: input.occurredAt,
        });
        await client.query("COMMIT");
        return { account, ledgerEntry: null, usdcLedgerEntry, idempotentReplay: false };
      }

      const referenceType = "usdc_base_transaction";
      const referenceId = usdcDepositReferenceId(input.transfer);
      const nextAvailable = input.status === "settled"
        ? account.availableBalanceCents + input.amountCents
        : account.availableBalanceCents;
      const nextPending = input.status === "pending"
        ? account.pendingBalanceCents + input.amountCents
        : account.pendingBalanceCents;
      const updatedAccount = await updateWalletBalancesWithClient(client, {
        walletAccountId: account.walletAccountId,
        vendorId: input.vendorId,
        availableBalanceCents: nextAvailable,
        pendingBalanceCents: nextPending,
        updatedAt: input.occurredAt,
      });
      const ledgerEntry = await insertLedgerEntryWithClient(client, {
        walletAccountId: account.walletAccountId,
        vendorId: input.vendorId,
        type: "funding",
        status: input.status,
        amountCents: input.amountCents,
        currency: input.currency,
        availableBalanceAfterCents: nextAvailable,
        pendingBalanceAfterCents: nextPending,
        rewardsBalanceAfterCents: account.rewardsBalanceCents,
        referenceType,
        referenceId,
        idempotencyKey: `usdc-deposit:${referenceId}`,
        fundingMethodId: null,
        externalTransactionId: input.transfer.transactionHash,
        metadata: {
          rail: "usdc_base",
          source: "chain_watcher",
          chainId: input.transfer.chainId,
          tokenAddress: input.transfer.tokenAddress,
          transactionHash: input.transfer.transactionHash,
          logIndex: input.transfer.logIndex,
          blockNumber: input.transfer.blockNumber,
          blockHash: input.transfer.blockHash,
          fromAddress: input.transfer.fromAddress,
          toAddress: input.transfer.toAddress,
          amountAtomicUnits: input.transfer.amountAtomicUnits,
          dustAtomicUnits: input.dustAtomicUnits,
          confirmations: input.confirmations,
          depositAddressId: input.depositAddressId,
          requestHash: input.requestHash,
        },
        createdAt: input.occurredAt,
        settledAt: input.status === "settled" ? input.occurredAt : null,
      });
      const usdcLedgerEntry = await insertUsdcLedgerEntryWithClient(client, {
        ...chainFacts,
        walletLedgerId: ledgerEntry.ledgerEntryId,
        status: input.status,
        settledAt: input.status === "settled" ? input.occurredAt : null,
      });
      await recordWalletAuditEvent(client, {
        vendorId: input.vendorId,
        entityType: "dropship_wallet_ledger",
        entityId: String(ledgerEntry.ledgerEntryId),
        eventType: input.status === "settled" ? "wallet_funding_settled" : "wallet_funding_pending",
        payload: serializeLedgerForAudit(ledgerEntry),
        createdAt: input.occurredAt,
      });
      await recordWalletAuditEvent(client, {
        vendorId: input.vendorId,
        entityType: "dropship_usdc_ledger_entries",
        entityId: String(usdcLedgerEntry.usdcLedgerEntryId),
        eventType: "wallet_usdc_deposit_observed",
        payload: serializeUsdcLedgerForAudit(usdcLedgerEntry),
        createdAt: input.occurredAt,
      });
      const accrued = input.status === "settled"
        ? await accrueRewardsForSettledCreditWithClient(client, {
            account: updatedAccount,
            credit: ledgerEntry,
            rail: "usdc_base",
            occurredAt: input.occurredAt,
          })
        : null;
      await client.query("COMMIT");
      return { account: accrued?.account ?? updatedAccount, ledgerEntry, usdcLedgerEntry, idempotentReplay: false };
    } catch (error) {
      await rollbackQuietly(client);
      if (isUniqueViolation(error)) {
        // Two watcher ticks raced on one transfer: read what the winner
        // wrote, without a transaction, and report it as a replay.
        const replay = await this.findUsdcDepositReplay(input);
        if (replay) return replay;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Settle a pending deposit once its block is at or below the safe head: pending → available. */
  async settleUsdcDeposit(input: SettleDropshipUsdcDepositRepositoryInput): Promise<DropshipUsdcDepositLedgerResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const usdcLedgerEntry = await requireUsdcLedgerForUpdate(client, input);
      if (usdcLedgerEntry.status !== "pending") {
        const replay = await readUsdcDepositLedgerResultWithClient(client, {
          vendorId: input.vendorId,
          currency: null,
          usdcLedgerEntry,
          now: input.occurredAt,
        });
        await client.query("COMMIT");
        return replay;
      }
      const { account, ledgerEntry } = await loadPendingUsdcCreditForUpdate(client, { vendorId: input.vendorId, usdcLedgerEntry });
      const settled = await settlePendingFundingWithClient(client, {
        account,
        ledgerEntry,
        fundingMethodId: null,
        externalTransactionId: usdcLedgerEntry.transactionHash,
        metadata: {
          settledFromPending: true,
          settledBlockNumber: input.current.blockNumber,
          settledBlockHash: input.current.blockHash,
          confirmations: input.confirmations,
        },
        settledAt: input.occurredAt,
      });
      const updatedUsdc = await updateUsdcLedgerChainStateWithClient(client, {
        usdcLedgerEntryId: usdcLedgerEntry.usdcLedgerEntryId,
        vendorId: input.vendorId,
        status: "settled",
        confirmations: input.confirmations,
        blockNumber: input.current.blockNumber,
        blockHash: input.current.blockHash,
        settledAt: input.occurredAt,
        voidedAt: null,
      });
      await recordWalletAuditEvent(client, {
        vendorId: input.vendorId,
        entityType: "dropship_wallet_ledger",
        entityId: String(settled.ledgerEntry.ledgerEntryId),
        eventType: "wallet_funding_settled",
        payload: serializeLedgerForAudit(settled.ledgerEntry),
        createdAt: input.occurredAt,
      });
      await recordWalletAuditEvent(client, {
        vendorId: input.vendorId,
        entityType: "dropship_usdc_ledger_entries",
        entityId: String(updatedUsdc.usdcLedgerEntryId),
        eventType: "wallet_usdc_deposit_settled",
        payload: serializeUsdcLedgerForAudit(updatedUsdc),
        createdAt: input.occurredAt,
      });
      const accrued = await accrueRewardsForSettledCreditWithClient(client, {
        account: settled.account,
        credit: settled.ledgerEntry,
        rail: "usdc_base",
        occurredAt: input.occurredAt,
      });
      await client.query("COMMIT");
      return { account: accrued?.account ?? settled.account, ledgerEntry: settled.ledgerEntry, usdcLedgerEntry: updatedUsdc, idempotentReplay: false };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Void a pending deposit a reorg removed: the amount leaves the pending balance, nothing else moves. */
  async voidUsdcDeposit(input: VoidDropshipUsdcDepositRepositoryInput): Promise<DropshipUsdcDepositLedgerResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const usdcLedgerEntry = await requireUsdcLedgerForUpdate(client, input);
      if (usdcLedgerEntry.status !== "pending") {
        const replay = await readUsdcDepositLedgerResultWithClient(client, {
          vendorId: input.vendorId,
          currency: null,
          usdcLedgerEntry,
          now: input.occurredAt,
        });
        await client.query("COMMIT");
        return replay;
      }
      if (usdcLedgerEntry.blockNumber === null || usdcLedgerEntry.blockHash === null) {
        // Only a watched deposit (one with a block on record) is ever voided
        // automatically; a manual staff credit is reversed by hand.
        throw new DropshipError(
          "DROPSHIP_USDC_DEPOSIT_CHAIN_FACTS_MISSING",
          "A USDC deposit without a block on record cannot be voided automatically.",
          { vendorId: input.vendorId, usdcLedgerEntryId: usdcLedgerEntry.usdcLedgerEntryId, classification: "permanent" },
        );
      }
      const { ledgerEntry } = await loadPendingUsdcCreditForUpdate(client, { vendorId: input.vendorId, usdcLedgerEntry });
      const voided = await voidPendingFundingWithClient(client, {
        vendorId: input.vendorId,
        ledgerEntry,
        failure: {
          code: input.reasonCode,
          message: input.reasonMessage,
          providerStatus: "reorged",
          providerEventId: `usdc-deposit-void:${usdcDepositReferenceId(usdcLedgerEntry)}`,
        },
        occurredAt: input.occurredAt,
      });
      const updatedUsdc = await updateUsdcLedgerChainStateWithClient(client, {
        usdcLedgerEntryId: usdcLedgerEntry.usdcLedgerEntryId,
        vendorId: input.vendorId,
        status: "voided",
        confirmations: 0,
        blockNumber: usdcLedgerEntry.blockNumber,
        blockHash: usdcLedgerEntry.blockHash,
        settledAt: null,
        voidedAt: input.occurredAt,
      });
      await recordWalletAuditEvent(client, {
        vendorId: input.vendorId,
        entityType: "dropship_usdc_ledger_entries",
        entityId: String(updatedUsdc.usdcLedgerEntryId),
        eventType: "wallet_usdc_deposit_voided",
        payload: { ...serializeUsdcLedgerForAudit(updatedUsdc), reasonCode: input.reasonCode, reasonMessage: input.reasonMessage },
        createdAt: input.occurredAt,
      });
      await client.query("COMMIT");
      return { account: voided.account, ledgerEntry: voided.ledgerEntry, usdcLedgerEntry: updatedUsdc, idempotentReplay: false };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /** A pending deposit re-included in another block: record where it sits now; no money moves. */
  async recordUsdcDepositMoved(input: RecordDropshipUsdcDepositMovedRepositoryInput): Promise<DropshipUsdcLedgerEntryRecord> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const usdcLedgerEntry = await requireUsdcLedgerForUpdate(client, input);
      if (usdcLedgerEntry.status !== "pending") {
        await client.query("COMMIT");
        return usdcLedgerEntry;
      }
      const moved = await updateUsdcLedgerChainStateWithClient(client, {
        usdcLedgerEntryId: usdcLedgerEntry.usdcLedgerEntryId,
        vendorId: input.vendorId,
        status: "pending",
        confirmations: input.confirmations,
        blockNumber: input.current.blockNumber,
        blockHash: input.current.blockHash,
        settledAt: null,
        voidedAt: null,
      });
      await recordWalletAuditEvent(client, {
        vendorId: input.vendorId,
        entityType: "dropship_usdc_ledger_entries",
        entityId: String(moved.usdcLedgerEntryId),
        eventType: "wallet_usdc_deposit_moved",
        payload: {
          ...serializeUsdcLedgerForAudit(moved),
          previousBlockNumber: usdcLedgerEntry.blockNumber,
          previousBlockHash: usdcLedgerEntry.blockHash,
        },
        createdAt: input.occurredAt,
      });
      await client.query("COMMIT");
      return moved;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Read-only: what a racing tick already wrote for this transfer. */
  private async findUsdcDepositReplay(input: ObserveDropshipUsdcDepositRepositoryInput): Promise<DropshipUsdcDepositLedgerResult | null> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<UsdcLedgerRow>(
        `SELECT ${USDC_LEDGER_COLUMNS}
         FROM dropship.dropship_usdc_ledger_entries
         WHERE chain_id = $1
           AND transaction_hash = $2
           AND log_index = $3
         LIMIT 1`,
        [input.transfer.chainId, input.transfer.transactionHash, input.transfer.logIndex],
      );
      if (!result.rows[0]) return null;
      const usdcLedgerEntry = mapUsdcLedgerRow(result.rows[0]);
      assertUsdcObservationMatches(usdcLedgerEntry, input);
      return readUsdcDepositLedgerResultWithClient(client, {
        vendorId: input.vendorId,
        currency: input.currency,
        usdcLedgerEntry,
        now: input.occurredAt,
      });
    } finally {
      client.release();
    }
  }

  async failPendingFunding(input: FailDropshipPendingFundingRepositoryInput): Promise<DropshipWalletFundingFailureRepositoryResult | null> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const ledgerEntry = await findFundingLedgerByReferenceWithClient(client, input);
      if (!ledgerEntry) {
        // Nothing was recorded for this payment (a card declined at charge
        // time never reaches the ledger): nothing to void.
        await client.query("COMMIT");
        return null;
      }
      if (ledgerEntry.walletAccountId === null) {
        throw new DropshipError(
          "DROPSHIP_WALLET_LEDGER_ACCOUNT_MISSING",
          "Dropship wallet funding ledger entry is not attached to a wallet account.",
          { vendorId: input.vendorId, ledgerEntryId: ledgerEntry.ledgerEntryId, retryable: false },
        );
      }
      if (ledgerEntry.status !== "pending") {
        // Already settled, failed or voided: a replayed webhook. Report the
        // entry as it stands and move no money.
        const account = await loadWalletAccountByIdWithClient(client, {
          vendorId: input.vendorId,
          walletAccountId: ledgerEntry.walletAccountId,
        });
        await client.query("COMMIT");
        return {
          account: requiredRow(account ?? undefined, "Dropship wallet account for a funding ledger entry was not found."),
          ledgerEntry,
          idempotentReplay: true,
          vendorPaused: null,
        };
      }

      const { account: updatedAccount, ledgerEntry: failedEntry } = await voidPendingFundingWithClient(client, {
        vendorId: input.vendorId,
        ledgerEntry,
        failure: {
          code: input.failureCode,
          message: input.failureMessage,
          providerStatus: input.providerStatus,
          providerEventId: input.providerEventId,
        },
        occurredAt: input.occurredAt,
      });
      // Same transaction as the void: the vendor is paused because this
      // credit failed, and the two facts commit or roll back together.
      const pause = input.pauseVendor
        ? await pauseDropshipVendorWithClient(client, {
            vendorId: input.vendorId,
            reason: input.pauseVendor.reason,
            evidence: { ...input.pauseVendor.evidence, ledgerEntryId: failedEntry.ledgerEntryId },
            now: input.occurredAt,
          })
        : null;
      await client.query("COMMIT");
      return {
        account: updatedAccount,
        ledgerEntry: failedEntry,
        idempotentReplay: false,
        vendorPaused: pause?.changed ? pause.standing : null,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async readAdvanceContext(input: { vendorId: number; now: Date }): Promise<DropshipAdvanceContext | null> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const account = await getOrCreateWalletAccountWithClient(client, {
        vendorId: input.vendorId,
        currency: "USD",
        now: input.now,
      });
      const policy = await loadAdvancePolicyWithClient(client, input.vendorId);
      const sources = policy
        ? await loadAdvanceSourcesWithClient(client, { vendorId: input.vendorId, walletAccountId: account.walletAccountId })
        : [];
      await client.query("COMMIT");
      return policy ? { policy, sources } : null;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordBankBalanceVerification(
    input: RecordDropshipBankBalanceVerificationRepositoryInput,
  ): Promise<{ record: DropshipBankBalanceVerificationRecord; idempotentReplay: boolean }> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const method = await client.query<{ id: number }>(
        `SELECT id
         FROM dropship.dropship_funding_methods
         WHERE id = $1
           AND vendor_id = $2
         LIMIT 1`,
        [input.fundingMethodId, input.vendorId],
      );
      if (!method.rows[0]) {
        throw new DropshipError(
          "DROPSHIP_FUNDING_METHOD_NOT_FOUND",
          "Dropship funding method was not found for this vendor.",
          { vendorId: input.vendorId, fundingMethodId: input.fundingMethodId, retryable: false },
        );
      }
      const reading = input.reading;
      const inserted = await client.query<BalanceVerificationRow>(
        `INSERT INTO dropship.dropship_funding_method_balance_verifications
          (vendor_id, funding_method_id, provider, provider_account_id, status, source,
           available_cents, currency, balance_as_of, provider_event_id, detail, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
         ON CONFLICT (provider, provider_event_id) WHERE provider_event_id IS NOT NULL DO NOTHING
         RETURNING id, vendor_id, funding_method_id, provider, provider_account_id, status, source,
                   available_cents, currency, balance_as_of, provider_event_id, created_at`,
        [
          input.vendorId,
          input.fundingMethodId,
          input.provider,
          reading.providerAccountId,
          reading.status,
          input.source,
          reading.status === "succeeded" ? reading.availableCents : null,
          reading.status === "succeeded" ? reading.currency : null,
          reading.status === "succeeded" ? reading.asOf : null,
          input.providerEventId,
          JSON.stringify(
            reading.status === "failed"
              ? { reason: reading.reason }
              : reading.status === "pending"
                ? { nextRefreshAvailableAt: reading.nextRefreshAvailableAt?.toISOString() ?? null }
                : {},
          ),
          input.occurredAt,
        ],
      );
      let row = inserted.rows[0];
      let idempotentReplay = false;
      if (!row) {
        // Only a provider event id can conflict: the same event was recorded before.
        const existing = await client.query<BalanceVerificationRow>(
          `SELECT id, vendor_id, funding_method_id, provider, provider_account_id, status, source,
                  available_cents, currency, balance_as_of, provider_event_id, created_at
           FROM dropship.dropship_funding_method_balance_verifications
           WHERE provider = $1
             AND provider_event_id = $2
           LIMIT 1`,
          [input.provider, input.providerEventId],
        );
        row = requiredRow(existing.rows[0], "Dropship bank balance verification conflict did not resolve to a row.");
        idempotentReplay = true;
      } else {
        await recordWalletAuditEvent(client, {
          vendorId: input.vendorId,
          entityType: "dropship_funding_method_balance_verification",
          entityId: String(row.id),
          eventType: `wallet_bank_balance_${reading.status}`,
          payload: {
            fundingMethodId: input.fundingMethodId,
            provider: input.provider,
            providerAccountId: reading.providerAccountId,
            source: input.source,
            providerEventId: input.providerEventId,
            status: reading.status,
            availableCents: reading.status === "succeeded" ? reading.availableCents : null,
            currency: reading.status === "succeeded" ? reading.currency : null,
            balanceAsOf: reading.status === "succeeded" ? reading.asOf.toISOString() : null,
            reason: reading.status === "failed" ? reading.reason : null,
          },
          createdAt: input.occurredAt,
        });
      }
      await client.query("COMMIT");
      return { record: mapBalanceVerificationRow(row), idempotentReplay };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async findFundingMethodByProviderAccount(input: {
    provider: "stripe";
    providerAccountId: string;
  }): Promise<DropshipFundingMethodRecord | null> {
    const result = await this.dbPool.query<FundingMethodRow>(
      `SELECT id, vendor_id, rail, status, provider_customer_id,
              provider_payment_method_id, usdc_wallet_address, display_label,
              is_default, metadata, created_at, updated_at
       FROM dropship.dropship_funding_methods
       WHERE rail = 'stripe_ach'
         AND metadata->>'provider' = $1
         AND metadata->>$2 = $3
       ORDER BY (status = 'active') DESC, id DESC
       LIMIT 1`,
      [input.provider, FUNDING_METHOD_FINANCIAL_CONNECTIONS_ACCOUNT_KEY, input.providerAccountId],
    );
    return result.rows[0] ? mapFundingMethodRow(result.rows[0]) : null;
  }

  async reverseSettledFunding(
    input: ReverseDropshipSettledFundingRepositoryInput,
  ): Promise<DropshipFundingReversalRepositoryResult | null> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      // The dispute names the provider's payment; the wallet's credit for it
      // is the only thing that says which vendor this is.
      const credit = await findLedgerByReferenceWithClient(client, {
        referenceType: "stripe_payment_intent",
        referenceId: input.providerPaymentIntentId,
        type: "funding",
        forUpdate: true,
      });
      if (!credit) {
        await client.query("COMMIT");
        return null;
      }
      if (credit.walletAccountId === null) {
        throw new DropshipError(
          "DROPSHIP_WALLET_LEDGER_ACCOUNT_MISSING",
          "Dropship wallet funding ledger entry is not attached to a wallet account.",
          { vendorId: credit.vendorId, ledgerEntryId: credit.ledgerEntryId, retryable: false },
        );
      }
      const existing = await findLedgerByReferenceWithClient(client, {
        referenceType: DISPUTE_REVERSAL_REFERENCE_TYPE,
        referenceId: input.providerDisputeId,
        type: "funding_reversal",
        forUpdate: false,
      });
      if (existing) {
        const account = await loadWalletAccountByIdWithClient(client, {
          vendorId: credit.vendorId,
          walletAccountId: credit.walletAccountId,
        });
        await client.query("COMMIT");
        return {
          outcome: "reversed",
          vendorId: credit.vendorId,
          account: requiredRow(account ?? undefined, "Dropship wallet account for a reversed credit was not found."),
          credit,
          reversal: existing,
          idempotentReplay: true,
          vendorPaused: null,
        };
      }
      const decision = decideFundingReversal({
        credit: { amountCents: credit.amountCents, currency: credit.currency, status: credit.status },
        dispute: { amountCents: input.disputeAmountCents, currency: input.currency },
      });
      if (decision.outcome === "ignore") {
        await client.query("COMMIT");
        return { outcome: "ignored", vendorId: credit.vendorId, credit, reason: decision.reason };
      }
      const account = await loadWalletAccountByIdWithClient(client, {
        vendorId: credit.vendorId,
        walletAccountId: credit.walletAccountId,
        forUpdate: true,
      });
      if (!account) {
        throw new DropshipError(
          "DROPSHIP_WALLET_ACCOUNT_NOT_FOUND",
          "Dropship wallet account was not found.",
          { vendorId: credit.vendorId, walletAccountId: credit.walletAccountId, retryable: false },
        );
      }
      // The rewards the credit earned go back too (funding design phase 7):
      // what is still in the rewards balance leaves it, and the part already
      // spent comes out of cash through this same reversal.
      const earned = await findLedgerByReferenceWithClient(client, {
        referenceType: REWARDS_EARNED_REFERENCE_TYPE,
        referenceId: String(credit.ledgerEntryId),
        type: "rewards_earned",
        forUpdate: false,
      });
      const clawback = decideRewardsClawback({
        earnedCents: earned?.amountCents ?? 0,
        creditAmountCents: credit.amountCents,
        reversalCents: decision.reversalCents,
        rewardsBalanceCents: account.rewardsBalanceCents,
      });
      const cashReversalCents = decision.reversalCents + clawback.fromCashCents;
      // The balance may go negative: the money left with the bank, and the
      // negative is the receivable the daily wallet run collects.
      const nextAvailable = account.availableBalanceCents - cashReversalCents;
      const nextRewards = account.rewardsBalanceCents - clawback.fromRewardsCents;
      const updatedAccount = await updateWalletBalancesWithClient(client, {
        walletAccountId: account.walletAccountId,
        vendorId: credit.vendorId,
        availableBalanceCents: nextAvailable,
        pendingBalanceCents: account.pendingBalanceCents,
        rewardsBalanceCents: nextRewards,
        updatedAt: input.occurredAt,
      });
      const reversal = await insertLedgerEntryWithClient(client, {
        walletAccountId: account.walletAccountId,
        vendorId: credit.vendorId,
        type: "funding_reversal",
        status: "settled",
        amountCents: -cashReversalCents,
        currency: credit.currency,
        availableBalanceAfterCents: nextAvailable,
        pendingBalanceAfterCents: account.pendingBalanceCents,
        rewardsBalanceAfterCents: nextRewards,
        referenceType: DISPUTE_REVERSAL_REFERENCE_TYPE,
        referenceId: input.providerDisputeId,
        idempotencyKey: `stripe-dispute:${input.providerDisputeId}`,
        fundingMethodId: credit.fundingMethodId,
        externalTransactionId: null,
        metadata: {
          provider: input.provider,
          providerEventId: input.providerEventId,
          providerDisputeId: input.providerDisputeId,
          providerPaymentIntentId: input.providerPaymentIntentId,
          fundingLedgerEntryId: credit.ledgerEntryId,
          creditAmountCents: credit.amountCents,
          disputeAmountCents: input.disputeAmountCents,
          disputeStatus: input.disputeStatus,
          disputeReason: input.disputeReason,
          rail: credit.metadata.rail ?? null,
          // The credit's rewards: how much this reversal takes back, and how
          // much of that came out of cash because it was already spent.
          rewardsClawback: {
            rewardsLedgerEntryId: earned?.ledgerEntryId ?? null,
            earnedCents: earned?.amountCents ?? 0,
            clawbackCents: clawback.clawbackCents,
            fromRewardsCents: clawback.fromRewardsCents,
            fromCashCents: clawback.fromCashCents,
          },
        },
        createdAt: input.occurredAt,
        settledAt: input.occurredAt,
      });
      await recordWalletAuditEvent(client, {
        vendorId: credit.vendorId,
        entityType: "dropship_wallet_ledger",
        entityId: String(reversal.ledgerEntryId),
        eventType: "wallet_funding_reversed",
        payload: {
          ...serializeLedgerForAudit(reversal),
          before: { availableBalanceCents: account.availableBalanceCents, rewardsBalanceCents: account.rewardsBalanceCents },
          after: { availableBalanceCents: nextAvailable, rewardsBalanceCents: nextRewards },
        },
        createdAt: input.occurredAt,
      });
      if (clawback.fromRewardsCents > 0) {
        const rewardsReversal = await insertLedgerEntryWithClient(client, {
          walletAccountId: account.walletAccountId,
          vendorId: credit.vendorId,
          type: "rewards_reversed",
          status: "settled",
          amountCents: -clawback.fromRewardsCents,
          currency: credit.currency,
          availableBalanceAfterCents: nextAvailable,
          pendingBalanceAfterCents: account.pendingBalanceCents,
          rewardsBalanceAfterCents: nextRewards,
          referenceType: DISPUTE_REWARDS_REVERSAL_REFERENCE_TYPE,
          referenceId: input.providerDisputeId,
          idempotencyKey: `stripe-dispute-rewards:${input.providerDisputeId}`,
          fundingMethodId: credit.fundingMethodId,
          externalTransactionId: null,
          metadata: {
            provider: input.provider,
            providerDisputeId: input.providerDisputeId,
            reversalLedgerEntryId: reversal.ledgerEntryId,
            fundingLedgerEntryId: credit.ledgerEntryId,
            rewardsLedgerEntryId: earned?.ledgerEntryId ?? null,
            clawbackCents: clawback.clawbackCents,
            fromCashCents: clawback.fromCashCents,
          },
          createdAt: input.occurredAt,
          settledAt: input.occurredAt,
        });
        await recordWalletAuditEvent(client, {
          vendorId: credit.vendorId,
          entityType: "dropship_wallet_ledger",
          entityId: String(rewardsReversal.ledgerEntryId),
          eventType: "wallet_rewards_reversed",
          payload: {
            ...serializeLedgerForAudit(rewardsReversal),
            before: { rewardsBalanceCents: account.rewardsBalanceCents },
            after: { rewardsBalanceCents: nextRewards },
          },
          createdAt: input.occurredAt,
        });
      }
      // Same transaction as the reversal: the vendor is paused because this
      // credit was taken back, and the two facts commit or roll back together.
      const pause = input.pauseVendor
        ? await pauseDropshipVendorWithClient(client, {
            vendorId: credit.vendorId,
            reason: input.pauseVendor.reason,
            evidence: { ...input.pauseVendor.evidence, ledgerEntryId: reversal.ledgerEntryId },
            now: input.occurredAt,
          })
        : null;
      await client.query("COMMIT");
      return {
        outcome: "reversed",
        vendorId: credit.vendorId,
        account: updatedAccount,
        credit,
        reversal,
        idempotentReplay: false,
        vendorPaused: pause?.changed ? pause.standing : null,
      };
    } catch (error) {
      await rollbackQuietly(client);
      if (isUniqueViolation(error)) {
        const replay = await this.findFundingReversalReplay(input);
        if (replay) return replay;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * After a unique violation while posting a reversal: two deliveries of the
   * same dispute raced, and the loser reads the winner's row. Read-only, so a
   * violation raised anywhere else can never turn into a reversal posted
   * without its pause.
   */
  private async findFundingReversalReplay(
    input: Pick<ReverseDropshipSettledFundingRepositoryInput, "providerPaymentIntentId" | "providerDisputeId">,
  ): Promise<DropshipFundingReversalRepositoryResult | null> {
    const client = await this.dbPool.connect();
    try {
      const credit = await findLedgerByReferenceWithClient(client, {
        referenceType: "stripe_payment_intent",
        referenceId: input.providerPaymentIntentId,
        type: "funding",
        forUpdate: false,
      });
      const reversal = await findLedgerByReferenceWithClient(client, {
        referenceType: DISPUTE_REVERSAL_REFERENCE_TYPE,
        referenceId: input.providerDisputeId,
        type: "funding_reversal",
        forUpdate: false,
      });
      if (!credit || !reversal || credit.walletAccountId === null) return null;
      const account = await loadWalletAccountByIdWithClient(client, {
        vendorId: credit.vendorId,
        walletAccountId: credit.walletAccountId,
      });
      if (!account) return null;
      return { outcome: "reversed", vendorId: credit.vendorId, account, credit, reversal, idempotentReplay: true, vendorPaused: null };
    } finally {
      client.release();
    }
  }

  async reinstateReversedFunding(
    input: ReinstateDropshipReversedFundingRepositoryInput,
  ): Promise<DropshipFundingReinstatementRepositoryResult | null> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const reversal = await findLedgerByReferenceWithClient(client, {
        referenceType: DISPUTE_REVERSAL_REFERENCE_TYPE,
        referenceId: input.providerDisputeId,
        type: "funding_reversal",
        forUpdate: true,
      });
      if (!reversal || reversal.walletAccountId === null) {
        await client.query("COMMIT");
        return null;
      }
      const existing = await findLedgerByReferenceWithClient(client, {
        referenceType: DISPUTE_REINSTATEMENT_REFERENCE_TYPE,
        referenceId: input.providerDisputeId,
        type: "funding_reinstated",
        forUpdate: false,
      });
      if (existing) {
        const account = await loadWalletAccountByIdWithClient(client, {
          vendorId: reversal.vendorId,
          walletAccountId: reversal.walletAccountId,
        });
        await client.query("COMMIT");
        return {
          vendorId: reversal.vendorId,
          account: requiredRow(account ?? undefined, "Dropship wallet account for a reinstated credit was not found."),
          reversal,
          reinstatement: existing,
          idempotentReplay: true,
        };
      }
      const account = await loadWalletAccountByIdWithClient(client, {
        vendorId: reversal.vendorId,
        walletAccountId: reversal.walletAccountId,
        forUpdate: true,
      });
      if (!account) {
        throw new DropshipError(
          "DROPSHIP_WALLET_ACCOUNT_NOT_FOUND",
          "Dropship wallet account was not found.",
          { vendorId: reversal.vendorId, walletAccountId: reversal.walletAccountId, retryable: false },
        );
      }
      // The reversal's amount already includes any spent rewards it took from
      // cash; the rewards it took from the rewards balance come back to it.
      const rewardsReversal = await findLedgerByReferenceWithClient(client, {
        referenceType: DISPUTE_REWARDS_REVERSAL_REFERENCE_TYPE,
        referenceId: input.providerDisputeId,
        type: "rewards_reversed",
        forUpdate: false,
      });
      const rewardsBackCents = rewardsReversal ? -rewardsReversal.amountCents : 0;
      const amountCents = -reversal.amountCents;
      const nextAvailable = account.availableBalanceCents + amountCents;
      const nextRewards = account.rewardsBalanceCents + rewardsBackCents;
      const updatedAccount = await updateWalletBalancesWithClient(client, {
        walletAccountId: account.walletAccountId,
        vendorId: reversal.vendorId,
        availableBalanceCents: nextAvailable,
        pendingBalanceCents: account.pendingBalanceCents,
        rewardsBalanceCents: nextRewards,
        updatedAt: input.occurredAt,
      });
      const reinstatement = await insertLedgerEntryWithClient(client, {
        walletAccountId: account.walletAccountId,
        vendorId: reversal.vendorId,
        type: "funding_reinstated",
        status: "settled",
        amountCents,
        currency: reversal.currency,
        availableBalanceAfterCents: nextAvailable,
        pendingBalanceAfterCents: account.pendingBalanceCents,
        rewardsBalanceAfterCents: nextRewards,
        referenceType: DISPUTE_REINSTATEMENT_REFERENCE_TYPE,
        referenceId: input.providerDisputeId,
        idempotencyKey: `stripe-dispute-reinstated:${input.providerDisputeId}`,
        fundingMethodId: reversal.fundingMethodId,
        externalTransactionId: null,
        metadata: {
          provider: input.provider,
          providerEventId: input.providerEventId,
          providerDisputeId: input.providerDisputeId,
          reversalLedgerEntryId: reversal.ledgerEntryId,
          fundingLedgerEntryId: reversal.metadata.fundingLedgerEntryId ?? null,
        },
        createdAt: input.occurredAt,
        settledAt: input.occurredAt,
      });
      await recordWalletAuditEvent(client, {
        vendorId: reversal.vendorId,
        entityType: "dropship_wallet_ledger",
        entityId: String(reinstatement.ledgerEntryId),
        eventType: "wallet_funding_reinstated",
        payload: {
          ...serializeLedgerForAudit(reinstatement),
          before: { availableBalanceCents: account.availableBalanceCents, rewardsBalanceCents: account.rewardsBalanceCents },
          after: { availableBalanceCents: nextAvailable, rewardsBalanceCents: nextRewards },
        },
        createdAt: input.occurredAt,
      });
      if (rewardsReversal && rewardsBackCents > 0) {
        const rewardsReinstatement = await insertLedgerEntryWithClient(client, {
          walletAccountId: account.walletAccountId,
          vendorId: reversal.vendorId,
          type: "rewards_reinstated",
          status: "settled",
          amountCents: rewardsBackCents,
          currency: reversal.currency,
          availableBalanceAfterCents: nextAvailable,
          pendingBalanceAfterCents: account.pendingBalanceCents,
          rewardsBalanceAfterCents: nextRewards,
          referenceType: DISPUTE_REWARDS_REINSTATEMENT_REFERENCE_TYPE,
          referenceId: input.providerDisputeId,
          idempotencyKey: `stripe-dispute-rewards-reinstated:${input.providerDisputeId}`,
          fundingMethodId: reversal.fundingMethodId,
          externalTransactionId: null,
          metadata: {
            provider: input.provider,
            providerEventId: input.providerEventId,
            providerDisputeId: input.providerDisputeId,
            rewardsReversalLedgerEntryId: rewardsReversal.ledgerEntryId,
            reinstatementLedgerEntryId: reinstatement.ledgerEntryId,
          },
          createdAt: input.occurredAt,
          settledAt: input.occurredAt,
        });
        await recordWalletAuditEvent(client, {
          vendorId: reversal.vendorId,
          entityType: "dropship_wallet_ledger",
          entityId: String(rewardsReinstatement.ledgerEntryId),
          eventType: "wallet_rewards_reinstated",
          payload: {
            ...serializeLedgerForAudit(rewardsReinstatement),
            before: { rewardsBalanceCents: account.rewardsBalanceCents },
            after: { rewardsBalanceCents: nextRewards },
          },
          createdAt: input.occurredAt,
        });
      }
      await client.query("COMMIT");
      return {
        vendorId: reversal.vendorId,
        account: updatedAccount,
        reversal,
        reinstatement,
        idempotentReplay: false,
      };
    } catch (error) {
      await rollbackQuietly(client);
      if (isUniqueViolation(error)) {
        const replay = await this.findFundingReinstatementReplay(input);
        if (replay) return replay;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** The read-only counterpart of findFundingReversalReplay for a reinstatement that lost a race. */
  private async findFundingReinstatementReplay(
    input: Pick<ReinstateDropshipReversedFundingRepositoryInput, "providerDisputeId">,
  ): Promise<DropshipFundingReinstatementRepositoryResult | null> {
    const client = await this.dbPool.connect();
    try {
      const reversal = await findLedgerByReferenceWithClient(client, {
        referenceType: DISPUTE_REVERSAL_REFERENCE_TYPE,
        referenceId: input.providerDisputeId,
        type: "funding_reversal",
        forUpdate: false,
      });
      const reinstatement = await findLedgerByReferenceWithClient(client, {
        referenceType: DISPUTE_REINSTATEMENT_REFERENCE_TYPE,
        referenceId: input.providerDisputeId,
        type: "funding_reinstated",
        forUpdate: false,
      });
      if (!reversal || !reinstatement || reversal.walletAccountId === null) return null;
      const account = await loadWalletAccountByIdWithClient(client, {
        vendorId: reversal.vendorId,
        walletAccountId: reversal.walletAccountId,
      });
      if (!account) return null;
      return { vendorId: reversal.vendorId, account, reversal, reinstatement, idempotentReplay: true };
    } finally {
      client.release();
    }
  }

  async archiveFundingMethod(
    input: ArchiveDropshipFundingMethodRepositoryInput,
  ): Promise<DropshipFundingMethodMutationResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      // The row lock holds every fact below still while the decision is applied:
      // a concurrent autopay change or a top-up landing on this method waits.
      const row = await selectFundingMethodForUpdateWithClient(client, input);
      const autoReload = await getAutoReloadSettingWithClient(client, input.vendorId);
      const decision = decideFundingMethodRemoval({
        method: {
          fundingMethodId: row.id,
          rail: row.rail,
          status: row.status,
          providerCustomerId: row.provider_customer_id,
          providerPaymentMethodId: row.provider_payment_method_id,
        },
        autoReload: autoReload ? { enabled: autoReload.enabled, fundingMethodId: autoReload.fundingMethodId } : null,
        pendingFundingCount: await countPendingFundingOnMethodWithClient(client, input),
        otherChargeableCardCount: await countOtherChargeableCardsWithClient(client, input),
        vendorStatus: await getVendorLifecycleStatusWithClient(client, input.vendorId),
      });
      if (decision.outcome === "refuse") {
        throw new DropshipError(decision.code, decision.message, { vendorId: input.vendorId, ...decision.context });
      }
      if (decision.outcome === "replay") {
        await client.query("COMMIT");
        return { fundingMethod: mapFundingMethodRow(row), idempotentReplay: true };
      }
      const updated = await client.query<FundingMethodRow>(
        `UPDATE dropship.dropship_funding_methods
         SET status = 'archived',
             is_default = false,
             metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
             updated_at = $4
         WHERE id = $1
           AND vendor_id = $2
           AND status <> 'archived'
         RETURNING id, vendor_id, rail, status, provider_customer_id,
                   provider_payment_method_id, usdc_wallet_address, display_label,
                   is_default, metadata, created_at, updated_at`,
        [
          input.fundingMethodId,
          input.vendorId,
          JSON.stringify({
            [FUNDING_METHOD_ARCHIVED_AT_KEY]: input.archivedAt.toISOString(),
            [FUNDING_METHOD_ARCHIVED_BY_MEMBER_KEY]: input.actorMemberId,
          }),
          input.archivedAt,
        ],
      );
      const fundingMethod = mapFundingMethodRow(requiredRow(
        updated.rows[0],
        "Dropship funding method archive did not return a row.",
      ));
      await recordWalletAuditEvent(client, {
        vendorId: input.vendorId,
        entityType: "dropship_funding_methods",
        entityId: String(fundingMethod.fundingMethodId),
        eventType: "funding_method_archived",
        actor: { type: "member", id: input.actorMemberId },
        payload: {
          rail: row.rail,
          previousStatus: row.status,
          wasDefault: row.is_default,
          providerPaymentMethodId: row.provider_payment_method_id,
        },
        createdAt: input.archivedAt,
      });
      await client.query("COMMIT");
      return { fundingMethod, idempotentReplay: false };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordFundingMethodDetachOutcome(
    input: RecordDropshipFundingMethodDetachOutcomeRepositoryInput,
  ): Promise<DropshipFundingMethodRecord> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<FundingMethodRow>(
        `UPDATE dropship.dropship_funding_methods
         SET metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
             updated_at = $4
         WHERE id = $1
           AND vendor_id = $2
           AND status = 'archived'
         RETURNING id, vendor_id, rail, status, provider_customer_id,
                   provider_payment_method_id, usdc_wallet_address, display_label,
                   is_default, metadata, created_at, updated_at`,
        [
          input.fundingMethodId,
          input.vendorId,
          JSON.stringify({
            [FUNDING_METHOD_PROVIDER_DETACH_KEY]: {
              outcome: input.outcome,
              errorCode: input.errorCode,
              recordedAt: input.recordedAt.toISOString(),
            },
          }),
          input.recordedAt,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new DropshipError(
          "DROPSHIP_FUNDING_METHOD_NOT_ARCHIVED",
          "Dropship funding method is not archived, so no provider detach outcome can be recorded on it.",
          { vendorId: input.vendorId, fundingMethodId: input.fundingMethodId, classification: "permanent" },
        );
      }
      const fundingMethod = mapFundingMethodRow(row);
      await recordWalletAuditEvent(client, {
        vendorId: input.vendorId,
        entityType: "dropship_funding_methods",
        entityId: String(fundingMethod.fundingMethodId),
        eventType: "funding_method_provider_detach_recorded",
        payload: { outcome: input.outcome, errorCode: input.errorCode },
        createdAt: input.recordedAt,
      });
      await client.query("COMMIT");
      return fundingMethod;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async getVendorLifecycleStatus(vendorId: number): Promise<DropshipVendorStatus | null> {
    const result = await this.dbPool.query<{ status: DropshipVendorStatus }>(VENDOR_LIFECYCLE_STATUS_SQL, [vendorId]);
    return result.rows[0]?.status ?? null;
  }

  async getReusableFundingProviderCustomerId(input: {
    vendorId: number;
    provider: "stripe";
  }): Promise<string | null> {
    const rails = input.provider === "stripe"
      ? ["stripe_card", "stripe_ach"]
      : [];
    if (rails.length === 0) return null;

    const result = await this.dbPool.query<{ provider_customer_id: string | null }>(
      `SELECT provider_customer_id
       FROM dropship.dropship_funding_methods
       WHERE vendor_id = $1
         AND rail = ANY($2::text[])
         AND provider_customer_id IS NOT NULL
       ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END,
                updated_at DESC,
                id DESC
       LIMIT 1`,
      [input.vendorId, rails],
    );
    return result.rows[0]?.provider_customer_id ?? null;
  }

  async upsertFundingMethod(
    input: UpsertDropshipFundingMethodRepositoryInput,
  ): Promise<DropshipFundingMethodMutationResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const hasActiveFundingMethod = await vendorHasActiveFundingMethodWithClient(client, input.vendorId);
      const shouldBeDefault = input.isDefault || !hasActiveFundingMethod;

      if (shouldBeDefault) {
        await client.query(
          `UPDATE dropship.dropship_funding_methods
           SET is_default = false,
               updated_at = $2
           WHERE vendor_id = $1
             AND status = 'active'
             AND is_default = true`,
          [input.vendorId, input.updatedAt],
        );
      }
      if (input.rail === "usdc_base" && !input.usdcWalletAddress) {
        throw new DropshipError(
          "DROPSHIP_USDC_WALLET_ADDRESS_REQUIRED",
          "USDC Base funding methods require a wallet address.",
          { vendorId: input.vendorId },
        );
      }

      const result = input.rail === "usdc_base"
        ? await client.query<FundingMethodMutationRow>(
            `INSERT INTO dropship.dropship_funding_methods AS fm
              (vendor_id, rail, status, provider_customer_id, provider_payment_method_id,
               usdc_wallet_address, display_label, is_default, metadata, created_at, updated_at)
             VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6, $7::jsonb, $8, $8)
             ON CONFLICT (vendor_id, rail, usdc_wallet_address)
               WHERE usdc_wallet_address IS NOT NULL
             DO UPDATE
               SET status = EXCLUDED.status,
                   display_label = EXCLUDED.display_label,
                   is_default = fm.is_default OR EXCLUDED.is_default,
                   metadata = EXCLUDED.metadata,
                   updated_at = EXCLUDED.updated_at
             RETURNING id, vendor_id, rail, status, provider_customer_id,
                       provider_payment_method_id, usdc_wallet_address, display_label,
                       is_default, metadata, created_at, updated_at,
                       (xmax = 0) AS inserted`,
            [
              input.vendorId,
              input.rail,
              input.status,
              input.usdcWalletAddress,
              input.displayLabel,
              shouldBeDefault,
              JSON.stringify(input.metadata ?? {}),
              input.updatedAt,
            ],
          )
        : await client.query<FundingMethodMutationRow>(
            `INSERT INTO dropship.dropship_funding_methods AS fm
              (vendor_id, rail, status, provider_customer_id, provider_payment_method_id,
               usdc_wallet_address, display_label, is_default, metadata, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $10)
             ON CONFLICT (vendor_id, rail, provider_payment_method_id)
               WHERE provider_payment_method_id IS NOT NULL
             DO UPDATE
               SET status = EXCLUDED.status,
                   provider_customer_id = EXCLUDED.provider_customer_id,
                   usdc_wallet_address = EXCLUDED.usdc_wallet_address,
                   display_label = EXCLUDED.display_label,
                   is_default = fm.is_default OR EXCLUDED.is_default,
                   metadata = EXCLUDED.metadata,
                   updated_at = EXCLUDED.updated_at
             RETURNING id, vendor_id, rail, status, provider_customer_id,
                       provider_payment_method_id, usdc_wallet_address, display_label,
                       is_default, metadata, created_at, updated_at,
                       (xmax = 0) AS inserted`,
            [
              input.vendorId,
              input.rail,
              input.status,
              input.providerCustomerId,
              input.providerPaymentMethodId,
              input.usdcWalletAddress,
              input.displayLabel,
              shouldBeDefault,
              JSON.stringify(input.metadata ?? {}),
              input.updatedAt,
            ],
          );
      const row = requiredRow(result.rows[0], "Dropship funding method upsert did not return a row.");
      const fundingMethod = mapFundingMethodRow(row);
      await recordWalletAuditEvent(client, {
        vendorId: input.vendorId,
        entityType: "dropship_funding_methods",
        entityId: String(fundingMethod.fundingMethodId),
        eventType: row.inserted ? "funding_method_registered" : "funding_method_refreshed",
        payload: {
          fundingMethodId: fundingMethod.fundingMethodId,
          rail: fundingMethod.rail,
          status: fundingMethod.status,
          displayLabel: fundingMethod.displayLabel,
          isDefault: fundingMethod.isDefault,
        },
        createdAt: input.updatedAt,
      });
      await client.query("COMMIT");
      return {
        fundingMethod,
        idempotentReplay: !row.inserted,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async findLedgerReplayAfterUniqueConflict(
    input: {
      vendorId: number;
      idempotencyKey: string;
      referenceType: string;
      referenceId: string;
      type?: DropshipWalletLedgerRecord["type"];
      status?: DropshipWalletLedgerRecord["status"];
      amountCents: number;
      currency: string;
      fundingMethodId?: number | null;
      externalTransactionId?: string | null;
      metadata?: Record<string, unknown>;
      rail?: CreateDropshipWalletFundingLedgerInput["rail"];
      requestHash: string;
      occurredAt: Date;
    },
  ): Promise<DropshipWalletMutationResult | null> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const account = await getOrCreateWalletAccountWithClient(client, {
        vendorId: input.vendorId,
        currency: input.currency,
        now: input.occurredAt,
      });
      const ledgerEntry = await findReplayLedgerWithClient(client, input);
      if (!ledgerEntry) {
        await client.query("COMMIT");
        return null;
      }
      if ((input.type ?? "funding") === "funding" && ledgerEntry.status === "settled" && input.status === "pending") {
        assertLedgerReplayMatches(ledgerEntry, {
          type: "funding",
          amountCents: input.amountCents,
          currency: input.currency,
          status: "settled",
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          requestHash: input.requestHash,
        });
        await client.query("COMMIT");
        return {
          account,
          ledgerEntry,
          idempotentReplay: true,
        };
      }
      if ((input.type ?? "funding") === "funding" && ledgerEntry.status === "pending" && input.status === "settled") {
        assertLedgerReplayMatches(ledgerEntry, {
          type: "funding",
          amountCents: input.amountCents,
          currency: input.currency,
          status: "pending",
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          requestHash: input.requestHash,
        });
        const settled = await settlePendingFundingWithClient(client, {
          account,
          ledgerEntry,
          fundingMethodId: input.fundingMethodId ?? ledgerEntry.fundingMethodId,
          externalTransactionId: input.externalTransactionId ?? ledgerEntry.externalTransactionId,
          metadata: {
            ...(input.metadata ?? {}),
            ...(input.rail ? { rail: input.rail } : {}),
            requestHash: input.requestHash,
            settledFromPending: true,
          },
          settledAt: input.occurredAt,
        });
        await recordWalletAuditEvent(client, {
          vendorId: input.vendorId,
          entityType: "dropship_wallet_ledger",
          entityId: String(settled.ledgerEntry.ledgerEntryId),
          eventType: "wallet_funding_settled",
          payload: serializeLedgerForAudit(settled.ledgerEntry),
          createdAt: input.occurredAt,
        });
        await client.query("COMMIT");
        return settled;
      }
      assertLedgerReplayMatches(ledgerEntry, {
        type: input.type ?? "funding",
        amountCents: input.amountCents,
        currency: input.currency,
        status: input.status ?? ledgerEntry.status,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        requestHash: input.requestHash,
      });
      await client.query("COMMIT");
      return {
        account,
        ledgerEntry,
        idempotentReplay: true,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async findConfirmedUsdcFundingReplayAfterUniqueConflict(
    input: CreateDropshipConfirmedUsdcFundingRepositoryInput,
  ): Promise<DropshipConfirmedUsdcFundingResult | null> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const usdcLedgerEntry = await findUsdcLedgerByTransactionWithClient(client, {
        chainId: input.chainId,
        transactionHash: input.transactionHash,
        logIndex: input.logIndex,
      });
      if (usdcLedgerEntry) {
        const replay = await replayConfirmedUsdcFundingWithClient(client, input, usdcLedgerEntry);
        await client.query("COMMIT");
        return replay;
      }

      const ledgerEntry = await findReplayLedgerWithClient(client, {
        vendorId: input.vendorId,
        idempotencyKey: input.idempotencyKey,
        referenceType: "usdc_base_transaction",
        referenceId: usdcTransactionReferenceId(input),
      });
      if (!ledgerEntry) {
        await client.query("COMMIT");
        return null;
      }
      assertLedgerReplayMatches(ledgerEntry, {
        type: "funding",
        amountCents: input.amountCents,
        currency: input.currency,
        status: "settled",
        referenceType: "usdc_base_transaction",
        referenceId: usdcTransactionReferenceId(input),
        requestHash: input.requestHash,
      });
      const account = await getOrCreateWalletAccountWithClient(client, {
        vendorId: input.vendorId,
        currency: input.currency,
        now: input.occurredAt,
      });
      const insertedUsdcLedgerEntry = await insertUsdcLedgerEntryWithClient(client, {
        vendorId: input.vendorId,
        walletLedgerId: ledgerEntry.ledgerEntryId,
        chainId: input.chainId,
        transactionHash: input.transactionHash,
        fromAddress: input.fromAddress ?? null,
        toAddress: input.toAddress,
        logIndex: input.logIndex,
        amountAtomicUnits: input.amountAtomicUnits,
        confirmations: input.confirmations,
        status: "settled",
        observedAt: input.observedAt,
        settledAt: input.occurredAt,
      });
      await recordWalletAuditEvent(client, {
        vendorId: input.vendorId,
        entityType: "dropship_usdc_ledger_entries",
        entityId: String(insertedUsdcLedgerEntry.usdcLedgerEntryId),
        eventType: "wallet_usdc_funding_observed",
        payload: serializeUsdcLedgerForAudit(insertedUsdcLedgerEntry),
        createdAt: input.occurredAt,
      });
      await client.query("COMMIT");
      return {
        account,
        ledgerEntry,
        usdcLedgerEntry: insertedUsdcLedgerEntry,
        idempotentReplay: true,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function ensureDropshipWalletScaffoldingForVendor(
  client: PoolClient,
  input: {
    vendorId: number;
    now: Date;
  },
): Promise<void> {
  await getOrCreateWalletAccountWithClient(client, {
    vendorId: input.vendorId,
    currency: "USD",
    now: input.now,
  });
  await client.query(
    `INSERT INTO dropship.dropship_auto_reload_settings
      (vendor_id, enabled, minimum_balance_cents, payment_hold_timeout_minutes, created_at, updated_at)
     VALUES ($1, true, 5000, 2880, $2, $2)
     ON CONFLICT (vendor_id) DO NOTHING`,
    [input.vendorId, input.now],
  );
}

async function replayConfirmedUsdcFundingWithClient(
  client: PoolClient,
  input: CreateDropshipConfirmedUsdcFundingRepositoryInput,
  usdcLedgerEntry: DropshipUsdcLedgerEntryRecord,
): Promise<DropshipConfirmedUsdcFundingResult> {
  if (usdcLedgerEntry.vendorId !== input.vendorId) {
    throw new DropshipError(
      "DROPSHIP_USDC_TRANSACTION_CONFLICT",
      "USDC transaction hash is already recorded for a different dropship vendor.",
      {
        vendorId: input.vendorId,
        recordedVendorId: usdcLedgerEntry.vendorId,
        chainId: input.chainId,
        transactionHash: input.transactionHash,
      },
    );
  }
  if (!usdcLedgerEntry.walletLedgerId) {
    throw new DropshipError(
      "DROPSHIP_USDC_WALLET_LEDGER_MISSING",
      "USDC transaction is not linked to a wallet ledger entry.",
      {
        vendorId: input.vendorId,
        usdcLedgerEntryId: usdcLedgerEntry.usdcLedgerEntryId,
      },
    );
  }
  const ledgerEntry = await loadWalletLedgerByIdWithClient(client, {
    vendorId: input.vendorId,
    ledgerEntryId: usdcLedgerEntry.walletLedgerId,
  });
  assertLedgerReplayMatches(ledgerEntry, {
    type: "funding",
    amountCents: input.amountCents,
    currency: input.currency,
    status: "settled",
    referenceType: "usdc_base_transaction",
    referenceId: usdcTransactionReferenceId(input),
    requestHash: input.requestHash,
  });
  if (
    usdcLedgerEntry.amountAtomicUnits !== input.amountAtomicUnits
    || usdcLedgerEntry.fromAddress !== (input.fromAddress ?? null)
    || usdcLedgerEntry.toAddress !== input.toAddress
  ) {
    throw new DropshipError(
      "DROPSHIP_USDC_TRANSACTION_CONFLICT",
      "USDC transaction hash was reused with different transfer details.",
      {
        vendorId: input.vendorId,
        usdcLedgerEntryId: usdcLedgerEntry.usdcLedgerEntryId,
        chainId: input.chainId,
        transactionHash: input.transactionHash,
      },
    );
  }
  const account = await getOrCreateWalletAccountWithClient(client, {
    vendorId: input.vendorId,
    currency: input.currency,
    now: input.occurredAt,
  });
  return {
    account,
    ledgerEntry,
    usdcLedgerEntry,
    idempotentReplay: true,
  };
}

/**
 * Void a pending funding credit: the amount leaves the pending balance, the
 * ledger row is marked failed with the reason, and the audit row is written.
 * Shared by a returned bank transfer and a USDC deposit a reorg removed.
 */
async function voidPendingFundingWithClient(
  client: PoolClient,
  input: {
    vendorId: number;
    ledgerEntry: DropshipWalletLedgerRecord;
    failure: {
      code: string | null;
      message: string | null;
      providerStatus: string | null;
      providerEventId: string;
    };
    occurredAt: Date;
  },
): Promise<{ account: DropshipWalletAccountRecord; ledgerEntry: DropshipWalletLedgerRecord }> {
  const { ledgerEntry } = input;
  if (ledgerEntry.walletAccountId === null) {
    throw new DropshipError(
      "DROPSHIP_WALLET_LEDGER_ACCOUNT_MISSING",
      "Dropship wallet funding ledger entry is not attached to a wallet account.",
      { vendorId: input.vendorId, ledgerEntryId: ledgerEntry.ledgerEntryId, retryable: false },
    );
  }
  if (ledgerEntry.status !== "pending" || ledgerEntry.type !== "funding") {
    throw new DropshipError(
      "DROPSHIP_WALLET_SETTLEMENT_STATE_INVALID",
      "Only pending funding ledger entries can be voided.",
      { ledgerEntryId: ledgerEntry.ledgerEntryId, status: ledgerEntry.status },
    );
  }
  const account = await loadWalletAccountByIdWithClient(client, {
    vendorId: input.vendorId,
    walletAccountId: ledgerEntry.walletAccountId,
    forUpdate: true,
  });
  if (!account) {
    throw new DropshipError(
      "DROPSHIP_WALLET_ACCOUNT_NOT_FOUND",
      "Dropship wallet account was not found.",
      { vendorId: input.vendorId, walletAccountId: ledgerEntry.walletAccountId, retryable: false },
    );
  }
  const nextPending = account.pendingBalanceCents - ledgerEntry.amountCents;
  if (nextPending < 0) {
    // The pending balance no longer contains this credit. That is a
    // bookkeeping fault, not something to paper over with a clamp: fail
    // closed so the caller retries and a human sees the code.
    throw new DropshipError(
      "DROPSHIP_WALLET_PENDING_BALANCE_INCONSISTENT",
      "Dropship wallet pending balance is smaller than the pending credit being voided.",
      {
        vendorId: input.vendorId,
        walletAccountId: account.walletAccountId,
        ledgerEntryId: ledgerEntry.ledgerEntryId,
        pendingBalanceCents: account.pendingBalanceCents,
        amountCents: ledgerEntry.amountCents,
        retryable: false,
      },
    );
  }
  const updatedAccount = await updateWalletBalancesWithClient(client, {
    walletAccountId: account.walletAccountId,
    vendorId: input.vendorId,
    availableBalanceCents: account.availableBalanceCents,
    pendingBalanceCents: nextPending,
    updatedAt: input.occurredAt,
  });
  const failedEntry = await updateLedgerFailureWithClient(client, {
    ledgerEntryId: ledgerEntry.ledgerEntryId,
    vendorId: input.vendorId,
    availableBalanceAfterCents: account.availableBalanceCents,
    pendingBalanceAfterCents: nextPending,
    metadata: {
      ...ledgerEntry.metadata,
      failure: {
        code: input.failure.code,
        message: input.failure.message,
        providerStatus: input.failure.providerStatus,
        providerEventId: input.failure.providerEventId,
        failedAt: input.occurredAt.toISOString(),
      },
    },
  });
  await recordWalletAuditEvent(client, {
    vendorId: input.vendorId,
    entityType: "dropship_wallet_ledger",
    entityId: String(failedEntry.ledgerEntryId),
    eventType: "wallet_funding_failed",
    payload: serializeLedgerForAudit(failedEntry),
    createdAt: input.occurredAt,
  });
  return { account: updatedAccount, ledgerEntry: failedEntry };
}

/**
 * Rewards on a funding credit that just settled (funding design phase 7):
 * the amount credited times the rail's rate in force, read on this client so
 * the accrual is decided in the transaction that settles the credit. One
 * `rewards_earned` row per credit, referenced by the credit's ledger id, so a
 * replayed settlement finds the row and moves nothing. A zero rate or an
 * amount too small to earn a cent writes nothing: the ledger refuses a zero
 * amount, and the credit's own row already records the settlement.
 */
async function accrueRewardsForSettledCreditWithClient(
  client: PoolClient,
  input: {
    account: DropshipWalletAccountRecord;
    credit: DropshipWalletLedgerRecord;
    rail: DropshipRewardsRail;
    occurredAt: Date;
  },
): Promise<{ account: DropshipWalletAccountRecord; ledgerEntry: DropshipWalletLedgerRecord } | null> {
  const rates = await loadRewardsRatesInForceWithClient(client);
  const decision = decideRewardsAccrual({
    rail: input.rail,
    creditAmountCents: input.credit.amountCents,
    rates,
  });
  if (decision.rewardsCents === 0) {
    return null;
  }
  const referenceId = String(input.credit.ledgerEntryId);
  const existing = await findLedgerByReferenceWithClient(client, {
    referenceType: REWARDS_EARNED_REFERENCE_TYPE,
    referenceId,
    type: "rewards_earned",
    forUpdate: false,
  });
  if (existing) {
    return { account: input.account, ledgerEntry: existing };
  }
  const nextRewards = input.account.rewardsBalanceCents + decision.rewardsCents;
  const updatedAccount = await updateWalletBalancesWithClient(client, {
    walletAccountId: input.account.walletAccountId,
    vendorId: input.account.vendorId,
    availableBalanceCents: input.account.availableBalanceCents,
    pendingBalanceCents: input.account.pendingBalanceCents,
    rewardsBalanceCents: nextRewards,
    updatedAt: input.occurredAt,
  });
  const ledgerEntry = await insertLedgerEntryWithClient(client, {
    walletAccountId: input.account.walletAccountId,
    vendorId: input.account.vendorId,
    type: "rewards_earned",
    status: "settled",
    amountCents: decision.rewardsCents,
    currency: input.credit.currency,
    availableBalanceAfterCents: input.account.availableBalanceCents,
    pendingBalanceAfterCents: input.account.pendingBalanceCents,
    rewardsBalanceAfterCents: nextRewards,
    referenceType: REWARDS_EARNED_REFERENCE_TYPE,
    referenceId,
    idempotencyKey: `rewards-earned:${referenceId}`,
    fundingMethodId: input.credit.fundingMethodId,
    externalTransactionId: null,
    metadata: {
      fundingLedgerEntryId: input.credit.ledgerEntryId,
      creditAmountCents: input.credit.amountCents,
      rateBps: decision.rateBps,
      rail: input.rail,
    },
    createdAt: input.occurredAt,
    settledAt: input.occurredAt,
  });
  await recordWalletAuditEvent(client, {
    vendorId: input.account.vendorId,
    entityType: "dropship_wallet_ledger",
    entityId: String(ledgerEntry.ledgerEntryId),
    eventType: "wallet_rewards_earned",
    payload: {
      ...serializeLedgerForAudit(ledgerEntry),
      before: { rewardsBalanceCents: input.account.rewardsBalanceCents },
      after: { rewardsBalanceCents: nextRewards },
    },
    createdAt: input.occurredAt,
  });
  return { account: updatedAccount, ledgerEntry };
}

async function settlePendingFundingWithClient(
  client: PoolClient,
  input: {
    account: DropshipWalletAccountRecord;
    ledgerEntry: DropshipWalletLedgerRecord;
    fundingMethodId: number | null;
    externalTransactionId: string | null;
    metadata: Record<string, unknown>;
    settledAt: Date;
  },
): Promise<DropshipWalletMutationResult> {
  if (input.ledgerEntry.status !== "pending" || input.ledgerEntry.type !== "funding") {
    throw new DropshipError(
      "DROPSHIP_WALLET_SETTLEMENT_STATE_INVALID",
      "Only pending funding ledger entries can be settled.",
      { ledgerEntryId: input.ledgerEntry.ledgerEntryId, status: input.ledgerEntry.status },
    );
  }
  if (input.account.pendingBalanceCents < input.ledgerEntry.amountCents) {
    throw new DropshipError(
      "DROPSHIP_WALLET_PENDING_BALANCE_INVARIANT_FAILED",
      "Dropship wallet pending balance is lower than the settlement amount.",
      {
        walletAccountId: input.account.walletAccountId,
        ledgerEntryId: input.ledgerEntry.ledgerEntryId,
        pendingBalanceCents: input.account.pendingBalanceCents,
        amountCents: input.ledgerEntry.amountCents,
      },
    );
  }

  const nextAvailable = input.account.availableBalanceCents + input.ledgerEntry.amountCents;
  const nextPending = input.account.pendingBalanceCents - input.ledgerEntry.amountCents;
  const updatedAccount = await updateWalletBalancesWithClient(client, {
    walletAccountId: input.account.walletAccountId,
    vendorId: input.account.vendorId,
    availableBalanceCents: nextAvailable,
    pendingBalanceCents: nextPending,
    updatedAt: input.settledAt,
  });
  const updatedLedger = await updateLedgerSettlementWithClient(client, {
    ledgerEntryId: input.ledgerEntry.ledgerEntryId,
    vendorId: input.ledgerEntry.vendorId,
    availableBalanceAfterCents: nextAvailable,
    pendingBalanceAfterCents: nextPending,
    fundingMethodId: input.fundingMethodId ?? input.ledgerEntry.fundingMethodId,
    externalTransactionId: input.externalTransactionId ?? input.ledgerEntry.externalTransactionId,
    metadata: {
      ...input.ledgerEntry.metadata,
      ...input.metadata,
    },
    settledAt: input.settledAt,
  });
  return {
    account: updatedAccount,
    ledgerEntry: updatedLedger,
    idempotentReplay: false,
  };
}

async function updateLedgerSettlementWithClient(
  client: PoolClient,
  input: {
    ledgerEntryId: number;
    vendorId: number;
    availableBalanceAfterCents: number;
    pendingBalanceAfterCents: number;
    fundingMethodId: number | null;
    externalTransactionId: string | null;
    metadata: Record<string, unknown>;
    settledAt: Date;
  },
): Promise<DropshipWalletLedgerRecord> {
  const result = await client.query<WalletLedgerRow>(
    `UPDATE dropship.dropship_wallet_ledger
     SET status = 'settled',
         available_balance_after_cents = $3,
         pending_balance_after_cents = $4,
         funding_method_id = $5,
         external_transaction_id = $6,
         metadata = $7::jsonb,
         settled_at = $8
     WHERE id = $1
       AND vendor_id = $2
       AND type = 'funding'
       AND status = 'pending'
     RETURNING id, wallet_account_id, vendor_id, type, status, amount_cents, currency,
               available_balance_after_cents, pending_balance_after_cents, rewards_balance_after_cents,
               reference_type, reference_id, idempotency_key, funding_method_id,
               external_transaction_id, metadata, created_at, settled_at`,
    [
      input.ledgerEntryId,
      input.vendorId,
      input.availableBalanceAfterCents,
      input.pendingBalanceAfterCents,
      input.fundingMethodId,
      input.externalTransactionId,
      JSON.stringify(input.metadata),
      input.settledAt,
    ],
  );
  return mapLedgerRow(requiredRow(result.rows[0], "Dropship wallet pending funding settlement did not return a row."));
}

/** Reference types of the two rows a dispute can add to the ledger (funding design phase 4). */
const DISPUTE_REVERSAL_REFERENCE_TYPE = "stripe_dispute";
const DISPUTE_REINSTATEMENT_REFERENCE_TYPE = "stripe_dispute_reinstated";
/**
 * Reference types of the rewards rows (funding design phase 7). Each names a
 * distinct row for one funding credit or one dispute, under the ledger's
 * unique (reference_type, reference_id) index.
 */
const REWARDS_EARNED_REFERENCE_TYPE = "wallet_funding_rewards";
const DISPUTE_REWARDS_REVERSAL_REFERENCE_TYPE = "stripe_dispute_rewards";
const DISPUTE_REWARDS_REINSTATEMENT_REFERENCE_TYPE = "stripe_dispute_rewards_reinstated";

/**
 * A ledger row by its provider reference, across vendors: a dispute names
 * the provider's payment, and the credit for it is what says whose wallet it
 * is. The reference index is unique, so at most one row matches.
 */
async function findLedgerByReferenceWithClient(
  client: PoolClient,
  input: {
    referenceType: string;
    referenceId: string;
    type: DropshipWalletLedgerRecord["type"];
    forUpdate: boolean;
  },
): Promise<DropshipWalletLedgerRecord | null> {
  const result = await client.query<WalletLedgerRow>(
    `SELECT id, wallet_account_id, vendor_id, type, status, amount_cents, currency,
            available_balance_after_cents, pending_balance_after_cents, rewards_balance_after_cents,
            reference_type, reference_id, idempotency_key, funding_method_id,
            external_transaction_id, metadata, created_at, settled_at
     FROM dropship.dropship_wallet_ledger
     WHERE reference_type = $1
       AND reference_id = $2
       AND type = $3
     ORDER BY id ASC
     LIMIT 1${input.forUpdate ? "\n     FOR UPDATE" : ""}`,
    [input.referenceType, input.referenceId, input.type],
  );
  return result.rows[0] ? mapLedgerRow(result.rows[0]) : null;
}

/** The funding entry a provider payment reference points at, locked for the transaction. */
async function findFundingLedgerByReferenceWithClient(
  client: PoolClient,
  input: {
    vendorId: number;
    referenceType: string;
    referenceId: string;
  },
): Promise<DropshipWalletLedgerRecord | null> {
  const result = await client.query<WalletLedgerRow>(
    `SELECT id, wallet_account_id, vendor_id, type, status, amount_cents, currency,
            available_balance_after_cents, pending_balance_after_cents, rewards_balance_after_cents,
            reference_type, reference_id, idempotency_key, funding_method_id,
            external_transaction_id, metadata, created_at, settled_at
     FROM dropship.dropship_wallet_ledger
     WHERE vendor_id = $1
       AND type = 'funding'
       AND reference_type = $2
       AND reference_id = $3
     ORDER BY id ASC
     LIMIT 1
     FOR UPDATE`,
    [input.vendorId, input.referenceType, input.referenceId],
  );
  return result.rows[0] ? mapLedgerRow(result.rows[0]) : null;
}

async function updateLedgerFailureWithClient(
  client: PoolClient,
  input: {
    ledgerEntryId: number;
    vendorId: number;
    availableBalanceAfterCents: number;
    pendingBalanceAfterCents: number;
    metadata: Record<string, unknown>;
  },
): Promise<DropshipWalletLedgerRecord> {
  const result = await client.query<WalletLedgerRow>(
    `UPDATE dropship.dropship_wallet_ledger
     SET status = 'failed',
         available_balance_after_cents = $3,
         pending_balance_after_cents = $4,
         metadata = $5::jsonb
     WHERE id = $1
       AND vendor_id = $2
       AND type = 'funding'
       AND status = 'pending'
     RETURNING id, wallet_account_id, vendor_id, type, status, amount_cents, currency,
               available_balance_after_cents, pending_balance_after_cents, rewards_balance_after_cents,
               reference_type, reference_id, idempotency_key, funding_method_id,
               external_transaction_id, metadata, created_at, settled_at`,
    [
      input.ledgerEntryId,
      input.vendorId,
      input.availableBalanceAfterCents,
      input.pendingBalanceAfterCents,
      JSON.stringify(input.metadata),
    ],
  );
  return mapLedgerRow(requiredRow(result.rows[0], "Dropship wallet pending funding failure did not return a row."));
}

async function loadWalletAccountForMutation(
  client: PoolClient,
  input: {
    vendorId: number;
    walletAccountId: number | null;
    currency: string;
    occurredAt: Date;
  },
): Promise<DropshipWalletAccountRecord> {
  const account = input.walletAccountId
    ? await loadWalletAccountByIdWithClient(client, {
        vendorId: input.vendorId,
        walletAccountId: input.walletAccountId,
        forUpdate: true,
      })
    : await getOrCreateWalletAccountWithClient(client, {
        vendorId: input.vendorId,
        currency: input.currency,
        now: input.occurredAt,
      });
  if (!account) {
    throw new DropshipError(
      "DROPSHIP_WALLET_ACCOUNT_NOT_FOUND",
      "Dropship wallet account was not found.",
      { vendorId: input.vendorId, walletAccountId: input.walletAccountId, retryable: false },
    );
  }
  if (account.status !== "active") {
    throw new DropshipError(
      "DROPSHIP_WALLET_ACCOUNT_NOT_ACTIVE",
      "Dropship wallet account is not active.",
      { vendorId: input.vendorId, walletAccountId: account.walletAccountId, status: account.status },
    );
  }
  if (account.currency !== input.currency) {
    throw new DropshipError(
      "DROPSHIP_WALLET_CURRENCY_MISMATCH",
      "Dropship wallet currency does not match the requested transaction currency.",
      {
        vendorId: input.vendorId,
        walletAccountId: account.walletAccountId,
        walletCurrency: account.currency,
        transactionCurrency: input.currency,
      },
    );
  }
  return account;
}

async function getOrCreateWalletAccountWithClient(
  client: PoolClient,
  input: {
    vendorId: number;
    currency: string;
    now: Date;
  },
): Promise<DropshipWalletAccountRecord> {
  await client.query(
    `INSERT INTO dropship.dropship_wallet_accounts
      (vendor_id, available_balance_cents, pending_balance_cents, currency, status, created_at, updated_at)
     VALUES ($1, 0, 0, $2, 'active', $3, $3)
     ON CONFLICT (vendor_id) DO NOTHING`,
    [input.vendorId, input.currency, input.now],
  );
  const result = await client.query<WalletAccountRow>(
    `SELECT id, vendor_id, available_balance_cents, pending_balance_cents, rewards_balance_cents,
            currency, status, created_at, updated_at
     FROM dropship.dropship_wallet_accounts
     WHERE vendor_id = $1
     LIMIT 1
     FOR UPDATE`,
    [input.vendorId],
  );
  return mapWalletAccountRow(requiredRow(
    result.rows[0],
    "Dropship wallet account create/load did not return a row.",
  ));
}

async function loadWalletAccountByIdWithClient(
  client: PoolClient,
  input: {
    vendorId: number;
    walletAccountId: number;
    forUpdate?: boolean;
  },
): Promise<DropshipWalletAccountRecord | null> {
  const result = await client.query<WalletAccountRow>(
    `SELECT id, vendor_id, available_balance_cents, pending_balance_cents, rewards_balance_cents,
            currency, status, created_at, updated_at
     FROM dropship.dropship_wallet_accounts
     WHERE id = $1
       AND vendor_id = $2
     LIMIT 1
     ${input.forUpdate ? "FOR UPDATE" : ""}`,
    [input.walletAccountId, input.vendorId],
  );
  return result.rows[0] ? mapWalletAccountRow(result.rows[0]) : null;
}

async function updateWalletBalancesWithClient(
  client: PoolClient,
  input: {
    walletAccountId: number;
    vendorId: number;
    availableBalanceCents: number;
    pendingBalanceCents: number;
    /** The rewards balance to store; left as it is when absent (most cash moves never touch it). */
    rewardsBalanceCents?: number;
    updatedAt: Date;
  },
): Promise<DropshipWalletAccountRecord> {
  const result = await client.query<WalletAccountRow>(
    `UPDATE dropship.dropship_wallet_accounts
     SET available_balance_cents = $3,
         pending_balance_cents = $4,
         updated_at = $5,
         rewards_balance_cents = COALESCE($6, rewards_balance_cents)
     WHERE id = $1
       AND vendor_id = $2
     RETURNING id, vendor_id, available_balance_cents, pending_balance_cents, rewards_balance_cents,
               currency, status, created_at, updated_at`,
    [
      input.walletAccountId,
      input.vendorId,
      input.availableBalanceCents,
      input.pendingBalanceCents,
      input.updatedAt,
      input.rewardsBalanceCents ?? null,
    ],
  );
  return mapWalletAccountRow(requiredRow(
    result.rows[0],
    "Dropship wallet balance update did not return a row.",
  ));
}

const VENDOR_LIFECYCLE_STATUS_SQL = `SELECT status FROM dropship.dropship_vendors WHERE id = $1`;

async function getVendorLifecycleStatusWithClient(
  client: PoolClient,
  vendorId: number,
): Promise<DropshipVendorStatus | null> {
  const result = await client.query<{ status: DropshipVendorStatus }>(VENDOR_LIFECYCLE_STATUS_SQL, [vendorId]);
  return result.rows[0]?.status ?? null;
}

/** The vendor's funding method, locked for the rest of the transaction; absent is a not-found error. */
async function selectFundingMethodForUpdateWithClient(
  client: PoolClient,
  input: {
    vendorId: number;
    fundingMethodId: number;
  },
): Promise<FundingMethodRow> {
  const result = await client.query<FundingMethodRow>(
    `SELECT id, vendor_id, rail, status, provider_customer_id,
            provider_payment_method_id, usdc_wallet_address, display_label,
            is_default, metadata, created_at, updated_at
     FROM dropship.dropship_funding_methods
     WHERE id = $1
       AND vendor_id = $2
     LIMIT 1
     FOR UPDATE`,
    [input.fundingMethodId, input.vendorId],
  );
  const method = result.rows[0];
  if (!method) {
    throw new DropshipError(
      "DROPSHIP_FUNDING_METHOD_NOT_FOUND",
      "Dropship funding method was not found.",
      { vendorId: input.vendorId, fundingMethodId: input.fundingMethodId },
    );
  }
  return method;
}

/** Ledger entries still pending on the method: a bank debit that has neither landed nor failed. */
async function countPendingFundingOnMethodWithClient(
  client: PoolClient,
  input: { vendorId: number; fundingMethodId: number },
): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM dropship.dropship_wallet_ledger
     WHERE vendor_id = $1
       AND funding_method_id = $2
       AND status = 'pending'`,
    [input.vendorId, input.fundingMethodId],
  );
  return result.rows[0]?.count ?? 0;
}

/** Other cards of the vendor a held order could be charged to (the wallet service's `isChargeableCard`). */
async function countOtherChargeableCardsWithClient(
  client: PoolClient,
  input: { vendorId: number; fundingMethodId: number },
): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM dropship.dropship_funding_methods
     WHERE vendor_id = $1
       AND id <> $2
       AND rail = 'stripe_card'
       AND status = 'active'
       AND provider_customer_id IS NOT NULL
       AND provider_payment_method_id IS NOT NULL`,
    [input.vendorId, input.fundingMethodId],
  );
  return result.rows[0]?.count ?? 0;
}

async function assertFundingMethodCanBeUsed(
  client: PoolClient,
  input: {
    vendorId: number;
    fundingMethodId: number | null;
  },
): Promise<FundingMethodRow | null> {
  if (!input.fundingMethodId) return null;
  const method = await selectFundingMethodForUpdateWithClient(client, {
    vendorId: input.vendorId,
    fundingMethodId: input.fundingMethodId,
  });
  if (method.status !== "active") {
    throw new DropshipError(
      "DROPSHIP_FUNDING_METHOD_NOT_ACTIVE",
      "Dropship funding method is not active.",
      { vendorId: input.vendorId, fundingMethodId: input.fundingMethodId, status: method.status },
    );
  }
  return method;
}

async function findReplayLedgerWithClient(
  client: PoolClient,
  input: {
    vendorId: number;
    idempotencyKey: string;
    referenceType: string;
    referenceId: string;
  },
): Promise<DropshipWalletLedgerRecord | null> {
  const result = await client.query<WalletLedgerRow>(
    `SELECT id, wallet_account_id, vendor_id, type, status, amount_cents, currency,
            available_balance_after_cents, pending_balance_after_cents, rewards_balance_after_cents,
            reference_type, reference_id, idempotency_key, funding_method_id,
            external_transaction_id, metadata, created_at, settled_at
     FROM dropship.dropship_wallet_ledger
     WHERE vendor_id = $1
       AND (
         idempotency_key = $2
         OR (reference_type = $3 AND reference_id = $4)
       )
     ORDER BY CASE WHEN idempotency_key = $2 THEN 0 ELSE 1 END, id ASC
     LIMIT 1
     FOR UPDATE`,
    [input.vendorId, input.idempotencyKey, input.referenceType, input.referenceId],
  );
  return result.rows[0] ? mapLedgerRow(result.rows[0]) : null;
}

async function insertLedgerEntryWithClient(
  client: PoolClient,
  input: {
    walletAccountId: number;
    vendorId: number;
    type: DropshipWalletLedgerRecord["type"];
    status: DropshipWalletLedgerRecord["status"];
    amountCents: number;
    currency: string;
    availableBalanceAfterCents: number;
    pendingBalanceAfterCents: number;
    referenceType: string;
    referenceId: string;
    idempotencyKey: string;
    fundingMethodId: number | null;
    externalTransactionId: string | null;
    metadata: Record<string, unknown>;
    createdAt: Date;
    settledAt: Date | null;
    /** The rewards balance after this line (migration 0702); every writer here states it. */
    rewardsBalanceAfterCents: number;
  },
): Promise<DropshipWalletLedgerRecord> {
  const result = await client.query<WalletLedgerRow>(
    `INSERT INTO dropship.dropship_wallet_ledger
      (wallet_account_id, vendor_id, type, status, amount_cents, currency,
       available_balance_after_cents, pending_balance_after_cents, rewards_balance_after_cents,
       reference_type, reference_id, idempotency_key, funding_method_id,
       external_transaction_id, metadata, created_at, settled_at,
       rewards_balance_after_cents)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17)
     RETURNING id, wallet_account_id, vendor_id, type, status, amount_cents, currency,
               available_balance_after_cents, pending_balance_after_cents, rewards_balance_after_cents,
               reference_type, reference_id, idempotency_key, funding_method_id,
               external_transaction_id, metadata, created_at, settled_at`,
    [
      input.walletAccountId,
      input.vendorId,
      input.type,
      input.status,
      input.amountCents,
      input.currency,
      input.availableBalanceAfterCents,
      input.pendingBalanceAfterCents,
      input.referenceType,
      input.referenceId,
      input.idempotencyKey,
      input.fundingMethodId,
      input.externalTransactionId,
      JSON.stringify(input.metadata),
      input.createdAt,
      input.settledAt,
      input.rewardsBalanceAfterCents,
    ],
  );
  return mapLedgerRow(requiredRow(
    result.rows[0],
    "Dropship wallet ledger insert did not return a row.",
  ));
}

async function loadWalletLedgerByIdWithClient(
  client: PoolClient,
  input: {
    vendorId: number;
    ledgerEntryId: number;
  },
): Promise<DropshipWalletLedgerRecord> {
  const result = await client.query<WalletLedgerRow>(
    `SELECT id, wallet_account_id, vendor_id, type, status, amount_cents, currency,
            available_balance_after_cents, pending_balance_after_cents, rewards_balance_after_cents,
            reference_type, reference_id, idempotency_key, funding_method_id,
            external_transaction_id, metadata, created_at, settled_at
     FROM dropship.dropship_wallet_ledger
     WHERE id = $1
       AND vendor_id = $2
     LIMIT 1
     FOR UPDATE`,
    [input.ledgerEntryId, input.vendorId],
  );
  return mapLedgerRow(requiredRow(result.rows[0], "Dropship wallet ledger replay did not return a row."));
}

/**
 * One observation per (chain, transaction, log). A manual staff credit has
 * no log index and is keyed as -1, the same rule as the unique index.
 */
async function findUsdcLedgerByTransactionWithClient(
  client: PoolClient,
  input: {
    chainId: number;
    transactionHash: string;
    logIndex: number | null;
  },
): Promise<DropshipUsdcLedgerEntryRecord | null> {
  const result = await client.query<UsdcLedgerRow>(
    `SELECT ${USDC_LEDGER_COLUMNS}
     FROM dropship.dropship_usdc_ledger_entries
     WHERE chain_id = $1
       AND transaction_hash = $2
       AND COALESCE(log_index, -1) = $3
     LIMIT 1
     FOR UPDATE`,
    [input.chainId, input.transactionHash, input.logIndex ?? -1],
  );
  return result.rows[0] ? mapUsdcLedgerRow(result.rows[0]) : null;
}

async function loadUsdcLedgerByIdWithClient(
  client: PoolClient,
  input: { usdcLedgerEntryId: number; vendorId: number; forUpdate: boolean },
): Promise<DropshipUsdcLedgerEntryRecord | null> {
  const result = await client.query<UsdcLedgerRow>(
    `SELECT ${USDC_LEDGER_COLUMNS}
     FROM dropship.dropship_usdc_ledger_entries
     WHERE id = $1
       AND vendor_id = $2
     LIMIT 1${input.forUpdate ? "\n     FOR UPDATE" : ""}`,
    [input.usdcLedgerEntryId, input.vendorId],
  );
  return result.rows[0] ? mapUsdcLedgerRow(result.rows[0]) : null;
}

async function updateUsdcLedgerChainStateWithClient(
  client: PoolClient,
  input: {
    usdcLedgerEntryId: number;
    vendorId: number;
    status: "pending" | "settled" | "voided";
    confirmations: number;
    blockNumber: number;
    blockHash: string;
    settledAt: Date | null;
    voidedAt: Date | null;
  },
): Promise<DropshipUsdcLedgerEntryRecord> {
  const result = await client.query<UsdcLedgerRow>(
    `UPDATE dropship.dropship_usdc_ledger_entries
     SET status = $3,
         confirmations = $4,
         block_number = $5,
         block_hash = $6,
         settled_at = $7,
         voided_at = $8
     WHERE id = $1
       AND vendor_id = $2
     RETURNING ${USDC_LEDGER_COLUMNS}`,
    [
      input.usdcLedgerEntryId,
      input.vendorId,
      input.status,
      input.confirmations,
      input.blockNumber,
      input.blockHash,
      input.settledAt,
      input.voidedAt,
    ],
  );
  return mapUsdcLedgerRow(requiredRow(result.rows[0], "Dropship USDC ledger update did not return a row."));
}

async function insertUsdcLedgerEntryWithClient(
  client: PoolClient,
  input: {
    vendorId: number;
    walletLedgerId: number | null;
    chainId: number;
    transactionHash: string;
    fromAddress: string | null;
    toAddress: string;
    amountAtomicUnits: string;
    confirmations: number;
    status: string;
    observedAt: Date;
    settledAt: Date | null;
    /** Chain facts the watcher records; a manual staff credit leaves them null. */
    logIndex?: number | null;
    blockNumber?: number | null;
    blockHash?: string | null;
    tokenAddress?: string | null;
    depositAddressId?: number | null;
    dustAtomicUnits?: string;
  },
): Promise<DropshipUsdcLedgerEntryRecord> {
  const result = await client.query<UsdcLedgerRow>(
    `INSERT INTO dropship.dropship_usdc_ledger_entries
      (vendor_id, wallet_ledger_id, chain_id, transaction_hash, from_address,
       to_address, amount_atomic_units, confirmations, status, observed_at, settled_at,
       log_index, block_number, block_hash, token_address, deposit_address_id, dust_atomic_units)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING ${USDC_LEDGER_COLUMNS}`,
    [
      input.vendorId,
      input.walletLedgerId,
      input.chainId,
      input.transactionHash,
      input.fromAddress,
      input.toAddress,
      input.amountAtomicUnits,
      input.confirmations,
      input.status,
      input.observedAt,
      input.settledAt,
      input.logIndex ?? null,
      input.blockNumber ?? null,
      input.blockHash ?? null,
      input.tokenAddress ?? null,
      input.depositAddressId ?? null,
      input.dustAtomicUnits ?? "0",
    ],
  );
  return mapUsdcLedgerRow(requiredRow(result.rows[0], "Dropship USDC ledger insert did not return a row."));
}

async function listFundingMethodsWithClient(
  client: PoolClient,
  vendorId: number,
): Promise<DropshipFundingMethodRecord[]> {
  const result = await client.query<FundingMethodRow>(
    `SELECT id, vendor_id, rail, status, provider_customer_id,
            provider_payment_method_id, usdc_wallet_address, display_label,
            is_default, metadata, created_at, updated_at
     FROM dropship.dropship_funding_methods
     WHERE vendor_id = $1
     ORDER BY is_default DESC, created_at DESC, id DESC`,
    [vendorId],
  );
  return result.rows.map(mapFundingMethodRow);
}

async function getAutoReloadSettingWithClient(
  client: PoolClient,
  vendorId: number,
): Promise<DropshipAutoReloadSettingRecord | null> {
  const result = await client.query<AutoReloadRow>(
    `SELECT id, vendor_id, funding_method_id, enabled, minimum_balance_cents,
            max_single_reload_cents, top_up_amount_cents, payment_hold_timeout_minutes,
            acknowledged_card_fee_bps, acknowledged_at, spend_rewards_first, created_at, updated_at
     FROM dropship.dropship_auto_reload_settings
     WHERE vendor_id = $1
     LIMIT 1`,
    [vendorId],
  );
  return result.rows[0] ? mapAutoReloadRow(result.rows[0]) : null;
}

async function vendorHasActiveFundingMethodWithClient(
  client: PoolClient,
  vendorId: number,
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM dropship.dropship_funding_methods
       WHERE vendor_id = $1
         AND status = 'active'
       LIMIT 1
     ) AS exists`,
    [vendorId],
  );
  return result.rows[0]?.exists === true;
}

async function listLedgerWithClient(
  client: PoolClient,
  vendorId: number,
  limit: number,
): Promise<DropshipWalletLedgerRecord[]> {
  const result = await client.query<WalletLedgerRow>(
    `SELECT id, wallet_account_id, vendor_id, type, status, amount_cents, currency,
            available_balance_after_cents, pending_balance_after_cents, rewards_balance_after_cents,
            reference_type, reference_id, idempotency_key, funding_method_id,
            external_transaction_id, metadata, created_at, settled_at
     FROM dropship.dropship_wallet_ledger
     WHERE vendor_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [vendorId, limit],
  );
  return result.rows.map(mapLedgerRow);
}

async function recordWalletAuditEvent(
  client: PoolClient,
  input: {
    vendorId: number;
    entityType: string;
    entityId: string;
    eventType: string;
    payload: Record<string, unknown>;
    createdAt: Date;
    /** Who acted; the system when absent (a webhook, a worker, a reconciler). */
    actor?: { type: string; id: string | null };
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, $3, $4,
             $7, $8, 'info', $5::jsonb, $6)`,
    [
      input.vendorId,
      input.entityType,
      input.entityId,
      input.eventType,
      JSON.stringify(input.payload),
      input.createdAt,
      input.actor?.type ?? "system",
      input.actor?.id ?? null,
    ],
  );
}

/**
 * Ledger metadata for a funding credit. The card fee breakdown rides along
 * when present: the entry's amount is the net wallet credit, and the charge
 * the vendor's card actually saw is reconstructable from the entry alone.
 */
function fundingLedgerMetadata(input: CreateDropshipWalletFundingLedgerInput): Record<string, unknown> {
  return {
    ...(input.metadata ?? {}),
    rail: input.rail,
    requestHash: input.requestHash,
    ...(input.cardFee
      ? {
        cardFeeCents: input.cardFee.feeCents,
        cardFeeBps: input.cardFee.feeBps,
        chargedCents: input.cardFee.chargedCents,
      }
      : {}),
  };
}

function assertLedgerReplayMatches(
  ledgerEntry: DropshipWalletLedgerRecord,
  expected: {
    type: DropshipWalletLedgerRecord["type"];
    amountCents: number;
    currency: string;
    status: DropshipWalletLedgerRecord["status"];
    referenceType: string;
    referenceId: string;
    requestHash: string;
  },
): void {
  const requestHash = typeof ledgerEntry.metadata.requestHash === "string"
    ? ledgerEntry.metadata.requestHash
    : null;
  const matches = ledgerEntry.type === expected.type
    && ledgerEntry.amountCents === expected.amountCents
    && ledgerEntry.currency === expected.currency
    && ledgerEntry.status === expected.status
    && ledgerEntry.referenceType === expected.referenceType
    && ledgerEntry.referenceId === expected.referenceId
    && requestHash === expected.requestHash;
  if (!matches) {
    throw new DropshipError(
      "DROPSHIP_WALLET_IDEMPOTENCY_CONFLICT",
      "Dropship wallet ledger idempotency key or reference was reused with a different transaction.",
      {
        ledgerEntryId: ledgerEntry.ledgerEntryId,
        expectedType: expected.type,
        actualType: ledgerEntry.type,
      },
    );
  }
}

function serializeLedgerForAudit(ledgerEntry: DropshipWalletLedgerRecord): Record<string, unknown> {
  return {
    ledgerEntryId: ledgerEntry.ledgerEntryId,
    walletAccountId: ledgerEntry.walletAccountId,
    vendorId: ledgerEntry.vendorId,
    type: ledgerEntry.type,
    status: ledgerEntry.status,
    amountCents: ledgerEntry.amountCents,
    currency: ledgerEntry.currency,
    availableBalanceAfterCents: ledgerEntry.availableBalanceAfterCents,
    pendingBalanceAfterCents: ledgerEntry.pendingBalanceAfterCents,
    rewardsBalanceAfterCents: ledgerEntry.rewardsBalanceAfterCents,
    referenceType: ledgerEntry.referenceType,
    referenceId: ledgerEntry.referenceId,
    idempotencyKey: ledgerEntry.idempotencyKey,
  };
}

function serializeUsdcLedgerForAudit(usdcLedgerEntry: DropshipUsdcLedgerEntryRecord): Record<string, unknown> {
  return {
    usdcLedgerEntryId: usdcLedgerEntry.usdcLedgerEntryId,
    vendorId: usdcLedgerEntry.vendorId,
    walletLedgerId: usdcLedgerEntry.walletLedgerId,
    chainId: usdcLedgerEntry.chainId,
    transactionHash: usdcLedgerEntry.transactionHash,
    fromAddress: usdcLedgerEntry.fromAddress,
    toAddress: usdcLedgerEntry.toAddress,
    amountAtomicUnits: usdcLedgerEntry.amountAtomicUnits,
    confirmations: usdcLedgerEntry.confirmations,
    status: usdcLedgerEntry.status,
    logIndex: usdcLedgerEntry.logIndex,
    blockNumber: usdcLedgerEntry.blockNumber,
    blockHash: usdcLedgerEntry.blockHash,
    tokenAddress: usdcLedgerEntry.tokenAddress,
    depositAddressId: usdcLedgerEntry.depositAddressId,
    dustAtomicUnits: usdcLedgerEntry.dustAtomicUnits,
    voidedAt: usdcLedgerEntry.voidedAt ? usdcLedgerEntry.voidedAt.toISOString() : null,
  };
}

function mapWalletAccountRow(row: WalletAccountRow): DropshipWalletAccountRecord {
  return {
    walletAccountId: row.id,
    vendorId: row.vendor_id,
    availableBalanceCents: toSafeInteger(row.available_balance_cents, "available_balance_cents"),
    pendingBalanceCents: toSafeInteger(row.pending_balance_cents, "pending_balance_cents"),
    rewardsBalanceCents: toSafeInteger(row.rewards_balance_cents, "rewards_balance_cents"),
    currency: row.currency,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFundingMethodRow(row: FundingMethodRow): DropshipFundingMethodRecord {
  return {
    fundingMethodId: row.id,
    vendorId: row.vendor_id,
    rail: row.rail,
    status: row.status,
    providerCustomerId: row.provider_customer_id,
    providerPaymentMethodId: row.provider_payment_method_id,
    usdcWalletAddress: row.usdc_wallet_address,
    displayLabel: row.display_label,
    isDefault: row.is_default,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBalanceVerificationRow(row: BalanceVerificationRow): DropshipBankBalanceVerificationRecord {
  if (row.status !== "succeeded" && row.status !== "pending" && row.status !== "failed") {
    throw new DropshipError(
      "DROPSHIP_BANK_BALANCE_VERIFICATION_INVALID_STORED_VALUE",
      "Dropship bank balance verification has an unknown status.",
      { verificationId: row.id, status: row.status, classification: "fatal" },
    );
  }
  if (row.source !== "link" && row.source !== "refresh" && row.source !== "webhook") {
    throw new DropshipError(
      "DROPSHIP_BANK_BALANCE_VERIFICATION_INVALID_STORED_VALUE",
      "Dropship bank balance verification has an unknown source.",
      { verificationId: row.id, source: row.source, classification: "fatal" },
    );
  }
  return {
    verificationId: row.id,
    vendorId: row.vendor_id,
    fundingMethodId: row.funding_method_id,
    provider: row.provider,
    providerAccountId: row.provider_account_id,
    status: row.status,
    source: row.source,
    availableCents: row.available_cents === null ? null : toSafeInteger(row.available_cents, "available_cents"),
    currency: row.currency,
    balanceAsOf: row.balance_as_of,
    providerEventId: row.provider_event_id,
    createdAt: row.created_at,
  };
}

function mapAutoReloadRow(row: AutoReloadRow): DropshipAutoReloadSettingRecord {
  return {
    autoReloadSettingId: row.id,
    vendorId: row.vendor_id,
    fundingMethodId: row.funding_method_id,
    enabled: row.enabled,
    minimumBalanceCents: toSafeInteger(row.minimum_balance_cents, "minimum_balance_cents"),
    maxSingleReloadCents: row.max_single_reload_cents === null
      ? null
      : toSafeInteger(row.max_single_reload_cents, "max_single_reload_cents"),
    topUpAmountCents: row.top_up_amount_cents === null || row.top_up_amount_cents === undefined
      ? null
      : toSafeInteger(row.top_up_amount_cents, "top_up_amount_cents"),
    paymentHoldTimeoutMinutes: row.payment_hold_timeout_minutes,
    acknowledgedCardFeeBps: row.acknowledged_card_fee_bps ?? null,
    acknowledgedAt: row.acknowledged_at ?? null,
    // The vendor's choice, or null while they have not made one (migration 0704).
    spendRewardsFirst: typeof row.spend_rewards_first === "boolean" ? row.spend_rewards_first : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLedgerRow(row: WalletLedgerRow): DropshipWalletLedgerRecord {
  return {
    ledgerEntryId: row.id,
    walletAccountId: row.wallet_account_id,
    vendorId: row.vendor_id,
    type: row.type,
    status: row.status,
    amountCents: toSafeInteger(row.amount_cents, "amount_cents"),
    currency: row.currency,
    availableBalanceAfterCents: row.available_balance_after_cents === null
      ? null
      : toSafeInteger(row.available_balance_after_cents, "available_balance_after_cents"),
    pendingBalanceAfterCents: row.pending_balance_after_cents === null
      ? null
      : toSafeInteger(row.pending_balance_after_cents, "pending_balance_after_cents"),
    rewardsBalanceAfterCents: row.rewards_balance_after_cents === null || row.rewards_balance_after_cents === undefined
      ? null
      : toSafeInteger(row.rewards_balance_after_cents, "rewards_balance_after_cents"),
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    idempotencyKey: row.idempotency_key,
    fundingMethodId: row.funding_method_id,
    externalTransactionId: row.external_transaction_id,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

function mapUsdcLedgerRow(row: UsdcLedgerRow): DropshipUsdcLedgerEntryRecord {
  return {
    usdcLedgerEntryId: row.id,
    vendorId: row.vendor_id,
    walletLedgerId: row.wallet_ledger_id,
    chainId: row.chain_id,
    transactionHash: row.transaction_hash,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    amountAtomicUnits: String(row.amount_atomic_units),
    confirmations: row.confirmations,
    status: row.status,
    observedAt: row.observed_at,
    settledAt: row.settled_at,
    logIndex: row.log_index ?? null,
    blockNumber: row.block_number === null || row.block_number === undefined
      ? null
      : toSafeInteger(row.block_number, "block_number"),
    blockHash: row.block_hash ?? null,
    tokenAddress: row.token_address ?? null,
    depositAddressId: row.deposit_address_id ?? null,
    dustAtomicUnits: row.dust_atomic_units === null || row.dust_atomic_units === undefined
      ? "0"
      : String(row.dust_atomic_units),
    voidedAt: row.voided_at ?? null,
  };
}

function toSafeInteger(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new DropshipError(
      "DROPSHIP_WALLET_INTEGER_RANGE_ERROR",
      "Dropship wallet integer value is outside the safe runtime range.",
      { field, value: String(value) },
    );
  }
  return parsed;
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }
  return row;
}

function usdcDepositReferenceId(transfer: { chainId: number; transactionHash: string; logIndex: number | null }): string {
  return `${transfer.chainId}:${transfer.transactionHash}:${transfer.logIndex ?? -1}`;
}

/** The same (chain, transaction, log) must always mean the same transfer to the same vendor. */
function assertUsdcObservationMatches(
  existing: DropshipUsdcLedgerEntryRecord,
  input: ObserveDropshipUsdcDepositRepositoryInput,
): void {
  if (
    existing.vendorId !== input.vendorId
    || existing.amountAtomicUnits !== input.transfer.amountAtomicUnits
    || existing.toAddress !== input.transfer.toAddress
  ) {
    throw new DropshipError(
      "DROPSHIP_USDC_TRANSACTION_CONFLICT",
      "USDC transfer log is already recorded with different details.",
      {
        usdcLedgerEntryId: existing.usdcLedgerEntryId,
        recordedVendorId: existing.vendorId,
        vendorId: input.vendorId,
        transactionHash: input.transfer.transactionHash,
        logIndex: input.transfer.logIndex,
        retryable: false,
      },
    );
  }
}

async function requireUsdcLedgerForUpdate(
  client: PoolClient,
  input: { vendorId: number; usdcLedgerEntryId: number },
): Promise<DropshipUsdcLedgerEntryRecord> {
  const usdcLedgerEntry = await loadUsdcLedgerByIdWithClient(client, {
    usdcLedgerEntryId: input.usdcLedgerEntryId,
    vendorId: input.vendorId,
    forUpdate: true,
  });
  if (!usdcLedgerEntry) {
    throw new DropshipError(
      "DROPSHIP_USDC_LEDGER_ENTRY_NOT_FOUND",
      "USDC deposit observation was not found for this vendor.",
      { vendorId: input.vendorId, usdcLedgerEntryId: input.usdcLedgerEntryId, retryable: false },
    );
  }
  return usdcLedgerEntry;
}

/** The pending wallet credit behind a pending observation, with its account row locked. */
async function loadPendingUsdcCreditForUpdate(
  client: PoolClient,
  input: { vendorId: number; usdcLedgerEntry: DropshipUsdcLedgerEntryRecord },
): Promise<{ account: DropshipWalletAccountRecord; ledgerEntry: DropshipWalletLedgerRecord }> {
  if (input.usdcLedgerEntry.walletLedgerId === null) {
    throw new DropshipError(
      "DROPSHIP_USDC_WALLET_LEDGER_MISSING",
      "USDC transaction is not linked to a wallet ledger entry.",
      { vendorId: input.vendorId, usdcLedgerEntryId: input.usdcLedgerEntry.usdcLedgerEntryId, retryable: false },
    );
  }
  const ledgerEntry = await loadWalletLedgerByIdWithClient(client, {
    vendorId: input.vendorId,
    ledgerEntryId: input.usdcLedgerEntry.walletLedgerId,
  });
  if (ledgerEntry.walletAccountId === null) {
    throw new DropshipError(
      "DROPSHIP_WALLET_LEDGER_ACCOUNT_MISSING",
      "Dropship wallet funding ledger entry is not attached to a wallet account.",
      { vendorId: input.vendorId, ledgerEntryId: ledgerEntry.ledgerEntryId, retryable: false },
    );
  }
  const account = await loadWalletAccountByIdWithClient(client, {
    vendorId: input.vendorId,
    walletAccountId: ledgerEntry.walletAccountId,
    forUpdate: true,
  });
  if (!account) {
    throw new DropshipError(
      "DROPSHIP_WALLET_ACCOUNT_NOT_FOUND",
      "Dropship wallet account was not found.",
      { vendorId: input.vendorId, walletAccountId: ledgerEntry.walletAccountId, retryable: false },
    );
  }
  return { account, ledgerEntry };
}

/** The observation as it stands, with its wallet credit and account: what a replay reports. */
async function readUsdcDepositLedgerResultWithClient(
  client: PoolClient,
  input: {
    vendorId: number;
    /** Needed only when the account may not exist yet (a dust replay). */
    currency: string | null;
    usdcLedgerEntry: DropshipUsdcLedgerEntryRecord;
    now: Date;
  },
): Promise<DropshipUsdcDepositLedgerResult> {
  const ledgerEntry = input.usdcLedgerEntry.walletLedgerId === null
    ? null
    : await loadWalletLedgerByIdWithClient(client, {
        vendorId: input.vendorId,
        ledgerEntryId: input.usdcLedgerEntry.walletLedgerId,
      });
  const account = ledgerEntry?.walletAccountId
    ? await loadWalletAccountByIdWithClient(client, { vendorId: input.vendorId, walletAccountId: ledgerEntry.walletAccountId })
    : await getOrCreateWalletAccountWithClient(client, { vendorId: input.vendorId, currency: input.currency ?? "USD", now: input.now });
  return {
    account: requiredRow(account ?? undefined, "Dropship wallet account for a USDC deposit was not found."),
    ledgerEntry,
    usdcLedgerEntry: input.usdcLedgerEntry,
    idempotentReplay: true,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "23505");
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}
