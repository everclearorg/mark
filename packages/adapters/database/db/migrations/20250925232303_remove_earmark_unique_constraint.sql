-- migrate:up
-- Remove the old blanket unique constraint
ALTER TABLE earmarks DROP CONSTRAINT IF EXISTS unique_invoice_id;

-- Add partial unique constraint: only ONE active earmark per invoice
-- This allows multiple cancelled/expired/completed earmarks but prevents duplicate active ones
CREATE UNIQUE INDEX unique_active_earmark_per_invoice ON earmarks(invoice_id)
WHERE status IN ('pending', 'ready');

-- Add composite index for performance
CREATE INDEX IF NOT EXISTS idx_earmarks_invoice_status ON earmarks(invoice_id, status);

-- migrate:down
-- Re-add the original unique constraint (for rollback)
ALTER TABLE earmarks ADD CONSTRAINT unique_invoice_id UNIQUE (invoice_id);

-- Remove the new indexes
DROP INDEX IF EXISTS unique_active_earmark_per_invoice;
DROP INDEX IF EXISTS idx_earmarks_invoice_status;
