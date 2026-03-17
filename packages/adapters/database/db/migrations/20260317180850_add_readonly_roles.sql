-- migrate:up

-- Create or normalize query role (nologin, used for grouping read permissions)
DO $do$ BEGIN IF EXISTS (
  SELECT
  FROM pg_catalog.pg_roles
  WHERE rolname = 'query'
) THEN
  ALTER ROLE query WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ELSE
  create role query nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
END IF;
END $do$;

-- Create or normalize reader role (login, inherits query permissions)
DO $do$ BEGIN IF EXISTS (
  SELECT
  FROM pg_catalog.pg_roles
  WHERE rolname = 'reader'
) THEN
  ALTER ROLE reader WITH INHERIT LOGIN PASSWORD '3eadooor' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ELSE
  create role reader inherit login password '3eadooor' nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
END IF;
END $do$;

-- Strip any broader privileges from previous manual grants before granting read-only access.
REVOKE ALL PRIVILEGES ON DATABASE markdb FROM query;
REVOKE ALL PRIVILEGES ON DATABASE markdb FROM reader;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM query;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM reader;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM query;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM reader;

GRANT CONNECT ON DATABASE markdb TO query;
grant usage on schema public to query;
grant select on public.admin_actions to query;
grant select on public.cex_withdrawals to query;
grant select on public.earmarks to query;
grant select on public.rebalance_operations to query;
grant select on public.schema_migrations to query;
grant select on public.transactions to query;

grant query to reader;

-- migrate:down

-- Revoke from reader
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM reader;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM reader;
REVOKE ALL PRIVILEGES ON DATABASE markdb FROM reader;
REVOKE query FROM reader;

-- Revoke from query
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM query;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM query;
REVOKE ALL PRIVILEGES ON DATABASE markdb FROM query;

DROP ROLE IF EXISTS reader;
DROP ROLE IF EXISTS query;

