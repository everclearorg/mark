SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_actions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    description text,
    rebalance_paused boolean DEFAULT false,
    purchase_paused boolean DEFAULT false,
    ondemand_rebalance_paused boolean DEFAULT false
);


--
-- Name: COLUMN admin_actions.ondemand_rebalance_paused; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.admin_actions.ondemand_rebalance_paused IS 'Pause flag for on-demand rebalancing operations triggered by invoice processing';


--
-- Name: cex_withdrawals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cex_withdrawals (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    rebalance_operation_id uuid,
    platform text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: earmarks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.earmarks (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    invoice_id text NOT NULL,
    designated_purchase_chain integer NOT NULL,
    ticker_hash text NOT NULL,
    min_amount text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT earmark_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'completed'::text, 'cancelled'::text, 'failed'::text, 'expired'::text])))
);


--
-- Name: TABLE earmarks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.earmarks IS 'Primary storage for invoice earmarks waiting for rebalancing completion';


--
-- Name: COLUMN earmarks.invoice_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.earmarks.invoice_id IS 'External invoice identifier from the invoice processing system';


--
-- Name: COLUMN earmarks.designated_purchase_chain; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.earmarks.designated_purchase_chain IS 'Designated chain ID for purchasing this invoice - the invoice destination chain that Mark has identified as the target for fund aggregation';


--
-- Name: COLUMN earmarks.ticker_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.earmarks.ticker_hash IS 'Token ticker_hash (e.g., USDC, ETH) required for invoice payment';


--
-- Name: COLUMN earmarks.min_amount; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.earmarks.min_amount IS 'Minimum amount of tokens required for invoice payment on the designated chain (stored as string to preserve precision)';


--
-- Name: COLUMN earmarks.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.earmarks.status IS 'Earmark status: pending, ready, completed, cancelled, failed, expired (enforced by CHECK constraint)';


--
-- Name: rebalance_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rebalance_operations (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    earmark_id uuid,
    origin_chain_id integer NOT NULL,
    destination_chain_id integer NOT NULL,
    ticker_hash text NOT NULL,
    amount text NOT NULL,
    slippage integer NOT NULL,
    bridge text,
    status text DEFAULT 'pending'::text NOT NULL,
    recipient text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    is_orphaned boolean DEFAULT false NOT NULL,
    operation_type text DEFAULT 'bridge'::text,
    CONSTRAINT rebalance_operation_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'awaiting_callback'::text, 'completed'::text, 'expired'::text, 'cancelled'::text]))),
    CONSTRAINT rebalance_operations_operation_type_check CHECK ((operation_type = ANY (ARRAY['bridge'::text, 'swap_and_bridge'::text])))
);


--
-- Name: TABLE rebalance_operations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.rebalance_operations IS 'Individual rebalancing operations that fulfill earmarks';


--
-- Name: COLUMN rebalance_operations.earmark_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.rebalance_operations.earmark_id IS 'Foreign key to the earmark this operation fulfills (NULL for regular rebalancing)';


--
-- Name: COLUMN rebalance_operations.origin_chain_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.rebalance_operations.origin_chain_id IS 'Source chain ID where funds are being moved from';


--
-- Name: COLUMN rebalance_operations.destination_chain_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.rebalance_operations.destination_chain_id IS 'Target chain ID where funds are being moved to';


--
-- Name: COLUMN rebalance_operations.amount; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.rebalance_operations.amount IS 'Amount of tokens being rebalanced (stored as string to preserve precision)';


--
-- Name: COLUMN rebalance_operations.slippage; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.rebalance_operations.slippage IS 'Expected slippage in basis points (e.g., 30 = 0.3%)';


--
-- Name: COLUMN rebalance_operations.bridge; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.rebalance_operations.bridge IS 'Bridge adapter type used for this operation (e.g., across, binance)';


--
-- Name: COLUMN rebalance_operations.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.rebalance_operations.status IS 'Operation status: pending, awaiting_callback, completed, expired, cancelled (enforced by CHECK constraint)';


--
-- Name: COLUMN rebalance_operations.recipient; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.rebalance_operations.recipient IS 'Recipient address for the rebalance operation (destination address on target chain)';


--
-- Name: COLUMN rebalance_operations.is_orphaned; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.rebalance_operations.is_orphaned IS 'Indicates if this operation was orphaned when its associated earmark was cancelled';


--
-- Name: COLUMN rebalance_operations.operation_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.rebalance_operations.operation_type IS 'Type of operation: bridge (normal) or swap_and_bridge (CEX swap)';


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying(128) NOT NULL
);


--
-- Name: swap_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.swap_operations (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    rebalance_operation_id uuid NOT NULL,
    platform text NOT NULL,
    from_asset text NOT NULL,
    to_asset text NOT NULL,
    from_amount text NOT NULL,
    to_amount text NOT NULL,
    expected_rate text NOT NULL,
    actual_rate text,
    quote_id text,
    order_id text,
    status text NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT swap_operations_status_check CHECK ((status = ANY (ARRAY['pending_deposit'::text, 'deposit_confirmed'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'recovering'::text])))
);


