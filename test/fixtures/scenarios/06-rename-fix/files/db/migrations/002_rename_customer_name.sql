-- Rename customers.name to customers.full_name. The SQL that reads and writes it is not updated.
ALTER TABLE customers RENAME COLUMN name TO full_name;
