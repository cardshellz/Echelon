-- Dropship wallet funding design, phase 6: USDC in a Card Shellz wallet.
--
-- Each vendor gets their own deposit address, derived on the server from an
-- account-level extended PUBLIC key (BIP-32: the account key, then 0/i). The
-- spending key never touches the server. A chain watcher on Base credits
-- deposits automatically: a transfer is recorded as a pending credit once it
-- has the configured confirmations, settles once its block is at or below the
-- network's safe head, and is voided if a reorg removes it. Design record:
-- docs/DROPSHIP-WALLET-FUNDING-DESIGN.md ("USDC in a Card Shellz wallet").

CREATE TABLE IF NOT EXISTS dropship.dropship_usdc_deposit_addresses (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  chain_id integer NOT NULL DEFAULT 8453,
  -- Fingerprint of the account extended public key the address derives from,
  -- so a rotated key never reuses an index and old addresses stay attributable.
  key_fingerprint varchar(16) NOT NULL,
  -- The child index i in 0/i under the account key (BIP-44 external chain).
  derivation_index integer NOT NULL,
  -- Lowercase for matching; the EIP-55 form is what vendors are shown.
  address varchar(42) NOT NULL,
  checksum_address varchar(42) NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_usdc_deposit_index_chk CHECK (derivation_index >= 0),
  CONSTRAINT dropship_usdc_deposit_address_chk CHECK (address ~ '^0x[0-9a-f]{40}$')
);

-- One address per vendor per chain; one index per key; one address per chain.
CREATE UNIQUE INDEX IF NOT EXISTS dropship_usdc_deposit_vendor_idx
  ON dropship.dropship_usdc_deposit_addresses(vendor_id, chain_id);
CREATE UNIQUE INDEX IF NOT EXISTS dropship_usdc_deposit_key_index_idx
  ON dropship.dropship_usdc_deposit_addresses(chain_id, key_fingerprint, derivation_index);
CREATE UNIQUE INDEX IF NOT EXISTS dropship_usdc_deposit_address_idx
  ON dropship.dropship_usdc_deposit_addresses(chain_id, address);

COMMENT ON TABLE dropship.dropship_usdc_deposit_addresses IS
  'Per-vendor USDC deposit addresses derived from the watch-only account key (funding design phase 6, migration 0691).';

-- Where the watcher has scanned to, per chain and token contract.
CREATE TABLE IF NOT EXISTS dropship.dropship_usdc_watcher_cursors (
  chain_id integer NOT NULL,
  token_address varchar(42) NOT NULL,
  last_scanned_block bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, token_address),
  CONSTRAINT dropship_usdc_cursor_block_chk CHECK (last_scanned_block >= 0),
  CONSTRAINT dropship_usdc_cursor_token_chk CHECK (token_address ~ '^0x[0-9a-f]{40}$')
);

-- The chain observation grows the facts the watcher needs: which log in
-- which block, the token, the vendor address it landed on, sub-cent dust,
-- and when a reorg voided it.
ALTER TABLE dropship.dropship_usdc_ledger_entries
  ADD COLUMN IF NOT EXISTS log_index integer,
  ADD COLUMN IF NOT EXISTS block_number bigint,
  ADD COLUMN IF NOT EXISTS block_hash varchar(66),
  ADD COLUMN IF NOT EXISTS token_address varchar(42),
  ADD COLUMN IF NOT EXISTS deposit_address_id integer
    REFERENCES dropship.dropship_usdc_deposit_addresses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dust_atomic_units numeric(78, 0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS voided_at timestamptz;

-- One transaction can carry several transfers (an exchange's batched
-- withdrawals), so the identity is the log, not the transaction. Manual staff
-- credits carry no log index and keep their one-per-transaction identity
-- through the -1 key.
DROP INDEX IF EXISTS dropship.dropship_usdc_tx_idx;
CREATE UNIQUE INDEX IF NOT EXISTS dropship_usdc_tx_log_idx
  ON dropship.dropship_usdc_ledger_entries(chain_id, transaction_hash, COALESCE(log_index, -1));
CREATE INDEX IF NOT EXISTS dropship_usdc_pending_idx
  ON dropship.dropship_usdc_ledger_entries(status, block_number)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS dropship_usdc_deposit_address_ref_idx
  ON dropship.dropship_usdc_ledger_entries(deposit_address_id)
  WHERE deposit_address_id IS NOT NULL;

ALTER TABLE dropship.dropship_usdc_ledger_entries
  DROP CONSTRAINT IF EXISTS dropship_usdc_status_chk;
ALTER TABLE dropship.dropship_usdc_ledger_entries
  ADD CONSTRAINT dropship_usdc_status_chk
    CHECK (status IN ('pending', 'settled', 'voided', 'dust'));
ALTER TABLE dropship.dropship_usdc_ledger_entries
  DROP CONSTRAINT IF EXISTS dropship_usdc_log_index_chk;
ALTER TABLE dropship.dropship_usdc_ledger_entries
  ADD CONSTRAINT dropship_usdc_log_index_chk
    CHECK (log_index IS NULL OR log_index >= 0);
ALTER TABLE dropship.dropship_usdc_ledger_entries
  DROP CONSTRAINT IF EXISTS dropship_usdc_dust_chk;
ALTER TABLE dropship.dropship_usdc_ledger_entries
  ADD CONSTRAINT dropship_usdc_dust_chk
    CHECK (dust_atomic_units >= 0 AND dust_atomic_units < 10000);

COMMENT ON COLUMN dropship.dropship_usdc_ledger_entries.dust_atomic_units IS
  'The sub-cent remainder of the transfer (atomic units mod 10^4): still at the address, never credited (migration 0691).';
COMMENT ON COLUMN dropship.dropship_usdc_ledger_entries.status IS
  'pending: credited to the pending balance, awaiting the safe head; settled: available; voided: removed by a reorg; dust: under one cent, recorded and never credited (migration 0691).';
