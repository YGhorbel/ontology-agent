-- Runs after 00-create-databases.sql. Switches into the ecommerce DB and loads
-- the single source-of-truth fixture (mounted read-only at /fixtures).
\connect ecommerce
\i /fixtures/ecommerce.sql
