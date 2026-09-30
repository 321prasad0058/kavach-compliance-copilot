-- =====================================================================
-- Kavach 07: run the Kavach container (Angular SPA + NestJS API) in
-- Snowpark Container Services, owned and run by KAVACH_APP.
-- Prerequisite: sql/00-06 (scripts/deploy.sh). Run top to bottom; the
-- docker steps in the middle are run from a terminal at the repo root.
-- =====================================================================

-- ---------------- 1. compute pool + account-level grants (ACCOUNTADMIN) ----------------
USE ROLE ACCOUNTADMIN;

CREATE COMPUTE POOL IF NOT EXISTS KAVACH_POOL
  MIN_NODES = 1
  MAX_NODES = 1
  INSTANCE_FAMILY = CPU_X64_XS
  AUTO_RESUME = TRUE
  AUTO_SUSPEND_SECS = 3600
  COMMENT = 'Kavach copilot (SPCS)';

GRANT USAGE, MONITOR ON COMPUTE POOL KAVACH_POOL TO ROLE KAVACH_APP;
-- a public endpoint needs BIND SERVICE ENDPOINT on the service owner's role
GRANT BIND SERVICE ENDPOINT ON ACCOUNT TO ROLE KAVACH_APP;

-- ---------------- 2. image repository + spec stage (KAVACH_ADMIN owns KAVACH.APP) ----------------
USE ROLE KAVACH_ADMIN;
USE WAREHOUSE KAVACH_WH;

CREATE IMAGE REPOSITORY IF NOT EXISTS KAVACH.APP.KAVACH_REPO;
GRANT READ ON IMAGE REPOSITORY KAVACH.APP.KAVACH_REPO TO ROLE KAVACH_APP;

CREATE STAGE IF NOT EXISTS KAVACH.APP.SPECS DIRECTORY = (ENABLE = TRUE)
  COMMENT = 'SPCS service specifications';
GRANT READ ON STAGE KAVACH.APP.SPECS TO ROLE KAVACH_APP;
GRANT CREATE SERVICE ON SCHEMA KAVACH.APP TO ROLE KAVACH_APP;

-- repository_url column, e.g. <org>-<account>.registry.snowflakecomputing.com/kavach/app/kavach_repo
SHOW IMAGE REPOSITORIES IN SCHEMA KAVACH.APP;

-- ---------------- 3. build + push the image (terminal, repo root) ----------------
-- The pushing user's DEFAULT role needs WRITE on the repository (KAVACH_ADMIN owns it):
--   ALTER USER <you> SET DEFAULT_ROLE = KAVACH_ADMIN;
--
--   REPO=<repository_url from SHOW IMAGE REPOSITORIES>
--   docker login ${REPO%%/*} -u <snowflake_user>          # password / PAT when prompted
--       (or: snow spcs image-registry login --connection <name>)
--   docker build --platform linux/amd64 -t kavach:latest .
--   docker tag  kavach:latest $REPO/kavach:latest
--   docker push $REPO/kavach:latest
--
-- Then upload the spec (snow CLI or SnowSQL):
--   snow stage copy deploy/spcs/kavach-service.yaml @KAVACH.APP.SPECS --overwrite --role KAVACH_ADMIN
--   -- or: PUT file://deploy/spcs/kavach-service.yaml @KAVACH.APP.SPECS AUTO_COMPRESS=FALSE OVERWRITE=TRUE;

SHOW IMAGES IN IMAGE REPOSITORY KAVACH.APP.KAVACH_REPO;
LIST @KAVACH.APP.SPECS;

-- ---------------- 4. create the service (owned and run by KAVACH_APP) ----------------
USE ROLE KAVACH_APP;
USE WAREHOUSE KAVACH_WH;

CREATE SERVICE IF NOT EXISTS KAVACH.APP.KAVACH_SERVICE
  IN COMPUTE POOL KAVACH_POOL
  FROM @KAVACH.APP.SPECS
  SPECIFICATION_FILE = 'kavach-service.yaml'
  QUERY_WAREHOUSE = KAVACH_WH
  MIN_INSTANCES = 1
  MAX_INSTANCES = 1
  COMMENT = 'Kavach governed risk / fraud / compliance copilot';

-- After pushing a new image or spec:
--   ALTER SERVICE KAVACH.APP.KAVACH_SERVICE FROM @KAVACH.APP.SPECS SPECIFICATION_FILE = 'kavach-service.yaml';

-- Wait for READY, check the logs
SELECT SYSTEM$GET_SERVICE_STATUS('KAVACH.APP.KAVACH_SERVICE');
SELECT SYSTEM$GET_SERVICE_LOGS('KAVACH.APP.KAVACH_SERVICE', 0, 'kavach', 100);

-- ---------------- 5. who may open the app ----------------
-- Users reach the public endpoint through Snowflake sign-in; the ingress passes their
-- login name in Sf-Context-Current-User, which Kavach records in every audit event.
GRANT SERVICE ROLE KAVACH.APP.KAVACH_SERVICE!ALL_ENDPOINTS_USAGE TO ROLE KAVACH_ADMIN;
-- GRANT SERVICE ROLE KAVACH.APP.KAVACH_SERVICE!ALL_ENDPOINTS_USAGE TO ROLE <reviewer_role>;

-- ---------------- 6. public URL ----------------
-- ingress_url column (provisioning can take a few minutes): https://<ingress_url>/
SHOW ENDPOINTS IN SERVICE KAVACH.APP.KAVACH_SERVICE;

-- Pause between demo sessions to save credits:
--   ALTER SERVICE KAVACH.APP.KAVACH_SERVICE SUSPEND;   ALTER COMPUTE POOL KAVACH_POOL SUSPEND;
--   ALTER SERVICE KAVACH.APP.KAVACH_SERVICE RESUME;
