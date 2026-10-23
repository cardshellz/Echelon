import { ebaySyncBackBaseFixtureSql } from "./ebay-sync-back.fixture";

/**
 * The order fixes' tables (eBay sync-back plan v4 §7), on top of the sync-back
 * base fixture and its real migration (installEbaySyncBackSchema): the intake
 * columns the order repositories read (0086 shapes), the canonical stage's
 * state (0667, reduced), the wallet account, ledger and rewards lots with the
 * production constraints the refund relies on (the ledger's type CHECK and
 * its unique reference and key indexes; the lots' amount CHECK and the
 * movements' append-only trigger, 0705), the tracking pushes the hourly check
 * reads, and the Dropship OMS channel intake resolves.
 */
export const ebaySyncBackOrdersFixtureSql = `
  ${ebaySyncBackBaseFixtureSql}
  ALTER TABLE dropship.dropship_vendors ADD COLUMN standing_reason varchar(60);
  ALTER TABLE dropship.dropship_store_connections ADD COLUMN access_token_ref text, ADD COLUMN refresh_token_ref text,
    ADD COLUMN config jsonb NOT NULL DEFAULT '{}';
  CREATE TABLE channels.channels (id integer PRIMARY KEY, name text NOT NULL, status text NOT NULL, type text NOT NULL, provider text NOT NULL);
  INSERT INTO channels.channels VALUES (50, 'Dropship OMS', 'active', 'internal', 'manual');
  ALTER TABLE dropship.dropship_order_intake
    ADD COLUMN channel_id integer NOT NULL DEFAULT 50, ADD COLUMN external_order_number varchar(100), ADD COLUMN source_order_id varchar(255),
    ADD COLUMN payment_hold_expires_at timestamptz, ADD COLUMN rejection_reason text, ADD COLUMN raw_payload jsonb,
    ADD COLUMN normalized_payload jsonb, ADD COLUMN payload_hash varchar(128), ADD COLUMN oms_order_id bigint, ADD COLUMN accepted_at timestamptz;
  CREATE TABLE dropship.dropship_order_acceptance_stages (intake_id integer PRIMARY KEY REFERENCES dropship.dropship_order_intake(id),
    state varchar(30) NOT NULL, shipping_quote_snapshot_id integer NOT NULL DEFAULT 1);
  CREATE TABLE dropship.dropship_marketplace_tracking_pushes (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    intake_id integer NOT NULL REFERENCES dropship.dropship_order_intake(id) ON DELETE CASCADE);

  CREATE TABLE dropship.dropship_wallet_accounts (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vendor_id integer NOT NULL UNIQUE REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
    available_balance_cents bigint NOT NULL DEFAULT 0, pending_balance_cents bigint NOT NULL DEFAULT 0,
    rewards_balance_cents bigint NOT NULL DEFAULT 0, currency varchar(3) NOT NULL DEFAULT 'USD', status varchar(30) NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dropship_wallet_pending_nonnegative_chk CHECK (pending_balance_cents >= 0),
    CONSTRAINT dropship_wallet_rewards_nonnegative_chk CHECK (rewards_balance_cents >= 0));
  CREATE TABLE dropship.dropship_wallet_ledger (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    wallet_account_id integer REFERENCES dropship.dropship_wallet_accounts(id) ON DELETE CASCADE,
    vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
    type varchar(40) NOT NULL, status varchar(30) NOT NULL DEFAULT 'pending', amount_cents bigint NOT NULL, currency varchar(3) NOT NULL DEFAULT 'USD',
    available_balance_after_cents bigint, pending_balance_after_cents bigint, rewards_balance_after_cents bigint,
    reference_type varchar(80), reference_id varchar(255), idempotency_key varchar(200), funding_method_id integer,
    external_transaction_id varchar(255), metadata jsonb, created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz,
    CONSTRAINT dropship_wallet_ledger_type_chk CHECK (type IN ('funding','order_debit','refund_credit','return_credit','return_fee',
      'insurance_pool_credit','manual_adjustment','advance_fee','funding_reversal','funding_reinstated','rewards_earned','rewards_spent',
      'rewards_reversed','rewards_reinstated','rewards_expired')),
    CONSTRAINT dropship_wallet_ledger_amount_chk CHECK (amount_cents <> 0));
  CREATE UNIQUE INDEX dropship_wallet_ref_idx ON dropship.dropship_wallet_ledger (reference_type, reference_id)
    WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;
  CREATE UNIQUE INDEX dropship_wallet_idem_idx ON dropship.dropship_wallet_ledger (idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE TABLE dropship.dropship_wallet_rewards_lots (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    wallet_account_id integer NOT NULL REFERENCES dropship.dropship_wallet_accounts(id) ON DELETE RESTRICT,
    vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE RESTRICT,
    source varchar(30) NOT NULL, origin_ledger_entry_id integer REFERENCES dropship.dropship_wallet_ledger(id) ON DELETE RESTRICT,
    earned_cents bigint NOT NULL, remaining_cents bigint NOT NULL, earned_at timestamptz NOT NULL, expires_at timestamptz, expiry_days integer,
    created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
    CONSTRAINT dropship_wallet_rewards_lots_source_chk CHECK (source IN ('earned','opening_balance','restored','reconciled')),
    CONSTRAINT dropship_wallet_rewards_lots_origin_chk CHECK ((source IN ('earned','restored')) = (origin_ledger_entry_id IS NOT NULL)),
    CONSTRAINT dropship_wallet_rewards_lots_amount_chk CHECK (earned_cents > 0 AND remaining_cents >= 0 AND remaining_cents <= earned_cents));
  CREATE TABLE dropship.dropship_wallet_rewards_lot_movements (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    lot_id integer NOT NULL REFERENCES dropship.dropship_wallet_rewards_lots(id) ON DELETE RESTRICT,
    ledger_entry_id integer REFERENCES dropship.dropship_wallet_ledger(id) ON DELETE RESTRICT,
    reason varchar(30) NOT NULL, amount_cents bigint NOT NULL, created_at timestamptz NOT NULL,
    CONSTRAINT dropship_wallet_rewards_lot_movements_amount_chk CHECK (amount_cents <> 0));
  CREATE FUNCTION dropship.dropship_wallet_rewards_lot_movements_guard() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'dropship wallet rewards lot movements are append-only' USING ERRCODE = '23514'; END; $$;
  CREATE TRIGGER dropship_wallet_rewards_lot_movements_guard_trg BEFORE UPDATE OR DELETE ON dropship.dropship_wallet_rewards_lot_movements
    FOR EACH ROW EXECUTE FUNCTION dropship.dropship_wallet_rewards_lot_movements_guard();
`;
