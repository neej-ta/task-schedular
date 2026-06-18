-- Demo TARGET schema for the optional MySQL container (docker-compose `mysql`
-- profile). Mirrors deploy/postgres/init/01-demo.sql and deploy/sqlserver/
-- init-demo.sql so the same demo jobs run against a MySQL target. The MySQL
-- image auto-creates the `demo` database + `demo` user from env; this just adds
-- the customers table. The integration test (scripts/mysql.itest.ts) creates it
-- automatically; this file is the canonical/standalone definition.
--
-- Apply manually with:
--   docker compose --profile mysql exec mysql \
--     mysql -u demo -p"$MYSQL_PASSWORD" demo < /path/to/init-demo.sql

CREATE TABLE IF NOT EXISTS customers (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_name VARCHAR(255),
  email         VARCHAR(255) UNIQUE,
  age           INT,
  country       VARCHAR(100),
  customer_code VARCHAR(100) UNIQUE,
  join_date     DATE,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, -- bulk_update touches this
  deleted_at    DATETIME NULL                                                            -- soft-delete (bulk_delete default)
);
