-- Demo TARGET schema for the optional SQL Server container (docker-compose
-- `mssql` profile). Mirrors deploy/postgres/init/01-demo.sql so the same demo
-- jobs (bulk import/insert/update/delete, export, REST push) run against a SQL
-- Server target. The integration test (scripts/mssql.itest.ts) creates this
-- automatically; this file is the canonical/standalone definition.
--
-- Apply manually with:
--   docker compose --profile mssql exec sqlserver \
--     /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$MSSQL_SA_PASSWORD" \
--     -C -i /path/to/init-demo.sql

IF DB_ID('demo') IS NULL
  CREATE DATABASE demo;
GO

USE demo;
GO

-- UNIQUE constraints on email + customer_code back the idempotent upsert and
-- the parallel-uniqueness guarantee (spec §5.5, §13). NVARCHAR uses an explicit
-- length so the staging table reconstructs a faithful column type.
IF OBJECT_ID('dbo.customers', 'U') IS NULL
  CREATE TABLE dbo.customers (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    customer_name NVARCHAR(255),
    email         NVARCHAR(255) UNIQUE,
    age           INT,
    country       NVARCHAR(100),
    customer_code NVARCHAR(100) UNIQUE,
    join_date     DATE,
    created_at    DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at    DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), -- bulk_update touches this
    deleted_at    DATETIME2 NULL                                -- soft-delete (bulk_delete default)
  );
GO
