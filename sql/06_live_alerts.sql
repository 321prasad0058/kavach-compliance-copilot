-- =====================================================================
-- Kavach 06 (optional): simulate a live alert feed for the demo.
-- Creates a task that inserts one synthetic alert every 2 minutes.
-- The task is created SUSPENDED. Resume it just before the demo and
-- suspend it afterwards to save credits.
--   ALTER TASK KAVACH.CORE.SIMULATE_ALERTS_TASK RESUME;
--   ALTER TASK KAVACH.CORE.SIMULATE_ALERTS_TASK SUSPEND;
-- =====================================================================
USE ROLE KAVACH_ADMIN;
USE WAREHOUSE KAVACH_WH;
USE SCHEMA KAVACH.CORE;

CREATE OR REPLACE PROCEDURE SIMULATE_NEW_ALERT()
RETURNS STRING
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
  v_id STRING;
BEGIN
  v_id := 'AL' || TO_VARCHAR(900000 + UNIFORM(1, 99999, RANDOM()));
  INSERT INTO KAVACH.CORE.FRAUD_ALERTS
  SELECT :v_id, account_id, customer_id,
         DECODE(UNIFORM(1, 5, RANDOM()), 1, 'VELOCITY', 2, 'GEO_ANOMALY', 3, 'INCOME_MISMATCH', 4, 'EARLY_DELINQUENCY', 'STRUCTURING'),
         DECODE(UNIFORM(1, 3, RANDOM()), 1, 'LOW', 2, 'MEDIUM', 'HIGH'),
         'OPEN', SYSDATE(), 'fcu.analyst' || UNIFORM(1, 3, RANDOM()),
         UNIFORM(20000, 350000, RANDOM()), 'Auto: live rule engine (simulated)'
  FROM KAVACH.CORE.ACCOUNTS WHERE account_status = 'ACTIVE'
  ORDER BY RANDOM() LIMIT 1;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE TASK SIMULATE_ALERTS_TASK
  WAREHOUSE = KAVACH_WH
  SCHEDULE = '2 MINUTE'
AS
  CALL KAVACH.CORE.SIMULATE_NEW_ALERT();
