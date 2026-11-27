-- Customer profile for the account page.
-- The API returns this row as-is; clients read the "name" field.
SELECT c.id,
       c.email,
       c.full_name AS name,
       count(o.id) AS order_count,
       coalesce(sum(o.total) FILTER (WHERE o.status IN ('paid', 'shipped')), 0) AS lifetime_spend
FROM customers AS c
LEFT JOIN orders AS o ON o.customer_id = c.id
WHERE c.id = $1
GROUP BY c.id, c.email, c.full_name
