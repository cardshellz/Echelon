import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type {
  ConfigureDropshipAutoReloadRepositoryInput,
  CreateDropshipConfirmedUsdcFundingRepositoryInput,
  CreateDropshipWalletFundingLedgerInput,
  CreateDropshipWalletOrderDebitInput,
  DropshipAutoReloadSettingRecord,
  DropshipConfirmedUsdcFundingResult,
  DropshipFundingMethodMutationResult,
  DropshipFundingMethodRecord,
  DropshipUsdcLedgerEntryRecord,
  DropshipWalletAccountRecord,
  DropshipWalletLedgerRecord,
  DropshipWalletMutationResult,
  DropshipWalletOverview,
  DropshipWalletRepository,
  UpsertDropshipFundingMethodRepositoryInput,
} from "../application/dropship-wallet-service";

interface WalletAccountRow {
  id: number;
  vendor_id: number;
  available_balance_cents: string | number;
  pending_balance_cents: string | number;
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
  payment_hold_timeout_minutes: number;
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
  reference_type: string | null;
  reference_id: string | null;
  idempotency_key: string | null;
  funding_method_id: number | null;
  external_transaction_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  settled_at: Date | null;
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
}

export class PgDropshipWalletRepository implements DropshipWalletRepository {
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
              ...(input.metadata ?? {}),
              rail: input.rail,
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
          return {
            account: settled.account,
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
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        idempotencyKey: input.idempotencyKey,
        fundingMethodId: input.fundingMethodId ?? null,
        externalTransactionId: input.externalTransactionId ?? null,
        metadata: {
          ...(input.metadata ?? {}),
          rail: input.rail,
          requestHash: input.requestHash,
        },
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
      await client.query("COMMIT");
      return {
        account: updatedAccount,
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
      const referenceId = `${input.chainId}:${input.transactionHash}`;
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
      await client.query("COMMIT");
      return {
        account: updatedAccount,
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
           max_single_reload_cents, payment_hold_timeout_minutes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         ON CONFLICT (vendor_id) DO UPDATE
           SET funding_method_id = EXCLUDED.funding_method_id,
               enabled = EXCLUDED.enabled,
               minimum_balance_cents = EXCLUDED.minimum_balance_cents,
               max_single_reload_cents = EXCLUDED.max_single_reload_cents,
               payment_hold_timeout_minutes = EXCLUDED.payment_hold_timeout_minutes,
               updated_at = EXCLUDED.updated_at
         RETURNING id, vendor_id, funding_method_id, enabled, minimum_balance_cents,
                   max_single_reload_cents, payment_hold_timeout_minutes, created_at, updated_at`,
        [
          input.vendorId,
          input.fundingMethodId,
          input.enabled,
          input.minimumBalanceCents,
          input.maxSingleReloadCents,
          input.paymentHoldTimeoutMinutes,
          input.updatedAt,
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
          maxSingleReloadCents: setting.maxSingleReloadCents,
          paymentHoldTimeoutMinutes: setting.paymentHoldTimeoutMinutes,
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
        referenceId: `${input.chainId}:${input.transactionHash}`,
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
        referenceId: `${input.chainId}:${input.transactionHash}`,
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
    referenceId: `${input.chainId}:${input.transactionHash}`,
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
               available_balance_after_cents, pending_balance_after_cents,
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
    `SELECT id, vendor_id, available_balance_cents, pending_balance_cents,
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
    `SELECT id, vendor_id, available_balance_cents, pending_balance_cents,
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
    updatedAt: Date;
  },
): Promise<DropshipWalletAccountRecord> {
  const result = await client.query<WalletAccountRow>(
    `UPDATE dropship.dropship_wallet_accounts
     SET available_balance_cents = $3,
         pending_balance_cents = $4,
         updated_at = $5
     WHERE id = $1
       AND vendor_id = $2
     RETURNING id, vendor_id, available_balance_cents, pending_balance_cents,
               currency, status, created_at, updated_at`,
    [
      input.walletAccountId,
      input.vendorId,
      input.availableBalanceCents,
      input.pendingBalanceCents,
      input.updatedAt,
    ],
  );
  return mapWalletAccountRow(requiredRow(
    result.rows[0],
    "Dropship wallet balance update did not return a row.",
  ));
}

async function assertFundingMethodCanBeUsed(
  client: PoolClient,
  input: {
    vendorId: number;
    fundingMethodId: number | null;
  },
): Promise<FundingMethodRow | null> {
  if (!input.fundingMethodId) return null;
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
            available_balance_after_cents, pending_balance_after_cents,
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
  },
): Promise<DropshipWalletLedgerRecord> {
  const result = await client.query<WalletLedgerRow>(
    `INSERT INTO dropship.dropship_wallet_ledger
      (wallet_account_id, vendor_id, type, status, amount_cents, currency,
       available_balance_after_cents, pending_balance_after_cents,
       reference_type, reference_id, idempotency_key, funding_method_id,
       external_transaction_id, metadata, created_at, settled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             $9, $10, $11, $12, $13, $14::jsonb, $15, $16)
     RETURNING id, wallet_account_id, vendor_id, type, status, amount_cents, currency,
               available_balance_after_cents, pending_balance_after_cents,
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
            available_balance_after_cents, pending_balance_after_cents,
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

async function findUsdcLedgerByTransactionWithClient(
  client: PoolClient,
  input: {
    chainId: number;
    transactionHash: string;
  },
): Promise<DropshipUsdcLedgerEntryRecord | null> {
  const result = await client.query<UsdcLedgerRow>(
    `SELECT id, vendor_id, wallet_ledger_id, chain_id, transaction_hash,
            from_address, to_address, amount_atomic_units, confirmations,
            status, observed_at, settled_at
     FROM dropship.dropship_usdc_ledger_entries
     WHERE chain_id = $1
       AND transaction_hash = $2
     LIMIT 1
     FOR UPDATE`,
    [input.chainId, input.transactionHash],
  );
  return result.rows[0] ? mapUsdcLedgerRow(result.rows[0]) : null;
}

async function insertUsdcLedgerEntryWithClient(
  client: PoolClient,
  input: {
    vendorId: number;
    walletLedgerId: number;
    chainId: number;
    transactionHash: string;
    fromAddress: string | null;
    toAddress: string;
    amountAtomicUnits: string;
    confirmations: number;
    status: string;
    observedAt: Date;
    settledAt: Date;
  },
): Promise<DropshipUsdcLedgerEntryRecord> {
  const result = await client.query<UsdcLedgerRow>(
    `INSERT INTO dropship.dropship_usdc_ledger_entries
      (vendor_id, wallet_ledger_id, chain_id, transaction_hash, from_address,
       to_address, amount_atomic_units, confirmations, status, observed_at, settled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, vendor_id, wallet_ledger_id, chain_id, transaction_hash,
               from_address, to_address, amount_atomic_units, confirmations,
               status, observed_at, settled_at`,
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
            max_single_reload_cents, payment_hold_timeout_minutes, created_at, updated_at
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
            available_balance_after_cents, pending_balance_after_cents,
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
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, $3, $4,
             'system', NULL, 'info', $5::jsonb, $6)`,
    [
      input.vendorId,
      input.entityType,
      input.entityId,
      input.eventType,
      JSON.stringify(input.payload),
      input.createdAt,
    ],
  );
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
  };
}

function mapWalletAccountRow(row: WalletAccountRow): DropshipWalletAccountRecord {
  return {
    walletAccountId: row.id,
    vendorId: row.vendor_id,
    availableBalanceCents: toSafeInteger(row.available_balance_cents, "available_balance_cents"),
    pendingBalanceCents: toSafeInteger(row.pending_balance_cents, "pending_balance_cents"),
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
    paymentHoldTimeoutMinutes: row.payment_hold_timeout_minutes,
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
