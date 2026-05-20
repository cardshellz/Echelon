CREATE TABLE IF NOT EXISTS catalog.product_categories (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name varchar(100) NOT NULL,
  slug varchar(120) NOT NULL UNIQUE,
  description text,
  sort_order integer DEFAULT 0,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_categories_active_sort
  ON catalog.product_categories (is_active, sort_order, name);

ALTER TABLE catalog.products
  ADD COLUMN IF NOT EXISTS category_id integer;

INSERT INTO catalog.product_categories (name, slug)
SELECT
  trimmed_category AS name,
  coalesce(
    nullif(
      regexp_replace(
        regexp_replace(lower(trimmed_category), '[^a-z0-9]+', '-', 'g'),
        '(^-|-$)',
        '',
        'g'
      ),
      ''
    ),
    'category-' || md5(trimmed_category)
  ) AS slug
FROM (
  SELECT DISTINCT btrim(category) AS trimmed_category
  FROM catalog.products
  WHERE nullif(btrim(category), '') IS NOT NULL
) existing_categories
ON CONFLICT (slug) DO NOTHING;

UPDATE catalog.products p
SET category_id = pc.id,
    category = pc.name
FROM catalog.product_categories pc
WHERE p.category_id IS NULL
  AND nullif(btrim(p.category), '') IS NOT NULL
  AND coalesce(
        nullif(
          regexp_replace(
            regexp_replace(lower(btrim(p.category)), '[^a-z0-9]+', '-', 'g'),
            '(^-|-$)',
            '',
            'g'
          ),
          ''
        ),
        'category-' || md5(btrim(p.category))
      ) = pc.slug;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'products_category_id_product_categories_id_fk'
  ) THEN
    ALTER TABLE catalog.products
      ADD CONSTRAINT products_category_id_product_categories_id_fk
      FOREIGN KEY (category_id)
      REFERENCES catalog.product_categories(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_products_category_id
  ON catalog.products (category_id);
