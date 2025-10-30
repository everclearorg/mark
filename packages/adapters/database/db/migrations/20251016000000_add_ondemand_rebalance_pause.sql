-- migrate:up

-- Add ondemand_rebalance_paused column to admin_actions table
ALTER TABLE admin_actions ADD COLUMN ondemand_rebalance_paused BOOLEAN DEFAULT FALSE;

-- Add comment for the new column
COMMENT ON COLUMN admin_actions.ondemand_rebalance_paused IS 'Pause flag for on-demand rebalancing operations triggered by invoice processing';

-- migrate:down

-- Remove the ondemand_rebalance_paused column
ALTER TABLE admin_actions DROP COLUMN IF EXISTS ondemand_rebalance_paused;
