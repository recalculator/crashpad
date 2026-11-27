-- Optional loyalty tier for customers. Nullable, so existing reads and writes keep working.
ALTER TABLE customers ADD COLUMN loyalty_tier text CHECK (loyalty_tier IN ('bronze', 'silver', 'gold'));
CREATE INDEX customers_loyalty_tier_idx ON customers (loyalty_tier);
