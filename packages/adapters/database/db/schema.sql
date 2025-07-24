SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: audit_earmark_changes(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_earmark_changes() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        INSERT INTO earmark_audit_log (earmark_id, previous_state, new_state, changed_by, changed_at)
        VALUES (
            NEW.id,
            to_jsonb(OLD),
            to_jsonb(NEW),
            current_user,
            NOW()
        );
        RETURN NEW;
    ELSIF TG_OP = 'INSERT' THEN
        INSERT INTO earmark_audit_log (earmark_id, previous_state, new_state, changed_by, changed_at)
        VALUES (
            NEW.id,
            NULL,
            to_jsonb(NEW),
            current_user,
            NOW()
        );
        RETURN NEW;
    END IF;
    RETURN NULL;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: balance_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.balance_snapshots (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    chain_id integer NOT NULL,
    asset character varying NOT NULL,
    balance numeric(36,18) NOT NULL,
    "timestamp" timestamp with time zone DEFAULT now(),
    block_number bigint,
    metadata jsonb DEFAULT '{}'::jsonb
);


--
-- Name: rebalance_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rebalance_actions (
    id character varying NOT NULL,
    bridge character varying NOT NULL,
    amount character varying NOT NULL,
    origin_chain_id integer NOT NULL,
    destination_chain_id integer NOT NULL,
    asset character varying NOT NULL,
    transaction_hash character varying NOT NULL,
    recipient character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: system_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_config (
    key character varying NOT NULL,
    value character varying NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: balance_snapshots balance_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.balance_snapshots
    ADD CONSTRAINT balance_snapshots_pkey PRIMARY KEY (id);


--
-- Name: rebalance_actions rebalance_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rebalance_actions
    ADD CONSTRAINT rebalance_actions_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: system_config system_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_config
    ADD CONSTRAINT system_config_pkey PRIMARY KEY (key);


--
-- Name: idx_balance_snapshots_block_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_balance_snapshots_block_number ON public.balance_snapshots USING btree (block_number);


--
-- Name: idx_balance_snapshots_chain_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_balance_snapshots_chain_asset ON public.balance_snapshots USING btree (chain_id, asset);


--
-- Name: idx_balance_snapshots_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_balance_snapshots_timestamp ON public.balance_snapshots USING btree ("timestamp");


--
-- Name: idx_rebalance_actions_bridge; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rebalance_actions_bridge ON public.rebalance_actions USING btree (bridge);


--
-- Name: idx_rebalance_actions_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rebalance_actions_created_at ON public.rebalance_actions USING btree (created_at);


--
-- Name: idx_rebalance_actions_route; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rebalance_actions_route ON public.rebalance_actions USING btree (destination_chain_id, origin_chain_id, asset);


--
-- Name: idx_rebalance_actions_transaction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rebalance_actions_transaction ON public.rebalance_actions USING btree (transaction_hash);


--
-- Name: idx_system_config_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_config_updated_at ON public.system_config USING btree (updated_at);


--
-- PostgreSQL database dump complete
--


--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('20250122051500'),
    ('20250722213145');
