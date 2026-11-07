import { readFileSync } from "node:fs";
const credentialStateSql=readFileSync(new URL("../../../../../migrations/900000056000020040001_staff_credential_state.sql",import.meta.url),"utf8");
/**
 * Reduced current Identity and audit contracts for isolated command tests.
 * This is query/transaction/locking evidence, not production migration, grants,
 * audit-retention protection, or a bootstrap of any deployed account.
 */
export const identityAdministrationFixtureSql = `
  CREATE SCHEMA identity;
  CREATE TABLE identity.users (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid(), username text NOT NULL UNIQUE,
    password text NOT NULL, role varchar(20) NOT NULL DEFAULT 'picker', display_name text,
    active integer NOT NULL DEFAULT 1, created_at timestamp NOT NULL DEFAULT now(), last_login_at timestamp
  );
  ${credentialStateSql}
  CREATE TABLE identity.auth_roles (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name varchar(100) NOT NULL UNIQUE,
    description text, is_system integer NOT NULL DEFAULT 0,
    created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
  );
  CREATE TABLE identity.auth_permissions (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, resource varchar(50) NOT NULL,
    action varchar(50) NOT NULL, description text, category varchar(50) NOT NULL,
    created_at timestamp NOT NULL DEFAULT now(), UNIQUE(resource,action)
  );
  CREATE TABLE identity.auth_role_permissions (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role_id integer NOT NULL REFERENCES identity.auth_roles(id) ON DELETE CASCADE,
    permission_id integer NOT NULL REFERENCES identity.auth_permissions(id) ON DELETE CASCADE,
    constraints jsonb, created_at timestamp NOT NULL DEFAULT now(), UNIQUE(role_id,permission_id)
  );
  CREATE TABLE identity.auth_user_roles (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id varchar NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    role_id integer NOT NULL REFERENCES identity.auth_roles(id) ON DELETE CASCADE,
    created_at timestamp NOT NULL DEFAULT now(), UNIQUE(user_id,role_id)
  );
  CREATE TABLE public.audit_events (
    id bigserial PRIMARY KEY, timestamp timestamptz NOT NULL DEFAULT now(),
    level text NOT NULL DEFAULT 'AUDIT', actor text NOT NULL, action text NOT NULL,
    target text, changes jsonb, context jsonb
  );
  INSERT INTO identity.auth_permissions(resource,action,category) VALUES
    ('users','view','users'), ('users','create','users'), ('users','edit','users'),
    ('users','manage_roles','users'), ('users','reset_password','users'), ('users','reset_privileged_password','users'),
    ('warehouse_work','manage_access','users'), ('roles','view','users'), ('roles','create','users'),
    ('roles','edit','users'), ('roles','delete','users'),
    ('inventory','view','inventory'), ('orders','view','orders');
`;
