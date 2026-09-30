-- =====================================================================
-- Kavach 05: immutable, hash-chained audit log + findings
--
-- Controls:
--   * AUDIT_LOG is owned by KAVACH_ADMIN. KAVACH_APP (which owns and runs
--     the Kavach API) has SELECT only - no INSERT / UPDATE / DELETE.
--   * The only write path is LOG_EVENT, an owner's-rights procedure that
--     appends a row whose row_hash = SHA2(prev_hash | seq | ts | type | user | payload).
--   * V_AUDIT_CHAIN_CHECK recomputes every hash; any edited, deleted or
--     re-ordered row breaks the chain and shows is_valid = FALSE.
--   * Findings and reviewer sign-offs are events in the same log
--     (maker-checker is recorded, not assumed).
-- =====================================================================
USE ROLE KAVACH_ADMIN;
USE WAREHOUSE KAVACH_WH;
USE SCHEMA KAVACH.GOV;

CREATE SEQUENCE IF NOT EXISTS AUDIT_SEQ START = 1 INCREMENT = 1 ORDER;

CREATE TABLE IF NOT EXISTS AUDIT_LOG (
  audit_seq      NUMBER(38,0)  NOT NULL,
  event_id       STRING        NOT NULL,
  event_ts_utc   TIMESTAMP_NTZ NOT NULL,
  event_type     STRING        NOT NULL COMMENT 'QUESTION_ANSWERED / FINDING_GENERATED / FINDING_REVIEWED',
  app_user       STRING        COMMENT 'Caller identity (SPCS Sf-Context-Current-User or app persona)',
  db_user        STRING        COMMENT 'CURRENT_USER() at write time',
  db_role        STRING,
  question       STRING,
  route          STRING,
  generated_sql  STRING,
  row_count      NUMBER,
  confidence     STRING,
  model          STRING,
  answer         STRING,
  payload        VARIANT       COMMENT 'Full evidence trail: SQL, rows sample, retrieved clauses, answer, finding',
  prev_hash      STRING        NOT NULL,
  row_hash       STRING        NOT NULL
)
DATA_RETENTION_TIME_IN_DAYS = 90
CHANGE_TRACKING = TRUE
COMMENT = 'Append-only Kavach audit trail. Write only via KAVACH.GOV.LOG_EVENT.';

CREATE OR REPLACE PROCEDURE LOG_EVENT(EVENT_TYPE STRING, APP_USER STRING, PAYLOAD_JSON STRING)
RETURNS VARIANT
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
  v_seq   NUMBER;
  v_id    STRING;
  v_ts    TIMESTAMP_NTZ;
  v_prev  STRING;
  v_hash  STRING;
  v_user  STRING;
BEGIN
  v_user := COALESCE(APP_USER, 'unknown');
  SELECT KAVACH.GOV.AUDIT_SEQ.NEXTVAL, UUID_STRING(), SYSDATE() INTO :v_seq, :v_id, :v_ts;
  SELECT COALESCE(MAX_BY(row_hash, audit_seq), 'GENESIS') INTO :v_prev FROM KAVACH.GOV.AUDIT_LOG;
  SELECT SHA2(:v_prev || '|' || :v_seq::STRING || '|' || TO_VARCHAR(:v_ts, 'YYYY-MM-DD HH24:MI:SS.FF6')
              || '|' || :EVENT_TYPE || '|' || :v_user || '|' || TO_JSON(PARSE_JSON(:PAYLOAD_JSON)), 256)
    INTO :v_hash;

  INSERT INTO KAVACH.GOV.AUDIT_LOG
    (audit_seq, event_id, event_ts_utc, event_type, app_user, db_user, db_role,
     question, route, generated_sql, row_count, confidence, model, answer, payload, prev_hash, row_hash)
  SELECT :v_seq, :v_id, :v_ts, :EVENT_TYPE, :v_user, CURRENT_USER(), CURRENT_ROLE(),
         p:question::STRING, p:route::STRING, p:data:sql::STRING, p:data:row_count::NUMBER,
         p:confidence:level::STRING, p:model::STRING, COALESCE(p:answer::STRING, p:title::STRING),
         p, :v_prev, :v_hash
  FROM (SELECT PARSE_JSON(:PAYLOAD_JSON) AS p);

  RETURN OBJECT_CONSTRUCT('audit_seq', v_seq, 'event_id', v_id, 'row_hash', v_hash,
                          'prev_hash', v_prev, 'event_ts_utc', TO_VARCHAR(v_ts, 'YYYY-MM-DD HH24:MI:SS'));
