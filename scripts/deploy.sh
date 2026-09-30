#!/usr/bin/env bash
# Kavach: provision the Snowflake side end to end with the Snowflake CLI (`snow`).
#   1. roles / warehouse / database        (sql/00)
#   2. tables + synthetic data             (sql/01-03)
#   3. policy corpus + Cortex Search        (sql/04)
#   4. hash-chained audit log               (sql/05)
#   5. optional live-alert simulator task   (sql/06)
#   6. semantic model for Cortex Analyst
# Container image + SPCS service: see sql/07_spcs_deploy.sql.
#
# Usage: SNOW_CONNECTION=<name in ~/.snowflake/config.toml> ./scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

CONN=(${SNOW_CONNECTION:+--connection "$SNOW_CONNECTION"})
run() { echo "▶ $1"; snow sql "${CONN[@]}" -f "$1"; }

command -v snow >/dev/null || { echo "Install the Snowflake CLI: https://docs.snowflake.com/en/developer-guide/snowflake-cli/installation/installation"; exit 1; }

echo "▶ generating synthetic data"
python3 data/generate_synthetic.py

run sql/00_setup.sql
run sql/01_tables.sql

echo "▶ uploading CSVs to @KAVACH.CORE.RAW_STAGE"
snow stage copy "${CONN[@]}" "data/out/*.csv" @KAVACH.CORE.RAW_STAGE --overwrite --role KAVACH_ADMIN

run sql/02_load_data.sql
run sql/03_views.sql
run sql/04_knowledge_search.sql
run sql/05_governance.sql
run sql/06_live_alerts.sql

echo "▶ uploading semantic model"
snow stage copy "${CONN[@]}" semantic_model/kavach.yaml @KAVACH.APP.SEMANTIC_MODELS --overwrite --role KAVACH_ADMIN

echo "✅ Snowflake objects ready. Next: build + push the container and run sql/07_spcs_deploy.sql (see README)."