--
-- Name: TABLE swap_operations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.swap_operations IS 'Tracks CEX swap operations for cross-asset rebalancing (deposit → swap → withdraw flow)';


--
-- Name: COLUMN swap_operations.rebalance_operation_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.swap_operations.rebalance_operation_id IS 'Parent rebalance operation that initiated this swap';


--
-- Name: COLUMN swap_operations.platform; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.swap_operations.platform IS 'CEX platform (e.g., binance, kraken)';


--
-- Name: COLUMN swap_operations.from_asset; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.swap_operations.from_asset IS 'Origin asset symbol (e.g., USDT)';


--
-- Name: COLUMN swap_operations.to_asset; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.swap_operations.to_asset IS 'Destination asset symbol (e.g., USDC)';


--
-- Name: COLUMN swap_operations.from_amount; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.swap_operations.from_amount IS 'Amount of origin asset (in native units)';


--
-- Name: COLUMN swap_operations.to_amount; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.swap_operations.to_amount IS 'Expected amount of destination asset (in native units)';


--
-- Name: COLUMN swap_operations.expected_rate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.swap_operations.expected_rate IS 'Expected conversion rate (18 decimals)';


--
-- Name: COLUMN swap_operations.actual_rate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.swap_operations.actual_rate IS 'Actual conversion rate after execution (18 decimals)';


--
-- Name: COLUMN swap_operations.quote_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.swap_operations.quote_id IS 'CEX quote identifier';


--
-- Name: COLUMN swap_operations.order_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.swap_operations.order_id IS 'CEX order identifier after execution';


--
-- Name: COLUMN swap_operations.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.swap_operations.status IS 'Swap lifecycle: pending_deposit → deposit_confirmed → processing → completed/failed/recovering';


--
-- Name: COLUMN swap_operations.metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.swap_operations.metadata IS 'Additional swap-specific data (slippage limits, chain IDs, etc.)';


--
-- Name: transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transactions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    rebalance_operation_id uuid,
    transaction_hash text NOT NULL,
    chain_id text NOT NULL,
    cumulative_gas_used text NOT NULL,
    effective_gas_price text NOT NULL,
    "from" text NOT NULL,
    "to" text NOT NULL,
    reason text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE transactions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.transactions IS 'General purpose transaction tracking for all on-chain activity';


--
-- Name: COLUMN transactions.rebalance_operation_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions.rebalance_operation_id IS 'Optional reference to associated rebalance operation (NULL for standalone transactions)';


--
-- Name: COLUMN transactions.transaction_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions.transaction_hash IS 'On-chain transaction hash';


--
-- Name: COLUMN transactions.chain_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions.chain_id IS 'Chain ID where transaction occurred (stored as text for large chain IDs)';


--
-- Name: COLUMN transactions.cumulative_gas_used; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions.cumulative_gas_used IS 'Total gas used by transaction (stored as text for precision)';


--
-- Name: COLUMN transactions.effective_gas_price; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions.effective_gas_price IS 'Effective gas price paid (stored as text for precision)';


--
-- Name: COLUMN transactions."from"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions."from" IS 'Transaction sender address';


--
-- Name: COLUMN transactions."to"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions."to" IS 'Transaction destination address';


--
-- Name: COLUMN transactions.reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions.reason IS 'Transaction purpose/category (e.g., deposit, withdrawal, bridge, etc.)';


--
-- Name: COLUMN transactions.metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions.metadata IS 'Additional transaction-specific data stored as JSON';


--
-- Name: admin_actions admin_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_actions
    ADD CONSTRAINT admin_actions_pkey PRIMARY KEY (id);


--
-- Name: cex_withdrawals cex_withdrawals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cex_withdrawals
    ADD CONSTRAINT cex_withdrawals_pkey PRIMARY KEY (id);


--
-- Name: earmarks earmarks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.earmarks
    ADD CONSTRAINT earmarks_pkey PRIMARY KEY (id);


--
-- Name: rebalance_operations rebalance_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rebalance_operations
    ADD CONSTRAINT rebalance_operations_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: swap_operations swap_operations_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swap_operations
    ADD CONSTRAINT swap_operations_order_id_key UNIQUE (order_id);


--
-- Name: swap_operations swap_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swap_operations
    ADD CONSTRAINT swap_operations_pkey PRIMARY KEY (id);


--
-- Name: transactions transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);


--
-- Name: transactions unique_tx_chain; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT unique_tx_chain UNIQUE (transaction_hash, chain_id);


--
-- Name: idx_earmarks_chain_ticker_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_earmarks_chain_ticker_hash ON public.earmarks USING btree (designated_purchase_chain, ticker_hash);


--
-- Name: idx_earmarks_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_earmarks_created_at ON public.earmarks USING btree (created_at);


--
-- Name: idx_earmarks_invoice_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_earmarks_invoice_id ON public.earmarks USING btree (invoice_id);


--
-- Name: idx_earmarks_invoice_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_earmarks_invoice_status ON public.earmarks USING btree (invoice_id, status);


