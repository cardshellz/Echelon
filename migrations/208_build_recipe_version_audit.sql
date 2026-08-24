-- Durable evidence for versioned build-recipe edits.
-- Recipe definitions remain immutable; edits create a successor row while
-- preserving the exact recipe referenced by historical build orders.

ALTER TABLE inventory.build_recipes
  ADD COLUMN IF NOT EXISTS supersedes_recipe_id integer,
  ADD COLUMN IF NOT EXISTS change_reason varchar(1000),
  ADD COLUMN IF NOT EXISTS change_idempotency_key varchar(100),
  ADD COLUMN IF NOT EXISTS change_request_hash varchar(64),
  ADD COLUMN IF NOT EXISTS retired_by varchar(100),
  ADD COLUMN IF NOT EXISTS retired_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'build_recipes_supersedes_recipe_fk'
      AND conrelid = 'inventory.build_recipes'::regclass
  ) THEN
    ALTER TABLE inventory.build_recipes
      ADD CONSTRAINT build_recipes_supersedes_recipe_fk
      FOREIGN KEY (supersedes_recipe_id)
      REFERENCES inventory.build_recipes(id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

-- Pre-existing higher versions predate this audit contract. Link them to the
-- nearest prior definition and label the evidence as a migration backfill;
-- the original operator/reason is intentionally not fabricated.
WITH predecessor AS (
  SELECT current.id,
         (
           SELECT prior.id
           FROM inventory.build_recipes prior
           WHERE prior.code = current.code
             AND prior.version < current.version
           ORDER BY prior.version DESC
           LIMIT 1
         ) AS predecessor_id
  FROM inventory.build_recipes current
  WHERE current.version > 1
)
UPDATE inventory.build_recipes recipe
SET supersedes_recipe_id = COALESCE(recipe.supersedes_recipe_id, predecessor.predecessor_id),
    change_reason = COALESCE(
      NULLIF(btrim(recipe.change_reason), ''),
      'Legacy recipe version imported by migration 208; original reason unavailable'
    ),
    change_idempotency_key = COALESCE(
      NULLIF(btrim(recipe.change_idempotency_key), ''),
      'migration-208-recipe-' || recipe.id::text
    ),
    change_request_hash = COALESCE(
      NULLIF(btrim(recipe.change_request_hash), ''),
      md5('migration-208-recipe-' || recipe.id::text)
        || md5('migration-208-recipe-hash-' || recipe.id::text)
    )
FROM predecessor
WHERE recipe.id = predecessor.id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM inventory.build_recipes
    WHERE version > 1
      AND supersedes_recipe_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot add build recipe audit constraints: a legacy version has no predecessor';
  END IF;
END
$$;

-- Legacy retirement did not capture actor/time. Preserve that distinction
-- explicitly instead of pretending the original operator is known.
UPDATE inventory.build_recipes
SET retired_by = COALESCE(retired_by, 'system:migration:208'),
    retired_at = COALESCE(retired_at, updated_at, created_at, CURRENT_TIMESTAMP)
WHERE status = 'retired'
  AND (retired_by IS NULL OR retired_at IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS build_recipes_change_idempotency_uidx
  ON inventory.build_recipes(change_idempotency_key)
  WHERE change_idempotency_key IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'build_recipes_version_change_evidence_chk'
      AND conrelid = 'inventory.build_recipes'::regclass
  ) THEN
    ALTER TABLE inventory.build_recipes
      ADD CONSTRAINT build_recipes_version_change_evidence_chk
      CHECK (
        (version = 1 AND supersedes_recipe_id IS NULL)
        OR (
          version > 1
          AND supersedes_recipe_id IS NOT NULL
          AND btrim(change_reason) <> ''
          AND change_idempotency_key IS NOT NULL
          AND btrim(change_idempotency_key) <> ''
          AND change_request_hash ~ '^[0-9a-f]{64}$'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'build_recipes_retirement_evidence_chk'
      AND conrelid = 'inventory.build_recipes'::regclass
  ) THEN
    ALTER TABLE inventory.build_recipes
      ADD CONSTRAINT build_recipes_retirement_evidence_chk
      CHECK (
        (status = 'retired' AND retired_by IS NOT NULL AND retired_at IS NOT NULL)
        OR (status <> 'retired' AND retired_by IS NULL AND retired_at IS NULL)
      );
  END IF;
END
$$;
