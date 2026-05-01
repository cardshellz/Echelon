CREATE TABLE IF NOT EXISTS dropship.dropship_store_connection_tokens (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
  token_kind varchar(30) NOT NULL,
  token_ref varchar(160) NOT NULL,
  key_id varchar(120) NOT NULL,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_store_token_kind_chk CHECK (token_kind IN ('access','refresh')),
  CONSTRAINT dropship_store_token_ref_chk CHECK (length(token_ref) >= 24)
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_store_token_ref_idx
  ON dropship.dropship_store_connection_tokens(token_ref);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_store_token_connection_kind_idx
  ON dropship.dropship_store_connection_tokens(store_connection_id, token_kind);
