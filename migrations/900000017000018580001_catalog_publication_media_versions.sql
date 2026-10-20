-- Catalog retains immutable bytes independently of the mutable asset record.
-- No asset FK/cascade: an accepted publication URL must survive asset deletion.
CREATE TABLE catalog.product_asset_versions (
  asset_id integer NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  file_data bytea NOT NULL CHECK (octet_length(file_data) BETWEEN 1 AND 10485760),
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp','image/gif')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, content_hash),
  CHECK (encode(sha256(file_data), 'hex') = content_hash)
);

-- The same signature contract as Catalog's public raster-image reader.
CREATE FUNCTION catalog.publication_image_mime(data bytea) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE
    WHEN substring(data FROM 1 FOR 3) = decode('ffd8ff','hex') THEN 'image/jpeg'
    WHEN substring(data FROM 1 FOR 8) = decode('89504e470d0a1a0a','hex') THEN 'image/png'
    WHEN substring(data FROM 1 FOR 6) IN (decode('474946383761','hex'),decode('474946383961','hex')) THEN 'image/gif'
    WHEN substring(data FROM 1 FOR 4) = decode('52494646','hex')
      AND substring(data FROM 9 FOR 4) = decode('57454250','hex') THEN 'image/webp'
  END
$$;

CREATE FUNCTION catalog.retain_product_asset_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE asset catalog.product_assets;
BEGIN
  -- Capture the departing version as well: this also protects the first write
  -- to a pre-migration asset, in the same transaction as its source mutation.
  IF TG_OP IN ('UPDATE','DELETE') THEN
    asset := OLD;
    IF asset.asset_type='image' AND asset.storage_type IN ('file','both')
      AND octet_length(asset.file_data) BETWEEN 1 AND 10485760
      AND asset.mime_type = catalog.publication_image_mime(asset.file_data) THEN
      INSERT INTO catalog.product_asset_versions(asset_id,content_hash,file_data,mime_type)
      VALUES (asset.id,encode(sha256(asset.file_data),'hex'),asset.file_data,asset.mime_type)
      ON CONFLICT (asset_id,content_hash) DO NOTHING;
    END IF;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    asset := NEW;
    IF asset.asset_type='image' AND asset.storage_type IN ('file','both')
      AND octet_length(asset.file_data) BETWEEN 1 AND 10485760
      AND asset.mime_type = catalog.publication_image_mime(asset.file_data) THEN
      INSERT INTO catalog.product_asset_versions(asset_id,content_hash,file_data,mime_type)
      VALUES (asset.id,encode(sha256(asset.file_data),'hex'),asset.file_data,asset.mime_type)
      ON CONFLICT (asset_id,content_hash) DO NOTHING;
    END IF;
  END IF;
  RETURN COALESCE(NEW,OLD);
END
$$;
CREATE TRIGGER retain_product_asset_version
AFTER INSERT OR UPDATE OR DELETE ON catalog.product_assets
FOR EACH ROW EXECUTE FUNCTION catalog.retain_product_asset_version();

INSERT INTO catalog.product_asset_versions(asset_id,content_hash,file_data,mime_type)
SELECT id,encode(sha256(file_data),'hex'),file_data,mime_type
FROM catalog.product_assets
WHERE asset_type='image' AND storage_type IN ('file','both')
  AND octet_length(file_data) BETWEEN 1 AND 10485760
  AND mime_type = catalog.publication_image_mime(file_data)
ON CONFLICT (asset_id,content_hash) DO NOTHING;

CREATE TABLE catalog.publication_media_references (
  owner text NOT NULL CHECK (owner IN ('channels','marketplace-listings','dropship')),
  reference_key text NOT NULL CHECK (length(reference_key) BETWEEN 1 AND 200),
  source_revision text NOT NULL CHECK (source_revision ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('pending','current')),
  created_at timestamptz NOT NULL,
  retired_at timestamptz,
  PRIMARY KEY(owner,reference_key)
);
CREATE TABLE catalog.publication_media_version_pins (
  owner text NOT NULL,
  reference_key text NOT NULL,
  asset_id integer NOT NULL,
  content_hash text NOT NULL,
  PRIMARY KEY(owner,reference_key,asset_id,content_hash),
  FOREIGN KEY(owner,reference_key) REFERENCES catalog.publication_media_references(owner,reference_key),
  FOREIGN KEY(asset_id,content_hash) REFERENCES catalog.product_asset_versions(asset_id,content_hash)
);
CREATE INDEX publication_media_version_pins_version ON catalog.publication_media_version_pins(asset_id,content_hash);

CREATE FUNCTION catalog.reject_publication_image_version_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Published image versions are immutable and retained'
    USING ERRCODE='23514', CONSTRAINT='publication_image_versions_immutable';
END
$$;
CREATE TRIGGER publication_image_versions_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON catalog.product_asset_versions
FOR EACH STATEMENT EXECUTE FUNCTION catalog.reject_publication_image_version_mutation();

-- Intentionally no garbage collector. Legacy public URLs have no complete
-- reference census. Future GC requires proven absence of pending/current pins
-- AND legacy references; lack of a newly introduced pin is not deletion proof.
