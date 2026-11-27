-- Profile edit: change the display name.
UPDATE customers
SET full_name = $1
WHERE id = $2
RETURNING id, full_name AS name
