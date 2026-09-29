-- Staged enforcement: canonicalize new/changed owned order countries only.
-- Historical aliases are deliberately untouched, including unchanged-value
-- updates. Historical repair requires a separately approved, audited operation.
-- public.shopify_orders is externally owned and is deliberately excluded.
-- Reference values mirror shared/country-code.ts; PostgreSQL parity tests guard drift.

CREATE TABLE IF NOT EXISTS oms.order_country_codes (
  code TEXT PRIMARY KEY CHECK (code IN ('AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AS','AT','AU','AW','AX','AZ','BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BV','BW','BY','BZ','CA','CC','CD','CF','CG','CH','CI','CK','CL','CM','CN','CO','CR','CU','CV','CW','CX','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE','EG','EH','ER','ES','ET','FI','FJ','FK','FM','FO','FR','GA','GB','GD','GE','GF','GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY','HK','HM','HN','HR','HT','HU','ID','IE','IL','IM','IN','IO','IQ','IR','IS','IT','JE','JM','JO','JP','KE','KG','KH','KI','KM','KN','KP','KR','KW','KY','KZ','LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MF','MG','MH','MK','ML','MM','MN','MO','MP','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ','NA','NC','NE','NF','NG','NI','NL','NO','NP','NR','NU','NZ','OM','PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PW','PY','QA','RE','RO','RS','RU','RW','SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SY','SZ','TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ','UA','UG','UM','US','UY','UZ','VA','VC','VE','VG','VI','VN','VU','WF','WS','YE','YT','ZA','ZM','ZW'))
);
INSERT INTO oms.order_country_codes(code)
SELECT unnest(ARRAY['AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AS','AT','AU','AW','AX','AZ','BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BV','BW','BY','BZ','CA','CC','CD','CF','CG','CH','CI','CK','CL','CM','CN','CO','CR','CU','CV','CW','CX','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE','EG','EH','ER','ES','ET','FI','FJ','FK','FM','FO','FR','GA','GB','GD','GE','GF','GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY','HK','HM','HN','HR','HT','HU','ID','IE','IL','IM','IN','IO','IQ','IR','IS','IT','JE','JM','JO','JP','KE','KG','KH','KI','KM','KN','KP','KR','KW','KY','KZ','LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MF','MG','MH','MK','ML','MM','MN','MO','MP','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ','NA','NC','NE','NF','NG','NI','NL','NO','NP','NR','NU','NZ','OM','PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PW','PY','QA','RE','RO','RS','RU','RW','SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SY','SZ','TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ','UA','UG','UM','US','UY','UZ','VA','VC','VE','VG','VI','VN','VU','WF','WS','YE','YT','ZA','ZM','ZW']::text[]) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS oms.order_country_aliases (
  alias TEXT COLLATE "C" PRIMARY KEY,
  code TEXT COLLATE "C" NOT NULL REFERENCES oms.order_country_codes(code),
  CHECK ((alias,code) IN (('united states','US'),
  ('united states of america','US'),
  ('usa','US'),
  ('u.s.a.','US'),
  ('u.s.','US'),
  ('puerto rico','PR'),
  ('guam','GU'),
  ('u.s. virgin islands','VI'),
  ('us virgin islands','VI'),
  ('american samoa','AS'),
  ('northern mariana islands','MP'),
  ('canada','CA'),
  ('united kingdom','GB'),
  ('great britain','GB'),
  ('britain','GB'),
  ('england','GB'),
  ('scotland','GB'),
  ('wales','GB'),
  ('northern ireland','GB'),
  ('uk','GB'),
  ('australia','AU'),
  ('new zealand','NZ'),
  ('ireland','IE'),
  ('germany','DE'),
  ('deutschland','DE'),
  ('france','FR'),
  ('spain','ES'),
  ('italy','IT'),
  ('netherlands','NL'),
  ('the netherlands','NL'),
  ('holland','NL'),
  ('belgium','BE'),
  ('switzerland','CH'),
  ('austria','AT'),
  ('sweden','SE'),
  ('norway','NO'),
  ('denmark','DK'),
  ('finland','FI'),
  ('iceland','IS'),
  ('poland','PL'),
  ('portugal','PT'),
  ('greece','GR'),
  ('czech republic','CZ'),
  ('czechia','CZ'),
  ('hungary','HU'),
  ('romania','RO'),
  ('bulgaria','BG'),
  ('croatia','HR'),
  ('slovakia','SK'),
  ('slovenia','SI'),
  ('estonia','EE'),
  ('latvia','LV'),
  ('lithuania','LT'),
  ('luxembourg','LU'),
  ('cyprus','CY'),
  ('malta','MT'),
  ('japan','JP'),
  ('china','CN'),
  ('hong kong','HK'),
  ('hong kong sar china','HK'),
  ('hong kong sar','HK'),
  ('macau','MO'),
  ('macao','MO'),
  ('macao sar china','MO'),
  ('south korea','KR'),
  ('korea, republic of','KR'),
  ('republic of korea','KR'),
  ('singapore','SG'),
  ('taiwan','TW'),
  ('taiwan, province of china','TW'),
  ('india','IN'),
  ('pakistan','PK'),
  ('bangladesh','BD'),
  ('sri lanka','LK'),
  ('nepal','NP'),
  ('mexico','MX'),
  ('brazil','BR'),
  ('argentina','AR'),
  ('chile','CL'),
  ('colombia','CO'),
  ('peru','PE'),
  ('ecuador','EC'),
  ('uruguay','UY'),
  ('venezuela','VE'),
  ('panama','PA'),
  ('guatemala','GT'),
  ('costa rica','CR'),
  ('dominican republic','DO'),
  ('united arab emirates','AE'),
  ('uae','AE'),
  ('saudi arabia','SA'),
  ('qatar','QA'),
  ('kuwait','KW'),
  ('bahrain','BH'),
  ('oman','OM'),
  ('jordan','JO'),
  ('lebanon','LB'),
  ('israel','IL'),
  ('turkey','TR'),
  ('turkiye','TR'),
  ('russia','RU'),
  ('russian federation','RU'),
  ('ukraine','UA'),
  ('egypt','EG'),
  ('morocco','MA'),
  ('nigeria','NG'),
  ('kenya','KE'),
  ('ghana','GH'),
  ('south africa','ZA'),
  ('philippines','PH'),
  ('malaysia','MY'),
  ('thailand','TH'),
  ('indonesia','ID'),
  ('vietnam','VN'),
  ('viet nam','VN'),
  ('can','CA'),
  ('gbr','GB'),
  ('aus','AU'),
  ('deu','DE'),
  ('fra','FR'),
  ('nld','NL')))
);
INSERT INTO oms.order_country_aliases(alias,code) VALUES
  ('united states','US'),
  ('united states of america','US'),
  ('usa','US'),
  ('u.s.a.','US'),
  ('u.s.','US'),
  ('puerto rico','PR'),
  ('guam','GU'),
  ('u.s. virgin islands','VI'),
  ('us virgin islands','VI'),
  ('american samoa','AS'),
  ('northern mariana islands','MP'),
  ('canada','CA'),
  ('united kingdom','GB'),
  ('great britain','GB'),
  ('britain','GB'),
  ('england','GB'),
  ('scotland','GB'),
  ('wales','GB'),
  ('northern ireland','GB'),
  ('uk','GB'),
  ('australia','AU'),
  ('new zealand','NZ'),
  ('ireland','IE'),
  ('germany','DE'),
  ('deutschland','DE'),
  ('france','FR'),
  ('spain','ES'),
  ('italy','IT'),
  ('netherlands','NL'),
  ('the netherlands','NL'),
  ('holland','NL'),
  ('belgium','BE'),
  ('switzerland','CH'),
  ('austria','AT'),
  ('sweden','SE'),
  ('norway','NO'),
  ('denmark','DK'),
  ('finland','FI'),
  ('iceland','IS'),
  ('poland','PL'),
  ('portugal','PT'),
  ('greece','GR'),
  ('czech republic','CZ'),
  ('czechia','CZ'),
  ('hungary','HU'),
  ('romania','RO'),
  ('bulgaria','BG'),
  ('croatia','HR'),
  ('slovakia','SK'),
  ('slovenia','SI'),
  ('estonia','EE'),
  ('latvia','LV'),
  ('lithuania','LT'),
  ('luxembourg','LU'),
  ('cyprus','CY'),
  ('malta','MT'),
  ('japan','JP'),
  ('china','CN'),
  ('hong kong','HK'),
  ('hong kong sar china','HK'),
  ('hong kong sar','HK'),
  ('macau','MO'),
  ('macao','MO'),
  ('macao sar china','MO'),
  ('south korea','KR'),
  ('korea, republic of','KR'),
  ('republic of korea','KR'),
  ('singapore','SG'),
  ('taiwan','TW'),
  ('taiwan, province of china','TW'),
  ('india','IN'),
  ('pakistan','PK'),
  ('bangladesh','BD'),
  ('sri lanka','LK'),
  ('nepal','NP'),
  ('mexico','MX'),
  ('brazil','BR'),
  ('argentina','AR'),
  ('chile','CL'),
  ('colombia','CO'),
  ('peru','PE'),
  ('ecuador','EC'),
  ('uruguay','UY'),
  ('venezuela','VE'),
  ('panama','PA'),
  ('guatemala','GT'),
  ('costa rica','CR'),
  ('dominican republic','DO'),
  ('united arab emirates','AE'),
  ('uae','AE'),
  ('saudi arabia','SA'),
  ('qatar','QA'),
  ('kuwait','KW'),
  ('bahrain','BH'),
  ('oman','OM'),
  ('jordan','JO'),
  ('lebanon','LB'),
  ('israel','IL'),
  ('turkey','TR'),
  ('turkiye','TR'),
  ('russia','RU'),
  ('russian federation','RU'),
  ('ukraine','UA'),
  ('egypt','EG'),
  ('morocco','MA'),
  ('nigeria','NG'),
  ('kenya','KE'),
  ('ghana','GH'),
  ('south africa','ZA'),
  ('philippines','PH'),
  ('malaysia','MY'),
  ('thailand','TH'),
  ('indonesia','ID'),
  ('vietnam','VN'),
  ('viet nam','VN'),
  ('can','CA'),
  ('gbr','GB'),
  ('aus','AU'),
  ('deu','DE'),
  ('fra','FR'),
  ('nld','NL')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION oms.normalize_order_country(input TEXT)
