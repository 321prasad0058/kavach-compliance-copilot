# Connecting Kavach to Snowflake (live Cortex)

This takes Kavach from **Offline mock** to real **Cortex COMPLETE, Cortex Analyst and Cortex Search** on your own Snowflake account. Allow 30–45 minutes the first time.

---

## 1. Get an account

* **Hackathon credits:** claim them from the official Hack2skill event page, not from a link in a forwarded email.
* **Or a 30-day trial:** https://signup.snowflake.com with **Enterprise** edition, **AWS**, region **US West (Oregon)** or **US East (N. Virginia)**. These regions host the widest set of Cortex models, including Claude.

Note your **account identifier**. In Snowsight, open your name (bottom left), then **Connect a tool to Snowflake** or **View account details**. It looks like `ORGNAME-ACCOUNTNAME`.

## 2. Install the Snowflake CLI and connect

```bash
brew install snowflake-cli          # or: pipx install snowflake-cli
snow connection add                 # name: kavach · account: ORGNAME-ACCOUNTNAME · user · password
snow connection test -c kavach
```

Use your admin (ACCOUNTADMIN) user for this step, because the setup script creates roles and a warehouse.

## 3. Create everything Kavach needs

```bash
cd ~/Desktop/kavach
SNOW_CONNECTION=kavach ./scripts/deploy.sh
```

This creates:
* the `KAVACH_ADMIN` and `KAVACH_APP` roles, both granted to your user
* the `KAVACH_WH` warehouse (XS, auto-suspend 60 s)
* the synthetic tables and data
* the Cortex Search service `KAVACH.KNOWLEDGE.POLICY_SEARCH`
* the hash-chained audit log
* the semantic model on `@KAVACH.APP.SEMANTIC_MODELS`

Then, in a Snowsight worksheet **as ACCOUNTADMIN**:

```sql
-- Use models from other regions if yours lacks one (safe to leave on for the hackathon)
ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION';

-- Cortex Analyst runs on your default warehouse
ALTER USER <your_user> SET DEFAULT_WAREHOUSE = KAVACH_WH;
```

## 4. Smoke-test Cortex directly in Snowsight

Run these as role `KAVACH_APP`. Each one should return something sensible.

```sql
USE ROLE KAVACH_APP; USE WAREHOUSE KAVACH_WH;

-- LLM
SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-sonnet-4-5', 'Say KAVACH OK');

-- Retrieval
SELECT PARSE_JSON(SNOWFLAKE.CORTEX.SEARCH_PREVIEW('KAVACH.KNOWLEDGE.POLICY_SEARCH',
  '{"query":"structuring cash deposits","columns":["chunk_id","section_title"],"limit":3}')):results;

-- Data + governance
SELECT * FROM KAVACH.CORE.PORTFOLIO_KPIS;
SELECT * FROM KAVACH.GOV.V_AUDIT_CHAIN_CHECK;
```

**Cortex Analyst** has a playground in Snowsight: **AI & ML → Cortex Analyst**, then open `KAVACH.APP.SEMANTIC_MODELS / kavach.yaml`. Ask *"Show me accounts flagged for structuring this week"* and you should get 3 rows from the verified query.

## 5. Give the Kavach API credentials

Key-pair authentication is the recommended option because it needs no network policy.

```bash
mkdir -p ~/.kavach && cd ~/.kavach
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out rsa_key.p8 -nocrypt
openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub
grep -v "PUBLIC KEY" rsa_key.pub | tr -d '\n'; echo      # copy this value
```

```sql
ALTER USER <your_user> SET RSA_PUBLIC_KEY = '<paste the value>';
```

A **programmatic access token (PAT)** also works. Create one in Snowsight under **Settings → Authentication → Programmatic access tokens**. Depending on account settings, PATs may require your user to be covered by a network policy.

Now create `api/.env`:

```bash
cd ~/Desktop/kavach/api && cp .env.example .env
```

