-- Order creation at checkout.
INSERT INTO orders (customer_id, status, total)
VALUES ($1, 'pending', $2)
RETURNING id, customer_id, status, total
