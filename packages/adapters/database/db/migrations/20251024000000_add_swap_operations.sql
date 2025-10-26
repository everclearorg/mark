-- migrate:up

-- Add swap_operations table for CEX swap tracking
CREATE TABLE swap_operations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rebalance_operation_id UUID NOT NULL REFERENCES rebalance_operations(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  from_asset TEXT NOT NULL,
  to_asset TEXT NOT NULL,
  from_amount TEXT NOT NULL,
  to_amount TEXT NOT NULL,
  expected_rate TEXT NOT NULL,
  actual_rate TEXT,
  quote_id TEXT,
  order_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending_deposit', 'deposit_confirmed', 'processing', 'completed', 'failed', 'recovering')),
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Indexes for swap operations
CREATE INDEX idx_swap_operations_rebalance_op ON swap_operations(rebalance_operation_id);
CREATE INDEX idx_swap_operations_status ON swap_operations(status) WHERE status IN ('pending_deposit', 'deposit_confirmed', 'processing', 'recovering');
CREATE INDEX idx_swap_operations_order_id ON swap_operations(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX idx_swap_operations_platform ON swap_operations(platform);
CREATE INDEX idx_swap_operations_created_at ON swap_operations(created_at);

-- Add operation_type to rebalance_operations to distinguish bridge vs swap_and_bridge
ALTER TABLE rebalance_operations
ADD COLUMN operation_type TEXT DEFAULT 'bridge' CHECK (operation_type IN ('bridge', 'swap_and_bridge'));

-- Trigger for swap_operations updated_at
CREATE TRIGGER update_swap_operations_updated_at
    BEFORE UPDATE ON swap_operations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Comments for documentation
COMMENT ON TABLE swap_operations IS 'Tracks CEX swap operations for cross-asset rebalancing (deposit → swap → withdraw flow)';
COMMENT ON COLUMN swap_operations.rebalance_operation_id IS 'Parent rebalance operation that initiated this swap';
COMMENT ON COLUMN swap_operations.platform IS 'CEX platform (e.g., binance, kraken)';
COMMENT ON COLUMN swap_operations.from_asset IS 'Origin asset symbol (e.g., USDT)';
COMMENT ON COLUMN swap_operations.to_asset IS 'Destination asset symbol (e.g., USDC)';
COMMENT ON COLUMN swap_operations.from_amount IS 'Amount of origin asset (in native units)';
COMMENT ON COLUMN swap_operations.to_amount IS 'Expected amount of destination asset (in native units)';
COMMENT ON COLUMN swap_operations.expected_rate IS 'Expected conversion rate (18 decimals)';
COMMENT ON COLUMN swap_operations.actual_rate IS 'Actual conversion rate after execution (18 decimals)';
COMMENT ON COLUMN swap_operations.quote_id IS 'CEX quote identifier';
COMMENT ON COLUMN swap_operations.order_id IS 'CEX order identifier after execution';
COMMENT ON COLUMN swap_operations.status IS 'Swap lifecycle: pending_deposit → deposit_confirmed → processing → completed/failed/recovering';
COMMENT ON COLUMN swap_operations.metadata IS 'Additional swap-specific data (slippage limits, chain IDs, etc.)';

COMMENT ON COLUMN rebalance_operations.operation_type IS 'Type of operation: bridge (normal) or swap_and_bridge (CEX swap)';

-- migrate:down

-- Drop trigger
DROP TRIGGER IF EXISTS update_swap_operations_updated_at ON swap_operations;

-- Drop column from rebalance_operations
ALTER TABLE rebalance_operations DROP COLUMN IF EXISTS operation_type;

-- Drop swap_operations table
DROP TABLE IF EXISTS swap_operations;
