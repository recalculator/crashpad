-- Payment webhook: mark a pending order as paid.
UPDATE orders
SET status = 'paid'
WHERE id = $1 AND status = 'pending'
RETURNING id, status
