-- Synthetic data only.
INSERT INTO users (email, name, password_hash, role) VALUES
  ('admin@example.test', 'Admin', '7245d0d2753014dde06e99913156727a9a1b7badcd92836a23ff41a7d2f5f309', 'admin');
INSERT INTO products (id, name, price) VALUES
  (1, 'Notebook', 4.50),
  (2, 'Pen', 1.25),
  (3, 'Desk lamp', 32.00);
