-- Mark Database Schema
-- PostgreSQL schema for on-demand rebalancing system

-- Extension for UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Earmarks table: Primary storage for earmark data
CREATE TABLE earmarks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoiceId TEXT NOT NULL,
    destinationChainId INTEGER NOT NULL,
    tickerHash TEXT NOT NULL,
    invoiceAmount NUMERIC(20, 8) NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Rebalance operations table: Individual rebalancing operations linked to earmarks
CREATE TABLE rebalance_operations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    earmarkId UUID NOT NULL REFERENCES earmarks(id) ON DELETE CASCADE,
    originChainId INTEGER NOT NULL,
    destinationChainId INTEGER NOT NULL,
    tickerHash TEXT NOT NULL,
    amount NUMERIC(20, 8) NOT NULL,
    slippage NUMERIC(5, 4) NOT NULL DEFAULT 0.005,
    status TEXT NOT NULL DEFAULT 'pending',
    txHashes JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Earmark audit log table: Complete audit trail of all earmark state changes
CREATE TABLE earmark_audit_log (
    id SERIAL PRIMARY KEY,
    earmarkId UUID NOT NULL REFERENCES earmarks(id) ON DELETE CASCADE,
    operation TEXT NOT NULL,
    previous_status TEXT,
    new_status TEXT,
    details JSONB DEFAULT '{}',
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance optimization
CREATE INDEX idx_earmarks_invoiceId ON earmarks(invoiceId);
CREATE INDEX idx_earmarks_chain_tickerHash ON earmarks(destinationChainId, tickerHash);
CREATE INDEX idx_earmarks_status ON earmarks(status);
CREATE INDEX idx_earmarks_status_chain ON earmarks(status, destinationChainId);
CREATE INDEX idx_earmarks_created_at ON earmarks(created_at);

CREATE INDEX idx_rebalance_operations_earmarkId ON rebalance_operations(earmarkId);
CREATE INDEX idx_rebalance_operations_status ON rebalance_operations(status);
CREATE INDEX idx_rebalance_operations_origin_chain ON rebalance_operations(originChainId);
CREATE INDEX idx_rebalance_operations_destination_chain ON rebalance_operations(destinationChainId);

CREATE INDEX idx_audit_log_earmarkId ON earmark_audit_log(earmarkId);
CREATE INDEX idx_audit_log_timestamp ON earmark_audit_log(timestamp);
CREATE INDEX idx_audit_log_operation ON earmark_audit_log(operation);

-- Updated at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';
CREATE TRIGGER update_earmarks_updated_at
    BEFORE UPDATE ON earmarks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_rebalance_operations_updated_at
    BEFORE UPDATE ON rebalance_operations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Comments for documentation
COMMENT ON TABLE earmarks IS 'Primary storage for invoice earmarks waiting for rebalancing completion';
COMMENT ON TABLE rebalance_operations IS 'Individual rebalancing operations that fulfill earmarks';
COMMENT ON TABLE earmark_audit_log IS 'Audit trail of all earmark state changes and operations';

COMMENT ON COLUMN earmarks.invoiceId IS 'External invoice identifier from the invoice processing system';
COMMENT ON COLUMN earmarks.destinationChainId IS 'Chain ID where funds need to be available for invoice payment';
COMMENT ON COLUMN earmarks.tickerHash IS 'Token tickerHash (e.g., USDC, ETH) required for invoice payment';
COMMENT ON COLUMN earmarks.invoiceAmount IS 'Amount of tokens required for invoice payment';
COMMENT ON COLUMN earmarks.status IS 'Earmark status: pending, in_progress, completed, failed, cancelled';

COMMENT ON COLUMN rebalance_operations.earmarkId IS 'Foreign key to the earmark this operation fulfills';
COMMENT ON COLUMN rebalance_operations.originChainId IS 'Source chain ID where funds are being moved from';
COMMENT ON COLUMN rebalance_operations.destinationChainId IS 'Target chain ID where funds are being moved to';
COMMENT ON COLUMN rebalance_operations.amount IS 'Amount of tokens being rebalanced';
COMMENT ON COLUMN rebalance_operations.txHashes IS 'Transaction hashes for cross-chain operations stored as JSON';
