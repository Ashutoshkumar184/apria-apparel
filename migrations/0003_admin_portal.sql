CREATE TABLE admin_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'staff')),
  must_change_password INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX admin_single_owner_idx ON admin_users(role) WHERE role = 'owner';

CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX admin_sessions_user_idx ON admin_sessions(user_id);
CREATE INDEX admin_sessions_expiry_idx ON admin_sessions(expires_at);

CREATE TABLE admin_login_attempts (
  attempt_key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price_paise INTEGER NOT NULL CHECK (price_paise >= 0),
  from_price_paise INTEGER NOT NULL DEFAULT 0,
  image TEXT NOT NULL,
  color TEXT NOT NULL,
  gsm TEXT NOT NULL DEFAULT '',
  fabric TEXT NOT NULL DEFAULT '',
  sizes TEXT NOT NULL,
  tag TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX products_active_order_idx ON products(active, sort_order);

CREATE TABLE product_variants (
  product_id TEXT NOT NULL,
  size TEXT NOT NULL,
  color TEXT NOT NULL,
  stock_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (stock_on_hand >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  PRIMARY KEY(product_id, size, color),
  FOREIGN KEY(product_id) REFERENCES products(id)
);

CREATE TABLE stock_reservations (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  size TEXT NOT NULL,
  color TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'committed', 'released')),
  created_at TEXT NOT NULL,
  UNIQUE(order_id, product_id, size, color)
);
CREATE INDEX stock_reservations_expiry_idx ON stock_reservations(status, expires_at);

ALTER TABLE enquiries ADD COLUMN status TEXT NOT NULL DEFAULT 'new';
ALTER TABLE enquiries ADD COLUMN admin_note TEXT NOT NULL DEFAULT '';
ALTER TABLE enquiries ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

CREATE TABLE order_requests (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  address_json TEXT NOT NULL,
  items_json TEXT NOT NULL,
  amount_estimate_paise INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new',
  admin_note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX order_requests_created_idx ON order_requests(created_at DESC);
CREATE INDEX order_requests_status_idx ON order_requests(status, created_at DESC);

ALTER TABLE payment_orders ADD COLUMN fulfillment_status TEXT NOT NULL DEFAULT 'unfulfilled';
ALTER TABLE payment_orders ADD COLUMN admin_note TEXT NOT NULL DEFAULT '';
ALTER TABLE payment_orders ADD COLUMN reservation_expires_at TEXT NOT NULL DEFAULT '';

CREATE TABLE admin_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE admin_audit_log (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  summary TEXT NOT NULL
);
CREATE INDEX admin_audit_created_idx ON admin_audit_log(created_at DESC);
