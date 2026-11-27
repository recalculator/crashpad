INSERT INTO notes (owner_id, title, body)
VALUES ($1, $2, $3)
RETURNING id, owner_id, title, body