Set these values in `api/.env`:

```ini
KAVACH_BACKEND=snowflake
SNOWFLAKE_ACCOUNT=ORGNAME-ACCOUNTNAME
SNOWFLAKE_USER=YOUR_USER
SNOWFLAKE_PRIVATE_KEY_PATH=/Users/<you>/.kavach/rsa_key.p8
# or, instead of the three lines above for key pair:
# SNOWFLAKE_HOST=orgname-accountname.snowflakecomputing.com
# SNOWFLAKE_PAT=<token>
SNOWFLAKE_ROLE=KAVACH_APP
SNOWFLAKE_WAREHOUSE=KAVACH_WH
```

`.env` and `*.p8` files are git-ignored. Never commit them.

## 6. Run the connection check

```bash
cd ~/Desktop/kavach/api
npm run check:snowflake             # read-only
npm run check:snowflake -- --write  # also appends one CONNECTION_CHECK event to the audit log
```

This checks credentials, the SQL API session, the data tables, **every model** in `KAVACH_LLM_MODELS` one at a time, Cortex Search, Cortex Analyst, and the audit chain. It prints a fix for each failure. If some models fail, put a working one first in `KAVACH_LLM_MODELS`.

## 7. Run Kavach live

```bash
cd ~/Desktop/kavach/web && npx ng build     # once, or after UI changes
cd ../api && npm run build && npm start     # loads api/.env
```

Open **http://localhost:8080**. The nav pill now reads **Snowflake · Key-pair JWT** (or **· PAT**) instead of **Offline mock**, and the answer card shows the real model name.

On demo day, run these first:

```sql
CALL KAVACH.CORE.REBASE_DATES();                        -- makes "this week" mean this week
ALTER TASK KAVACH.CORE.SIMULATE_ALERTS_TASK RESUME;     -- optional live alert feed (suspend after!)
```

Then follow [DEMO_SCRIPT.md](DEMO_SCRIPT.md), and confirm each step landed in Snowflake:

```sql
SELECT audit_seq, event_type, app_user, route, confidence, question
FROM KAVACH.GOV.AUDIT_LOG ORDER BY audit_seq DESC LIMIT 10;
```

## 8. Host it inside Snowflake (the deployed link for submission)

Follow `sql/07_spcs_deploy.sql`. In short: create an image repository and compute pool, `docker build --platform linux/amd64 -t kavach .`, push the image to the repository, then `CREATE SERVICE`. `SHOW ENDPOINTS IN SERVICE` gives the public URL. Inside SPCS the API authenticates with the service's own OAuth token, so no `.env` is needed, and the signed-in Snowflake user is written to every audit row.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `JWT token is invalid` / 401 | The public key isn't set on the user, or `SNOWFLAKE_ACCOUNT` / `SNOWFLAKE_USER` don't match. Check with `DESC USER <you>` (RSA_PUBLIC_KEY_FP). |
| `does not exist or not authorized` | `deploy.sh` didn't finish, or `KAVACH_APP` isn't granted to your user: `GRANT ROLE KAVACH_APP TO USER <you>;` |
| Every COMPLETE model fails | Enable cross-region inference (step 3) and check `GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE KAVACH_APP;` |
| Analyst errors about the warehouse | `ALTER USER <you> SET DEFAULT_WAREHOUSE = KAVACH_WH;` |
| Search returns 0 hits | The service indexes asynchronously. Wait a minute, then check `SELECT COUNT(*) FROM KAVACH.KNOWLEDGE.POLICY_CHUNKS;` (expect 60). |
| "this week" questions return nothing | `CALL KAVACH.CORE.REBASE_DATES();` |
| Finding generation times out | Raise `KAVACH_SQL_TIMEOUT_S` in `api/.env` (e.g. 120). |

**Cost:** everything runs on one XS warehouse that auto-suspends after 60 s. Cortex calls are billed per token. Suspend the alert simulator task when you aren't demoing.
