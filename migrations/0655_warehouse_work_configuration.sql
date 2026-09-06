-- Draft station/workflow configuration only: no inventory, channel or execution activation.
CREATE TABLE warehouse.work_configuration_revisions (
  warehouse_id integer NOT NULL REFERENCES warehouse.warehouses(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  command_id uuid NOT NULL,
  request_body jsonb NOT NULL CHECK (jsonb_typeof(request_body) = 'object'),
  configuration jsonb NOT NULL CHECK (jsonb_typeof(configuration) = 'object'),
  before_configuration jsonb NOT NULL CHECK (jsonb_typeof(before_configuration) = 'object'),
  access_changed boolean NOT NULL,
  actor_id varchar NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  reason varchar(500) NOT NULL CHECK (length(btrim(reason)) >= 5),
  saved_at timestamptz NOT NULL,
  PRIMARY KEY (warehouse_id, revision),
  UNIQUE (warehouse_id, command_id)
);

CREATE TABLE warehouse.work_stations (
  id uuid PRIMARY KEY,
  warehouse_id integer NOT NULL REFERENCES warehouse.warehouses(id) ON DELETE RESTRICT,
  code varchar(30) NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]*$'),
  name varchar(100) NOT NULL CHECK (length(btrim(name)) > 0),
  location_id integer NOT NULL REFERENCES warehouse.warehouse_locations(id) ON DELETE RESTRICT,
  capabilities jsonb NOT NULL CHECK (jsonb_typeof(capabilities) = 'array' AND jsonb_array_length(capabilities) > 0),
  enabled boolean NOT NULL,
  configuration_revision integer NOT NULL,
  UNIQUE (warehouse_id, code) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (warehouse_id, id),
  FOREIGN KEY (warehouse_id, configuration_revision)
    REFERENCES warehouse.work_configuration_revisions(warehouse_id, revision) ON DELETE RESTRICT
);

CREATE TABLE warehouse.work_access_scopes (
  warehouse_id integer NOT NULL REFERENCES warehouse.warehouses(id) ON DELETE RESTRICT,
  user_id varchar NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  capabilities jsonb NOT NULL CHECK (jsonb_typeof(capabilities) = 'array' AND jsonb_array_length(capabilities) > 0),
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object' AND scope ? 'kind' AND scope->>'kind' IS NOT NULL AND scope->>'kind' IN ('warehouse', 'zone', 'stations')),
  configuration_revision integer NOT NULL,
  PRIMARY KEY (warehouse_id, user_id),
  FOREIGN KEY (warehouse_id, configuration_revision)
    REFERENCES warehouse.work_configuration_revisions(warehouse_id, revision) ON DELETE RESTRICT
);

CREATE FUNCTION warehouse.reject_work_revision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Warehouse work configuration history is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER work_configuration_revisions_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON warehouse.work_configuration_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION warehouse.reject_work_revision_mutation();

-- An FK protects existence; this trigger also prevents cross-warehouse station locations.
CREATE FUNCTION warehouse.validate_work_station_location() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE location_warehouse_id integer;
BEGIN
  SELECT warehouse_id INTO location_warehouse_id FROM warehouse.warehouse_locations
    WHERE id = NEW.location_id FOR SHARE;
  IF location_warehouse_id IS DISTINCT FROM NEW.warehouse_id THEN
    RAISE EXCEPTION 'Station location must belong to its warehouse' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.warehouse_id <> OLD.warehouse_id) THEN
    RAISE EXCEPTION 'Station identity cannot move between warehouses' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER work_station_location_check BEFORE INSERT OR UPDATE ON warehouse.work_stations
  FOR EACH ROW EXECUTE FUNCTION warehouse.validate_work_station_location();

CREATE FUNCTION warehouse.protect_work_station_location() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id AND EXISTS (
    SELECT 1 FROM warehouse.work_stations WHERE location_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'A station location cannot move between warehouses' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER work_station_location_warehouse_immutable BEFORE UPDATE OF warehouse_id ON warehouse.warehouse_locations
  FOR EACH ROW EXECUTE FUNCTION warehouse.protect_work_station_location();
