-- Customer signup.
INSERT INTO customers (email, name)
VALUES ($1, $2)
RETURNING id, email, name, created_at
