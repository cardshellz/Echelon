-- Dropship V2 return policy configuration.
-- Canonical design: DROPSHIP-V2-CONSOLIDATED-DESIGN.md

CREATE TABLE IF NOT EXISTS dropship.dropship_return_policy_config (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name varchar(120) NOT NULL,
  return_window_days integer NOT NULL DEFAULT 30,
  is_active boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_return_policy_window_chk CHECK (return_window_days > 0 AND return_window_days <= 365),
  CONSTRAINT dropship_return_policy_effective_chk CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX IF NOT EXISTS dropship_return_policy_active_idx
  ON dropship.dropship_return_policy_config(is_active, effective_from DESC, id DESC);
