-- Speeds up the customer-profile and customer-orders queries.
CREATE INDEX orders_customer_id_idx ON orders (customer_id);