RETURNS TEXT LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  cleaned TEXT;
  canonical TEXT;
BEGIN
  IF input IS NULL THEN RETURN NULL; END IF;
  IF char_length(input)>100 THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='ORDER_COUNTRY_INVALID';
  END IF;
  -- Match JavaScript NFD/combining-mark removal and its explicit trim set.
  cleaned := btrim(regexp_replace(normalize(input,NFD), U&'[\0300-\036f]', '', 'g'), U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
  IF cleaned='' THEN RETURN NULL; END IF;
  -- Match the application's ASCII ISO-code branch, independent of database or
  -- caller collation. Unicode case folding must not turn confusables into codes.
  IF cleaned COLLATE "C" ~ '^[A-Za-z]{2}$' THEN
    SELECT code INTO canonical FROM oms.order_country_codes WHERE code=upper(cleaned COLLATE "C");
  END IF;
  IF canonical IS NULL THEN
    SELECT code INTO canonical FROM oms.order_country_aliases WHERE alias=lower(cleaned COLLATE "C");
  END IF;
  IF canonical IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='ORDER_COUNTRY_INVALID';
  END IF;
  RETURN canonical;
END;
$$;

CREATE OR REPLACE FUNCTION oms.guard_order_ship_to_country()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.ship_to_country IS NOT DISTINCT FROM OLD.ship_to_country THEN RETURN NEW; END IF;
  NEW.ship_to_country := oms.normalize_order_country(NEW.ship_to_country);
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION oms.guard_order_shipping_country()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.shipping_country IS NOT DISTINCT FROM OLD.shipping_country THEN RETURN NEW; END IF;
  NEW.shipping_country := oms.normalize_order_country(NEW.shipping_country);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_country_integrity ON oms.oms_orders;
CREATE TRIGGER order_country_integrity BEFORE INSERT OR UPDATE OF ship_to_country ON oms.oms_orders
FOR EACH ROW EXECUTE FUNCTION oms.guard_order_ship_to_country();
DROP TRIGGER IF EXISTS order_country_integrity ON wms.orders;
CREATE TRIGGER order_country_integrity BEFORE INSERT OR UPDATE OF shipping_country ON wms.orders
FOR EACH ROW EXECUTE FUNCTION oms.guard_order_shipping_country();
DROP TRIGGER IF EXISTS order_country_integrity ON wms.combined_order_groups;
CREATE TRIGGER order_country_integrity BEFORE INSERT OR UPDATE OF shipping_country ON wms.combined_order_groups
FOR EACH ROW EXECUTE FUNCTION oms.guard_order_shipping_country();

CREATE TABLE IF NOT EXISTS oms.order_country_repair_operations (
  operation_key TEXT PRIMARY KEY CHECK (length(btrim(operation_key)) BETWEEN 1 AND 200),
  plan_digest TEXT NOT NULL CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
  actor TEXT NOT NULL CHECK (length(btrim(actor)) BETWEEN 1 AND 255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE(operation_key,actor)
);
CREATE TABLE IF NOT EXISTS oms.order_country_repairs (
  operation_key TEXT NOT NULL,
  table_name TEXT NOT NULL CHECK (table_name IN ('oms.oms_orders','wms.orders','wms.combined_order_groups')),
  row_id BIGINT NOT NULL CHECK (row_id>0),
  before_country TEXT,
  after_country TEXT REFERENCES oms.order_country_codes(code),
  actor TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY(operation_key,table_name,row_id),
  FOREIGN KEY(operation_key,actor) REFERENCES oms.order_country_repair_operations(operation_key,actor),
  CHECK (before_country IS DISTINCT FROM after_country)
);

CREATE OR REPLACE FUNCTION oms.reject_order_country_evidence_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='ORDER_COUNTRY_EVIDENCE_IMMUTABLE';
END;
$$;
DROP TRIGGER IF EXISTS order_country_evidence_immutable ON oms.order_country_codes;
CREATE TRIGGER order_country_evidence_immutable BEFORE UPDATE OR DELETE ON oms.order_country_codes
FOR EACH ROW EXECUTE FUNCTION oms.reject_order_country_evidence_mutation();
DROP TRIGGER IF EXISTS order_country_evidence_no_truncate ON oms.order_country_codes;
CREATE TRIGGER order_country_evidence_no_truncate BEFORE TRUNCATE ON oms.order_country_codes
FOR EACH STATEMENT EXECUTE FUNCTION oms.reject_order_country_evidence_mutation();
DROP TRIGGER IF EXISTS order_country_evidence_immutable ON oms.order_country_aliases;
CREATE TRIGGER order_country_evidence_immutable BEFORE UPDATE OR DELETE ON oms.order_country_aliases
FOR EACH ROW EXECUTE FUNCTION oms.reject_order_country_evidence_mutation();
DROP TRIGGER IF EXISTS order_country_evidence_no_truncate ON oms.order_country_aliases;
CREATE TRIGGER order_country_evidence_no_truncate BEFORE TRUNCATE ON oms.order_country_aliases
FOR EACH STATEMENT EXECUTE FUNCTION oms.reject_order_country_evidence_mutation();
DROP TRIGGER IF EXISTS order_country_evidence_immutable ON oms.order_country_repair_operations;
CREATE TRIGGER order_country_evidence_immutable BEFORE UPDATE OR DELETE ON oms.order_country_repair_operations
FOR EACH ROW EXECUTE FUNCTION oms.reject_order_country_evidence_mutation();
DROP TRIGGER IF EXISTS order_country_evidence_no_truncate ON oms.order_country_repair_operations;
CREATE TRIGGER order_country_evidence_no_truncate BEFORE TRUNCATE ON oms.order_country_repair_operations
FOR EACH STATEMENT EXECUTE FUNCTION oms.reject_order_country_evidence_mutation();
DROP TRIGGER IF EXISTS order_country_evidence_immutable ON oms.order_country_repairs;
CREATE TRIGGER order_country_evidence_immutable BEFORE UPDATE OR DELETE ON oms.order_country_repairs
FOR EACH ROW EXECUTE FUNCTION oms.reject_order_country_evidence_mutation();
DROP TRIGGER IF EXISTS order_country_evidence_no_truncate ON oms.order_country_repairs;
CREATE TRIGGER order_country_evidence_no_truncate BEFORE TRUNCATE ON oms.order_country_repairs
FOR EACH STATEMENT EXECUTE FUNCTION oms.reject_order_country_evidence_mutation();
