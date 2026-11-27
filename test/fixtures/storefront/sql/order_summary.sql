-- Checkout / order summary: one row per line item, in SKU order.
SELECT o.id AS order_id,
       o.status,
       c.full_name AS customer_name,
       'Thanks for your order, ' || c.full_name AS greeting, -- the literal and this comment mention name on purpose
       i.sku,
       i.quantity,
       i.unit_price,
       i.quantity * i.unit_price AS line_total,
       o.total AS order_total
FROM orders o
JOIN customers c ON c.id = o.customer_id
JOIN order_items i ON i.order_id = o.id
WHERE o.id = $1
ORDER BY i.sku
