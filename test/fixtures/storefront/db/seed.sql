-- Synthetic sample data (no real people or customer records).
-- Loaded right after schema.sql, before migrations, so migrations transform it like production data.

INSERT INTO customers (id, email, name, created_at) VALUES
  (1, 'ada@example.test',       'Ada Lovelace',      '2025-01-05 09:00:00+00'),
  (2, 'grace@example.test',     'Grace Hopper',      '2025-01-06 10:30:00+00'),
  (3, 'alan@example.test',      'Alan Turing',       '2025-02-11 14:15:00+00'),
  (4, 'katherine@example.test', 'Katherine Johnson', '2025-03-01 08:45:00+00'),
  (5, 'edsger@example.test',    'Edsger Dijkstra',   '2025-03-20 16:00:00+00'),
  (6, 'barbara@example.test',   'Barbara Liskov',    '2025-04-02 11:20:00+00');

INSERT INTO orders (id, customer_id, status, total, created_at) VALUES
  (1, 1, 'paid',     59.97,  '2025-05-01 12:00:00+00'),
  (2, 1, 'shipped',  120.50, '2025-05-03 09:10:00+00'),
  (3, 2, 'pending',  15.00,  '2025-05-04 18:25:00+00'),
  (4, 2, 'paid',     249.99, '2025-05-07 07:40:00+00'),
  (5, 3, 'refunded', 35.25,  '2025-05-09 13:05:00+00'),
  (6, 4, 'paid',     0.10,   '2025-05-10 10:00:00+00'),
  (7, 4, 'shipped',  89.00,  '2025-05-12 15:30:00+00'),
  (8, 5, 'refunded', 12.00,  '2025-05-14 17:45:00+00');

INSERT INTO order_items (id, order_id, sku, quantity, unit_price) VALUES
  (1, 1, 'SKU-MUG',     3,  19.99),
  (2, 2, 'SKU-LAMP',    1,  120.50),
  (3, 3, 'SKU-PEN',     5,  3.00),
  (4, 4, 'SKU-CHAIR',   1,  249.99),
  (5, 5, 'SKU-BOOK',    1,  35.25),
  (6, 6, 'SKU-STICKER', 10, 0.01),
  (7, 7, 'SKU-BAG',     2,  44.50),
  (8, 8, 'SKU-PEN',     4,  3.00);

-- Explicit ids above do not advance identity sequences; align them so new rows get fresh ids.
SELECT setval(pg_get_serial_sequence('customers', 'id'), (SELECT max(id) FROM customers));
SELECT setval(pg_get_serial_sequence('orders', 'id'), (SELECT max(id) FROM orders));
SELECT setval(pg_get_serial_sequence('order_items', 'id'), (SELECT max(id) FROM order_items));