END;
$$;

-- Tamper evidence: recompute each hash and check linkage to the previous row.
CREATE OR REPLACE VIEW V_AUDIT_CHAIN_CHECK AS
SELECT
  audit_seq, event_id, event_ts_utc, event_type, app_user, db_user, question, route, confidence, row_count,
  prev_hash, row_hash,
  COALESCE(LAG(row_hash) OVER (ORDER BY audit_seq), 'GENESIS') AS expected_prev_hash,
  SHA2(prev_hash || '|' || audit_seq::STRING || '|' || TO_VARCHAR(event_ts_utc, 'YYYY-MM-DD HH24:MI:SS.FF6')
       || '|' || event_type || '|' || app_user || '|' || TO_JSON(payload), 256) AS recomputed_hash,
  (prev_hash = expected_prev_hash AND row_hash = recomputed_hash) AS is_valid
FROM AUDIT_LOG;

CREATE OR REPLACE VIEW V_FINDINGS AS
WITH f AS (
  SELECT payload:finding_id::STRING        AS finding_id,
         audit_seq                         AS finding_audit_seq,
         event_ts_utc                      AS created_at_utc,
         app_user                          AS created_by,
         payload:finding_type::STRING      AS finding_type,
         payload:title::STRING             AS title,
         payload:source_audit_seq::NUMBER  AS source_audit_seq,
         payload:confidence:level::STRING  AS confidence,
         payload:finding_markdown::STRING  AS finding_markdown,
         row_hash
  FROM AUDIT_LOG WHERE event_type = 'FINDING_GENERATED'
),
r AS (
  SELECT payload:finding_id::STRING AS finding_id, payload:decision::STRING AS decision,
         payload:comment::STRING AS review_comment, app_user AS reviewer, event_ts_utc AS reviewed_at_utc
  FROM AUDIT_LOG WHERE event_type = 'FINDING_REVIEWED'
  QUALIFY ROW_NUMBER() OVER (PARTITION BY payload:finding_id::STRING ORDER BY audit_seq DESC) = 1
)
SELECT f.*, COALESCE(r.decision, 'PENDING_REVIEW') AS status, r.reviewer, r.reviewed_at_utc, r.review_comment,
       (r.reviewer IS NULL OR r.reviewer <> f.created_by) AS maker_checker_ok
FROM f LEFT JOIN r ON f.finding_id = r.finding_id;

-- App role: read the log, append via the procedure only.
GRANT USAGE  ON PROCEDURE LOG_EVENT(STRING, STRING, STRING) TO ROLE KAVACH_APP;
GRANT SELECT ON TABLE AUDIT_LOG            TO ROLE KAVACH_APP;
GRANT SELECT ON VIEW  V_AUDIT_CHAIN_CHECK  TO ROLE KAVACH_APP;
GRANT SELECT ON VIEW  V_FINDINGS           TO ROLE KAVACH_APP;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE AUDIT_LOG FROM ROLE KAVACH_APP;

-- Smoke test (safe to leave: it is itself an audited event)
CALL LOG_EVENT('SYSTEM_INIT', CURRENT_USER(), '{"note": "Kavach audit log initialised"}');
SELECT audit_seq, event_type, is_valid FROM V_AUDIT_CHAIN_CHECK ORDER BY audit_seq DESC LIMIT 5;
