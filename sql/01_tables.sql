-- =====================================================================
-- Kavach 01: core tables (synthetic NBFC data)
-- =====================================================================
USE ROLE KAVACH_ADMIN;
USE WAREHOUSE KAVACH_WH;
USE SCHEMA KAVACH.CORE;

CREATE OR REPLACE TABLE CUSTOMERS (
  customer_id                   STRING  NOT NULL PRIMARY KEY,
  business_name                 STRING,
  pan                           STRING  COMMENT 'Synthetic PAN - masked for non-admin roles',
  segment                       STRING,
  city                          STRING,
  state                         STRING,
  onboarding_date               DATE,
  declared_monthly_income       NUMBER(14,2) COMMENT 'Income declared by the borrower at application',
  bank_stmt_avg_monthly_credit  NUMBER(14,2) COMMENT 'Average monthly credits observed in bank statement analysis',
  first_time_borrower           BOOLEAN COMMENT 'New-to-credit: no bureau history',
  bureau_score                  NUMBER(3,0)
);

CREATE OR REPLACE TABLE ACCOUNTS (
  account_id             STRING NOT NULL PRIMARY KEY,
  customer_id            STRING NOT NULL,
  product                STRING,
  sourcing_partner       STRING,
  sanctioned_amount      NUMBER(14,2),
  disbursed_amount       NUMBER(14,2),
  disbursal_date         DATE,
  tenure_months          NUMBER(3,0),
  interest_rate          NUMBER(5,2),
  outstanding_principal  NUMBER(14,2) COMMENT 'Current exposure',
  dpd                    NUMBER(5,0)  COMMENT 'Days past due',
  asset_classification   STRING       COMMENT 'STANDARD / SMA-0 / SMA-1 / SMA-2 / NPA',
  npa_flag               BOOLEAN,
  account_status         STRING
);

CREATE OR REPLACE TABLE TRANSACTIONS (
  txn_id             STRING NOT NULL PRIMARY KEY,
  account_id         STRING NOT NULL,
  customer_id        STRING,
  txn_ts             TIMESTAMP_NTZ,
  amount             NUMBER(14,2),
  direction          STRING COMMENT 'CREDIT / DEBIT',
  channel            STRING COMMENT 'UPI / NEFT / IMPS / RTGS / NACH / CASH_DEPOSIT / WALLET_TOPUP / DISBURSAL',
  counterparty       STRING,
  counterparty_type  STRING,
  geo_city           STRING,
  geo_state          STRING
);

CREATE OR REPLACE TABLE KYC_RECORDS (
  customer_id          STRING NOT NULL PRIMARY KEY,
  doc_type             STRING,
  verification_status  STRING,
  risk_category        STRING COMMENT 'LOW / MEDIUM / HIGH',
  pep_flag             BOOLEAN,
  sanctions_screening  STRING,
  last_kyc_date        DATE,
  next_kyc_due         DATE
);

CREATE OR REPLACE TABLE FRAUD_ALERTS (
  alert_id        STRING NOT NULL PRIMARY KEY,
  account_id      STRING,
  customer_id     STRING,
  rule_triggered  STRING COMMENT 'STRUCTURING / VELOCITY / GEO_ANOMALY / INCOME_MISMATCH / EARLY_DELINQUENCY / PEP_EXPOSURE',
  severity        STRING,
  status          STRING COMMENT 'OPEN / IN_REVIEW / ESCALATED / CLOSED_FP / STR_FILED',
  created_at      TIMESTAMP_NTZ,
  assigned_to     STRING,
  alert_amount    NUMBER(14,2),
  analyst_notes   STRING
);

CREATE OR REPLACE TABLE DATA_META (anchor_date DATE, seed NUMBER);

-- ---------------- PII masking: the LLM path (KAVACH_APP) never sees raw PAN ----------------
CREATE MASKING POLICY IF NOT EXISTS PAN_MASK AS (val STRING) RETURNS STRING ->
  CASE WHEN IS_ROLE_IN_SESSION('KAVACH_ADMIN') AND CURRENT_ROLE() = 'KAVACH_ADMIN' THEN val
       ELSE 'XXXXX' || SUBSTR(val, 6, 4) || 'X' END;
ALTER TABLE CUSTOMERS MODIFY COLUMN pan SET MASKING POLICY PAN_MASK;
