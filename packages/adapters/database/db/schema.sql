\restrict KwPnGiyKX5vXPuHqy0GyYKfasryJZDONhYylXOM9wNInP1HEMzDEwOFKZigeW2Y

-- Dumped from database version 15.14
-- Dumped by pg_dump version 15.14 (Homebrew)

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
    NEW."updatedAt" = NOW();
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: earmarks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.earmarks (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "invoiceId" text NOT NULL,
    "designatedPurchaseChain" integer NOT NULL,
    "tickerHash" text NOT NULL,
    "minAmount" text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now(),
    "updatedAt" timestamp with time zone DEFAULT now(),
    CONSTRAINT earmark_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'completed'::text, 'cancelled'::text])))
);


--
-- Name: TABLE earmarks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.earmarks IS 'Primary storage for invoice earmarks waiting for rebalancing completion';


--
-- Name: COLUMN earmarks."invoiceId"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.earmarks."invoiceId" IS 'External invoice identifier from the invoice processing system';


--
-- Name: COLUMN earmarks."designatedPurchaseChain"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.earmarks."designatedPurchaseChain" IS 'Designated chain ID for purchasing this invoice - the invoice destination chain that Mark has identified as the target for fund aggregation';


--
-- Name: COLUMN earmarks."tickerHash"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.earmarks."tickerHash" IS 'Token tickerHash (e.g., USDC, ETH) required for invoice payment';


--
-- Name: COLUMN earmarks."minAmount"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.earmarks."minAmount" IS 'Minimum amount of tokens required for invoice payment on the designated chain (stored as string to preserve precision)';


--
-- Name: COLUMN earmarks.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.earmarks.status IS 'Earmark status: pending, ready, completed, cancelled (enforced by CHECK constraint)';


--
-- Name: rebalance_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rebalance_operations (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "earmarkId" uuid,
    "originChainId" integer NOT NULL,
    "destinationChainId" integer NOT NULL,
    "tickerHash" text NOT NULL,
    amount text NOT NULL,
    slippage integer NOT NULL,
    bridge text,
    status text DEFAULT 'pending'::text NOT NULL,
    "txHashes" jsonb DEFAULT '{}'::jsonb,
    "createdAt" timestamp with time zone DEFAULT now(),
    "updatedAt" timestamp with time zone DEFAULT now(),
    CONSTRAINT rebalance_operation_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'awaiting_callback'::text, 'completed'::text, 'expired'::text])))
);


--
-- Name: TABLE rebalance_operations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.rebalance_operations IS 'Individual rebalancing operations that fulfill earmarks';


--
-- Name: COLUMN rebalance_operations."earmarkId"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.rebalance_operations."earmarkId" IS 'Foreign key to the earmark this operation fulfills (NULL for regular rebalancing)';


--
-- Name: COLUMN rebalance_operations."originChainId"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.rebalance_operations."originChainId" IS 'Source chain ID where funds are being moved from';


--
-- Name: COLUMN rebalance_operations."destinationChainId"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.rebalance_operations."destinationChainId" IS 'Target chain ID where funds are being moved to';


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

COMMENT ON COLUMN public.rebalance_operations.status IS 'Operation status: pending, awaiting_callback, completed, expired (enforced by CHECK constraint)';


--
-- Name: COLUMN rebalance_operations."txHashes"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.rebalance_operations."txHashes" IS 'Transaction hashes for cross-chain operations stored as JSON';


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transactions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    rebalance_operation_id uuid,
    transaction_hash text NOT NULL,
    chain_id text NOT NULL,
    cumulative_gas_used text,
    effective_gas_price text,
    sender text,
    reason text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
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
-- Name: COLUMN transactions.sender; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions.sender IS 'Transaction sender address';


--
-- Name: COLUMN transactions.reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions.reason IS 'Transaction purpose/category (e.g., deposit, withdrawal, bridge, etc.)';


--
-- Name: COLUMN transactions.metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transactions.metadata IS 'Additional transaction-specific data stored as JSON';


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
-- Name: transactions transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);


--
-- Name: earmarks unique_invoice_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.earmarks
    ADD CONSTRAINT unique_invoice_id UNIQUE ("invoiceId");


--
-- Name: transactions unique_tx_chain; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT unique_tx_chain UNIQUE (transaction_hash, chain_id);


--
-- Name: idx_earmarks_chain_tickerhash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_earmarks_chain_tickerhash ON public.earmarks USING btree ("designatedPurchaseChain", "tickerHash");


--
-- Name: idx_earmarks_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_earmarks_created_at ON public.earmarks USING btree ("createdAt");


--
-- Name: idx_earmarks_invoiceid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_earmarks_invoiceid ON public.earmarks USING btree ("invoiceId");


--
-- Name: idx_earmarks_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_earmarks_status ON public.earmarks USING btree (status);


--
-- Name: idx_earmarks_status_chain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_earmarks_status_chain ON public.earmarks USING btree (status, "designatedPurchaseChain");


--
-- Name: idx_rebalance_operations_destination_chain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rebalance_operations_destination_chain ON public.rebalance_operations USING btree ("destinationChainId");


--
-- Name: idx_rebalance_operations_earmarkid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rebalance_operations_earmarkid ON public.rebalance_operations USING btree ("earmarkId");


--
-- Name: idx_rebalance_operations_origin_chain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rebalance_operations_origin_chain ON public.rebalance_operations USING btree ("originChainId");


--
-- Name: idx_rebalance_operations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rebalance_operations_status ON public.rebalance_operations USING btree (status);


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
-- Name: earmarks update_earmarks_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_earmarks_updated_at BEFORE UPDATE ON public.earmarks FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: rebalance_operations update_rebalance_operations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_rebalance_operations_updated_at BEFORE UPDATE ON public.rebalance_operations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: transactions update_transactions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_transactions_updated_at BEFORE UPDATE ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: rebalance_operations rebalance_operations_earmarkId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rebalance_operations
    ADD CONSTRAINT "rebalance_operations_earmarkId_fkey" FOREIGN KEY ("earmarkId") REFERENCES public.earmarks(id) ON DELETE CASCADE;


--
-- Name: transactions transactions_rebalance_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_rebalance_operation_id_fkey FOREIGN KEY (rebalance_operation_id) REFERENCES public.rebalance_operations(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

\unrestrict KwPnGiyKX5vXPuHqy0GyYKfasryJZDONhYylXOM9wNInP1HEMzDEwOFKZigeW2Y


--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('20250722213145');
