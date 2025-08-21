-- migrate:up

-- Extension for UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Earmarks table: Primary storage for earmark data
CREATE TABLE earmarks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    "invoiceId" TEXT NOT NULL,
    "designatedPurchaseChain" INTEGER NOT NULL,
    "tickerHash" TEXT NOT NULL,
    "minAmount" TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT earmark_status_check CHECK (status IN ('pending', 'ready', 'completed', 'cancelled'))
);

-- Rebalance operations table: Individual rebalancing operations linked to earmarks
CREATE TABLE rebalance_operations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    "earmarkId" UUID REFERENCES earmarks(id) ON DELETE CASCADE,
    "originChainId" INTEGER NOT NULL,
    "destinationChainId" INTEGER NOT NULL,
    "tickerHash" TEXT NOT NULL,
    amount TEXT NOT NULL,
    slippage INTEGER NOT NULL,
    bridge TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT rebalance_operation_status_check CHECK (status IN ('pending', 'awaiting_callback', 'completed', 'expired'))
);

-- Unique constraint for invoiceId
ALTER TABLE earmarks ADD CONSTRAINT unique_invoice_id UNIQUE ("invoiceId");

-- Indexes for performance optimization
CREATE INDEX idx_earmarks_invoiceId ON earmarks("invoiceId");
CREATE INDEX idx_earmarks_chain_tickerHash ON earmarks("designatedPurchaseChain", "tickerHash");
CREATE INDEX idx_earmarks_status ON earmarks(status);
CREATE INDEX idx_earmarks_status_chain ON earmarks(status, "designatedPurchaseChain");
CREATE INDEX idx_earmarks_created_at ON earmarks("createdAt");

CREATE INDEX idx_rebalance_operations_earmarkId ON rebalance_operations("earmarkId");
CREATE INDEX idx_rebalance_operations_status ON rebalance_operations(status);
CREATE INDEX idx_rebalance_operations_origin_chain ON rebalance_operations("originChainId");
CREATE INDEX idx_rebalance_operations_destination_chain ON rebalance_operations("destinationChainId");

-- Updated at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW."updatedAt" = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers to automatically update updatedAt columns
CREATE TRIGGER update_earmarks_updated_at
    BEFORE UPDATE ON earmarks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_rebalance_operations_updated_at
    BEFORE UPDATE ON rebalance_operations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Transactions table: General purpose transaction tracking
CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rebalance_operation_id UUID REFERENCES rebalance_operations(id) ON DELETE SET NULL,
    transaction_hash TEXT NOT NULL,
    chain_id TEXT NOT NULL,
    cumulative_gas_used TEXT,
    effective_gas_price TEXT,
    sender TEXT,
    reason TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT unique_tx_chain UNIQUE (transaction_hash, chain_id)
);

-- Trigger for transactions updated_at
CREATE TRIGGER update_transactions_updated_at
    BEFORE UPDATE ON transactions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Indexes for transactions table (optimized for joins and common queries)
CREATE INDEX idx_transactions_hash_chain ON transactions(transaction_hash, chain_id);
CREATE INDEX idx_transactions_rebalance_op ON transactions(rebalance_operation_id) WHERE rebalance_operation_id IS NOT NULL;
CREATE INDEX idx_transactions_chain ON transactions(chain_id);
CREATE INDEX idx_transactions_reason ON transactions(reason) WHERE reason IS NOT NULL;
CREATE INDEX idx_transactions_created_at ON transactions(created_at);
CREATE INDEX idx_transactions_rebalance_created ON transactions(rebalance_operation_id, created_at) WHERE rebalance_operation_id IS NOT NULL;

-- Comments for documentation
COMMENT ON TABLE earmarks IS 'Primary storage for invoice earmarks waiting for rebalancing completion';
COMMENT ON TABLE rebalance_operations IS 'Individual rebalancing operations that fulfill earmarks';
COMMENT ON COLUMN earmarks."invoiceId" IS 'External invoice identifier from the invoice processing system';
COMMENT ON COLUMN earmarks."designatedPurchaseChain" IS 'Designated chain ID for purchasing this invoice - the invoice destination chain that Mark has identified as the target for fund aggregation';
COMMENT ON COLUMN earmarks."tickerHash" IS 'Token tickerHash (e.g., USDC, ETH) required for invoice payment';
COMMENT ON COLUMN earmarks."minAmount" IS 'Minimum amount of tokens required for invoice payment on the designated chain (stored as string to preserve precision)';
COMMENT ON COLUMN earmarks.status IS 'Earmark status: pending, ready, completed, cancelled (enforced by CHECK constraint)';

COMMENT ON COLUMN rebalance_operations."earmarkId" IS 'Foreign key to the earmark this operation fulfills (NULL for regular rebalancing)';
COMMENT ON COLUMN rebalance_operations."originChainId" IS 'Source chain ID where funds are being moved from';
COMMENT ON COLUMN rebalance_operations."destinationChainId" IS 'Target chain ID where funds are being moved to';
COMMENT ON COLUMN rebalance_operations.amount IS 'Amount of tokens being rebalanced (stored as string to preserve precision)';
COMMENT ON COLUMN rebalance_operations.slippage IS 'Expected slippage in basis points (e.g., 30 = 0.3%)';
COMMENT ON COLUMN rebalance_operations.bridge IS 'Bridge adapter type used for this operation (e.g., across, binance)';
COMMENT ON COLUMN rebalance_operations.status IS 'Operation status: pending, awaiting_callback, completed, expired (enforced by CHECK constraint)';

COMMENT ON TABLE transactions IS 'General purpose transaction tracking for all on-chain activity';
COMMENT ON COLUMN transactions.rebalance_operation_id IS 'Optional reference to associated rebalance operation (NULL for standalone transactions)';
COMMENT ON COLUMN transactions.transaction_hash IS 'On-chain transaction hash';
COMMENT ON COLUMN transactions.chain_id IS 'Chain ID where transaction occurred (stored as text for large chain IDs)';
COMMENT ON COLUMN transactions.cumulative_gas_used IS 'Total gas used by transaction (stored as text for precision)';
COMMENT ON COLUMN transactions.effective_gas_price IS 'Effective gas price paid (stored as text for precision)';
COMMENT ON COLUMN transactions.sender IS 'Transaction sender address';
COMMENT ON COLUMN transactions.reason IS 'Transaction purpose/category (e.g., deposit, withdrawal, bridge, etc.)';
COMMENT ON COLUMN transactions.metadata IS 'Additional transaction-specific data stored as JSON';

-- migrate:down

-- Drop triggers first
DROP TRIGGER IF EXISTS update_transactions_updated_at ON transactions;
DROP TRIGGER IF EXISTS update_rebalance_operations_updated_at ON rebalance_operations;
DROP TRIGGER IF EXISTS update_earmarks_updated_at ON earmarks;

-- Drop trigger function
DROP FUNCTION IF EXISTS update_updated_at_column();

-- Drop tables in reverse dependency order (transactions first due to FK reference)
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS rebalance_operations;
DROP TABLE IF EXISTS earmarks;

-- Note: We don't drop the uuid-ossp extension as it might be used by other parts of the database
