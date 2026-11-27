-- Customer signup.
INSERT INTO customers (email, full_name)
VALUES ($1, $2)
RETURNING id, email, full_name AS name, created_at
