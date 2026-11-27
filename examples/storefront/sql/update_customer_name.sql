-- Profile edit: change the display name.
UPDATE customers
SET name = $1
WHERE id = $2
RETURNING id, name
