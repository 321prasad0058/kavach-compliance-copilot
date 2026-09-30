-- =====================================================================
-- Kavach 04: policy / regulation corpus + Cortex Search service
-- Chunks are produced clause-by-clause by data/generate_synthetic.py so every
-- retrieved passage carries its document, section number and title.
-- =====================================================================
USE ROLE KAVACH_ADMIN;
USE WAREHOUSE KAVACH_WH;
USE SCHEMA KAVACH.KNOWLEDGE;

CREATE OR REPLACE TABLE POLICY_CHUNKS (
  chunk_id       STRING NOT NULL PRIMARY KEY,
  doc_id         STRING,
  doc_title      STRING,
  doc_type       STRING COMMENT 'REGULATION / INTERNAL_POLICY / SOP / AUDIT_FINDING / TEMPLATE',
  issuer         STRING,
  version        STRING,
  source_ref     STRING,
  section_id     STRING,
  section_title  STRING,
  section_path   STRING COMMENT 'Parent heading > clause heading',
  chunk_text     STRING,
  disclaimer     STRING
);

COPY INTO POLICY_CHUNKS FROM @KAVACH.CORE.RAW_STAGE
  PATTERN = '.*policy_chunks[.]csv.*' FILE_FORMAT = (FORMAT_NAME = 'KAVACH.CORE.CSV_FMT')
  FORCE = TRUE ON_ERROR = ABORT_STATEMENT;

-- ---------------------------------------------------------------------
-- OPTIONAL: ingest the official RBI Master Direction PDFs as well.
-- 1. Upload PDFs to @KAVACH.KNOWLEDGE.RBI_PDFS
-- 2. Uncomment and run. Chunks land in the same table, so the search
--    service below picks them up with no other change.
-- ---------------------------------------------------------------------
-- INSERT INTO POLICY_CHUNKS
-- WITH parsed AS (
--   SELECT relative_path,
--          SNOWFLAKE.CORTEX.PARSE_DOCUMENT(@KAVACH.KNOWLEDGE.RBI_PDFS, relative_path, {'mode': 'LAYOUT'}):content::STRING AS body
--   FROM DIRECTORY(@KAVACH.KNOWLEDGE.RBI_PDFS)
-- )
-- SELECT relative_path || '-' || c.index, relative_path, relative_path, 'REGULATION', 'Reserve Bank of India',
--        'Official PDF', 'stage://RBI_PDFS/' || relative_path, 'p' || c.index, 'Official text chunk ' || c.index, relative_path || ' > chunk ' || c.index,
--        c.value::STRING, 'Official RBI text'
-- FROM parsed, LATERAL FLATTEN(SNOWFLAKE.CORTEX.SPLIT_TEXT_RECURSIVE_CHARACTER(body, 'markdown', 1500, 200)) c;

CREATE OR REPLACE CORTEX SEARCH SERVICE POLICY_SEARCH
  ON search_text
  ATTRIBUTES doc_type, doc_id
  WAREHOUSE = KAVACH_WH
  TARGET_LAG = '1 hour'
  COMMENT = 'Kavach: RBI directions, internal policy, SOPs, audit findings, templates'
AS (
  SELECT chunk_id, doc_id, doc_title, doc_type, issuer, version, source_ref,
         section_id, section_title, section_path, chunk_text, disclaimer,
         doc_title || ' | ' || section_path || ' | ' || chunk_text AS search_text
  FROM POLICY_CHUNKS
);

GRANT SELECT ON TABLE POLICY_CHUNKS TO ROLE KAVACH_APP;
GRANT USAGE ON CORTEX SEARCH SERVICE POLICY_SEARCH TO ROLE KAVACH_APP;

-- Smoke test
SELECT PARSE_JSON(SNOWFLAKE.CORTEX.SEARCH_PREVIEW(
  'KAVACH.KNOWLEDGE.POLICY_SEARCH',
  '{"query": "structuring cash deposits below threshold escalation", "columns": ["chunk_id","section_title"], "limit": 3}'
)):results AS top_hits;
