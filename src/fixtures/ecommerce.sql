CREATE TABLE customers (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,
    email       VARCHAR(200) NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status      VARCHAR(20) NOT NULL DEFAULT 'active'  -- 'active' | 'churned'
);
COMMENT ON TABLE  customers IS 'End customers of the store.';
COMMENT ON COLUMN customers.status IS 'Lifecycle state. Active = made an order in the last 90 days.';

CREATE TABLE orders (
    id            SERIAL PRIMARY KEY,
    customer_id   INTEGER NOT NULL REFERENCES customers(id),
    placed_at     TIMESTAMPTZ NOT NULL,
    total_amount  NUMERIC(10,2) NOT NULL,
    currency      CHAR(3) NOT NULL DEFAULT 'EUR',
    status        VARCHAR(20) NOT NULL DEFAULT 'completed'  -- 'completed' | 'cancelled'
);
COMMENT ON TABLE  orders IS 'A purchase placed by a customer.';
COMMENT ON COLUMN orders.total_amount IS 'Order subtotal in the currency column. Refunds are tracked separately.';

CREATE TABLE line_items (
    id           SERIAL PRIMARY KEY,
    order_id     INTEGER NOT NULL REFERENCES orders(id),
    product_name VARCHAR(200) NOT NULL,
    quantity     INTEGER NOT NULL,
    unit_price   NUMERIC(10,2) NOT NULL
);

CREATE TABLE refunds (
    id           SERIAL PRIMARY KEY,
    order_id     INTEGER NOT NULL REFERENCES orders(id),
    amount       NUMERIC(10,2) NOT NULL,
    reason       TEXT,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE refunds IS 'Refunds against specific orders. Revenue = SUM(orders.total_amount) - SUM(refunds.amount).';

-- Seed a few rows so sample-value extraction has something to work with.
INSERT INTO customers (name, email, status) VALUES
    ('Alice', 'alice@example.com', 'active'),
    ('Bob',   'bob@example.com',   'churned'),
    ('Carol', 'carol@example.com', 'active');
INSERT INTO orders (customer_id, placed_at, total_amount) VALUES
    (1, NOW() - INTERVAL '5 days', 120.00),
    (1, NOW() - INTERVAL '40 days', 80.00),
    (3, NOW() - INTERVAL '2 days', 250.00);
INSERT INTO line_items (order_id, product_name, quantity, unit_price) VALUES
    (1, 'Headphones', 1, 120.00),
    (2, 'Cable',      2, 40.00),
    (3, 'Keyboard',   1, 250.00);
INSERT INTO refunds (order_id, amount, reason) VALUES
    (2, 80.00, 'Defective product');
