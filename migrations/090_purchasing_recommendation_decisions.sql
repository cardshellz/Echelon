-- Migration 090: Persist operator decisions for purchasing recommendation review.

CREATE TABLE IF NOT EXISTS procurement.purchasing_recommendation_decisions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recommendation_id VARCHAR(160) NOT NULL,
  kind VARCHAR(40) NOT NULL,
  decision VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  decision_reason VARCHAR(100),
  note TEXT,
  source VARCHAR(40) NOT NULL DEFAULT 'operator',
  auto_draft_run_id INTEGER REFERENCES public.auto_draft_runs(id) ON DELETE SET NULL,
  product_id INTEGER REFERENCES catalog.products(id) ON DELETE SET NULL,
  product_variant_id INTEGER REFERENCES catalog.product_variants(id) ON DELETE SET NULL,
  vendor_id INTEGER REFERENCES procurement.vendors(id) ON DELETE SET NULL,
  sku VARCHAR(100),
  product_name TEXT,
  candidate_score INTEGER,
  candidate_band VARCHAR(40),
  recommendation_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  decided_by VARCHAR(255),
  decided_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT purchasing_recommendation_decisions_kind_chk
    CHECK (kind IN ('skipped', 'held_by_policy', 'quality_review_required')),
  CONSTRAINT purchasing_recommendation_decisions_decision_chk
    CHECK (decision IN ('reviewed', 'accepted_for_po', 'deferred', 'dismissed')),
  CONSTRAINT purchasing_recommendation_decisions_status_chk
    CHECK (status IN ('active', 'superseded', 'voided'))
);

CREATE INDEX IF NOT EXISTS purch_rec_decisions_rec_kind_decided_idx
  ON procurement.purchasing_recommendation_decisions (recommendation_id, kind, decided_at DESC);

CREATE INDEX IF NOT EXISTS purch_rec_decisions_decision_decided_idx
  ON procurement.purchasing_recommendation_decisions (decision, decided_at DESC);

CREATE INDEX IF NOT EXISTS purch_rec_decisions_sku_idx
  ON procurement.purchasing_recommendation_decisions (sku);