--
-- Name: idx_earmarks_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_earmarks_status ON public.earmarks USING btree (status);


--
-- Name: idx_earmarks_status_chain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_earmarks_status_chain ON public.earmarks USING btree (status, designated_purchase_chain);


--
-- Name: idx_rebalance_operations_destination_chain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rebalance_operations_destination_chain ON public.rebalance_operations USING btree (destination_chain_id);


--
-- Name: idx_rebalance_operations_earmark_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rebalance_operations_earmark_id ON public.rebalance_operations USING btree (earmark_id);


--
-- Name: idx_rebalance_operations_origin_chain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rebalance_operations_origin_chain ON public.rebalance_operations USING btree (origin_chain_id);


--
-- Name: idx_rebalance_operations_orphaned; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rebalance_operations_orphaned ON public.rebalance_operations USING btree (is_orphaned) WHERE (is_orphaned = true);


--
-- Name: idx_rebalance_operations_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rebalance_operations_recipient ON public.rebalance_operations USING btree (recipient) WHERE (recipient IS NOT NULL);


--
-- Name: idx_rebalance_operations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rebalance_operations_status ON public.rebalance_operations USING btree (status);


--
-- Name: idx_rebalance_operations_status_earmark_dest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rebalance_operations_status_earmark_dest ON public.rebalance_operations USING btree (destination_chain_id, status, earmark_id) WHERE (earmark_id IS NOT NULL);


--
-- Name: idx_swap_operations_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_swap_operations_created_at ON public.swap_operations USING btree (created_at);


--
-- Name: idx_swap_operations_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_swap_operations_order_id ON public.swap_operations USING btree (order_id) WHERE (order_id IS NOT NULL);


--
-- Name: idx_swap_operations_platform; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_swap_operations_platform ON public.swap_operations USING btree (platform);


--
-- Name: idx_swap_operations_rebalance_op; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_swap_operations_rebalance_op ON public.swap_operations USING btree (rebalance_operation_id);


--
-- Name: idx_swap_operations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_swap_operations_status ON public.swap_operations USING btree (status) WHERE (status = ANY (ARRAY['pending_deposit'::text, 'deposit_confirmed'::text, 'processing'::text, 'recovering'::text]));


--
-- Name: idx_transactions_chain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_chain ON public.transactions USING btree (chain_id);


--
-- Name: idx_transactions_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_created_at ON public.transactions USING btree (created_at);


--
-- Name: idx_transactions_hash_chain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_hash_chain ON public.transactions USING btree (transaction_hash, chain_id);


--
-- Name: idx_transactions_reason; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_reason ON public.transactions USING btree (reason) WHERE (reason IS NOT NULL);


--
-- Name: idx_transactions_rebalance_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_rebalance_created ON public.transactions USING btree (rebalance_operation_id, created_at) WHERE (rebalance_operation_id IS NOT NULL);


--
-- Name: idx_transactions_rebalance_op; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_rebalance_op ON public.transactions USING btree (rebalance_operation_id) WHERE (rebalance_operation_id IS NOT NULL);


--
-- Name: unique_active_earmark_per_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX unique_active_earmark_per_invoice ON public.earmarks USING btree (invoice_id) WHERE (status = ANY (ARRAY['pending'::text, 'ready'::text]));


--
-- Name: admin_actions update_admin_actions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_admin_actions_updated_at BEFORE UPDATE ON public.admin_actions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: earmarks update_earmarks_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_earmarks_updated_at BEFORE UPDATE ON public.earmarks FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: rebalance_operations update_rebalance_operations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_rebalance_operations_updated_at BEFORE UPDATE ON public.rebalance_operations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: swap_operations update_swap_operations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_swap_operations_updated_at BEFORE UPDATE ON public.swap_operations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: transactions update_transactions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_transactions_updated_at BEFORE UPDATE ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: cex_withdrawals cex_withdrawals_rebalance_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cex_withdrawals
    ADD CONSTRAINT cex_withdrawals_rebalance_operation_id_fkey FOREIGN KEY (rebalance_operation_id) REFERENCES public.rebalance_operations(id) ON DELETE CASCADE;


--
-- Name: rebalance_operations rebalance_operations_earmark_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rebalance_operations
    ADD CONSTRAINT rebalance_operations_earmark_id_fkey FOREIGN KEY (earmark_id) REFERENCES public.earmarks(id) ON DELETE CASCADE;


--
-- Name: swap_operations swap_operations_rebalance_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swap_operations
    ADD CONSTRAINT swap_operations_rebalance_operation_id_fkey FOREIGN KEY (rebalance_operation_id) REFERENCES public.rebalance_operations(id) ON DELETE CASCADE;


--
-- Name: transactions transactions_rebalance_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_rebalance_operation_id_fkey FOREIGN KEY (rebalance_operation_id) REFERENCES public.rebalance_operations(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--


--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('20250722213145'),
    ('20250902175116'),
    ('20250903171904'),
    ('20250911'),
    ('20250925232303'),
    ('20251016000000'),
    ('20251021000000'),
    ('20251024000000');
