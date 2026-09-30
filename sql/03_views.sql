-- =====================================================================
-- Kavach 03: governed signal views used by the semantic model and the UI
-- The business definition of "structuring" lives HERE, once, so every
-- question that mentions structuring resolves to the same logic.
-- =====================================================================
USE ROLE KAVACH_ADMIN;
USE WAREHOUSE KAVACH_WH;
USE SCHEMA KAVACH.CORE;

-- SOP-AML 1.1: >= 3 cash / wallet credits, each Rs 40,000 - 49,999, within a rolling 7-day window.
CREATE OR REPLACE VIEW STRUCTURING_SIGNALS
  COMMENT = 'One row per account: its densest 7-day window of sub-threshold cash/wallet credits (SOP-AML 1.1)'
AS
WITH sub AS (
  SELECT account_id, customer_id, txn_id, txn_ts, amount, channel, geo_city
  FROM TRANSACTIONS
  WHERE direction = 'CREDIT'
    AND channel IN ('CASH_DEPOSIT', 'WALLET_TOPUP')
    AND amount BETWEEN 40000 AND 49999.99
),
windows AS (
  SELECT a.account_id, a.customer_id,
         a.txn_ts                                 AS window_start_ts,
         MAX(b.txn_ts)                            AS window_end_ts,
         COUNT(*)                                 AS sub_threshold_txn_count,
         SUM(b.amount)                            AS window_total_amount,
         COUNT(DISTINCT b.geo_city)               AS distinct_cities,
         LISTAGG(DISTINCT b.geo_city, ', ')       AS cities,
         LISTAGG(DISTINCT b.channel, ', ')        AS channels
  FROM sub a
  JOIN sub b
    ON a.account_id = b.account_id
   AND b.txn_ts >= a.txn_ts
   AND b.txn_ts <  DATEADD(day, 7, a.txn_ts)
  GROUP BY a.account_id, a.customer_id, a.txn_ts
)
SELECT *
FROM windows
WHERE sub_threshold_txn_count >= 3
QUALIFY ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY sub_threshold_txn_count DESC, window_total_amount DESC) = 1;

-- Portfolio KPIs for the landing screen.
CREATE OR REPLACE VIEW PORTFOLIO_KPIS AS
SELECT
  (SELECT COUNT(*) FROM FRAUD_ALERTS WHERE status IN ('OPEN', 'IN_REVIEW', 'ESCALATED'))                          AS open_alerts,
  (SELECT COUNT(*) FROM FRAUD_ALERTS WHERE status IN ('OPEN', 'IN_REVIEW', 'ESCALATED') AND severity = 'HIGH')    AS high_severity_open,
  (SELECT SUM(outstanding_principal) FROM ACCOUNTS WHERE account_status = 'ACTIVE')                              AS total_exposure,
  (SELECT SUM(outstanding_principal) FROM ACCOUNTS WHERE account_status = 'ACTIVE' AND npa_flag)                 AS npa_exposure,
  (SELECT COUNT(*) FROM ACCOUNTS WHERE account_status = 'ACTIVE' AND asset_classification = 'SMA-2')             AS sma2_accounts,
  (SELECT COUNT(*) FROM KYC_RECORDS WHERE risk_category = 'HIGH' AND next_kyc_due < CURRENT_DATE())              AS high_risk_kyc_overdue;

GRANT SELECT ON ALL TABLES IN SCHEMA KAVACH.CORE TO ROLE KAVACH_APP;
GRANT SELECT ON ALL VIEWS  IN SCHEMA KAVACH.CORE TO ROLE KAVACH_APP;
