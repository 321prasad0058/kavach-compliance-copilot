-- =====================================================================
-- Kavach 02: load synthetic CSVs from the stage, then rebase dates
-- Upload first (scripts/deploy.sh does this):
--   snow stage copy "data/out/*.csv" @KAVACH.CORE.RAW_STAGE --overwrite
-- or in Snowsight: Data > KAVACH > CORE > Stages > RAW_STAGE > + Files
-- =====================================================================
USE ROLE KAVACH_ADMIN;
USE WAREHOUSE KAVACH_WH;
USE SCHEMA KAVACH.CORE;

TRUNCATE TABLE CUSTOMERS;    COPY INTO CUSTOMERS    FROM @RAW_STAGE PATTERN = '.*customers[.]csv.*'                   FORCE = TRUE ON_ERROR = ABORT_STATEMENT;
TRUNCATE TABLE ACCOUNTS;     COPY INTO ACCOUNTS     FROM @RAW_STAGE PATTERN = '.*accounts[.]csv.*'                    FORCE = TRUE ON_ERROR = ABORT_STATEMENT;
TRUNCATE TABLE TRANSACTIONS; COPY INTO TRANSACTIONS FROM @RAW_STAGE PATTERN = '.*transactions[.]csv.*'                FORCE = TRUE ON_ERROR = ABORT_STATEMENT;
TRUNCATE TABLE KYC_RECORDS;  COPY INTO KYC_RECORDS  FROM @RAW_STAGE PATTERN = '.*kyc_records[.]csv.*'                 FORCE = TRUE ON_ERROR = ABORT_STATEMENT;
TRUNCATE TABLE FRAUD_ALERTS; COPY INTO FRAUD_ALERTS FROM @RAW_STAGE PATTERN = '.*fraud_alerts[.]csv.*'                FORCE = TRUE ON_ERROR = ABORT_STATEMENT;
TRUNCATE TABLE DATA_META;    COPY INTO DATA_META    FROM @RAW_STAGE PATTERN = '.*data_meta[.]csv.*'                   FORCE = TRUE ON_ERROR = ABORT_STATEMENT;

-- ---------------------------------------------------------------------
-- REBASE_DATES: shift every date so the synthetic "today" = CURRENT_DATE.
-- Re-run on demo day:  CALL KAVACH.CORE.REBASE_DATES();
-- Keeps "last 30 days" / "this week" demo questions returning the planted cases.
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE REBASE_DATES()
RETURNS STRING
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
  shift_days NUMBER;
BEGIN
  SELECT DATEDIFF(day, MAX(anchor_date), CURRENT_DATE()) INTO :shift_days FROM KAVACH.CORE.DATA_META;
  IF (shift_days = 0) THEN
    RETURN 'Already aligned to ' || CURRENT_DATE()::STRING;
  END IF;
  UPDATE KAVACH.CORE.CUSTOMERS    SET onboarding_date = DATEADD(day, :shift_days, onboarding_date);
  UPDATE KAVACH.CORE.ACCOUNTS     SET disbursal_date  = DATEADD(day, :shift_days, disbursal_date);
  UPDATE KAVACH.CORE.TRANSACTIONS SET txn_ts          = DATEADD(day, :shift_days, txn_ts);
  UPDATE KAVACH.CORE.KYC_RECORDS  SET last_kyc_date   = DATEADD(day, :shift_days, last_kyc_date),
                                      next_kyc_due    = DATEADD(day, :shift_days, next_kyc_due);
  UPDATE KAVACH.CORE.FRAUD_ALERTS SET created_at      = DATEADD(day, :shift_days, created_at);
  UPDATE KAVACH.CORE.DATA_META    SET anchor_date     = CURRENT_DATE();
  RETURN 'Shifted all dates by ' || shift_days::STRING || ' days';
END;
$$;

CALL REBASE_DATES();

SELECT 'customers' t, COUNT(*) n FROM CUSTOMERS UNION ALL
SELECT 'accounts', COUNT(*) FROM ACCOUNTS UNION ALL
SELECT 'transactions', COUNT(*) FROM TRANSACTIONS UNION ALL
SELECT 'kyc_records', COUNT(*) FROM KYC_RECORDS UNION ALL
SELECT 'fraud_alerts', COUNT(*) FROM FRAUD_ALERTS;
