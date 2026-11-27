-- Store refunds as negative totals so revenue reports can just sum(total).
-- The SQL runs fine; it silently breaks invariants other code relies on.
UPDATE orders SET total = -total WHERE status = 'refunded';
