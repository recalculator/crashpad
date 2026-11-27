-- Order history for one customer, newest last.
SELECT id, status, total, created_at
FROM orders
WHERE customer_id = $1
ORDER BY created_at, id
