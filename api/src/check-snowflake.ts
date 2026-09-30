/**
 * Live Snowflake connection check: exercises every Snowflake service Kavach uses, one at a time,
 * and prints what works, what fails and the likely fix.
 *
 *   npm run check:snowflake            # read-only checks
 *   npm run check:snowflake -- --write # also appends one CONNECTION_CHECK event to the audit log
 */
import * as config from './kavach/config';
import { resolveSnowflakeAuth } from './kavach/backends/snowflake-auth';
import { SnowflakeBackend } from './kavach/backends/snowflake.backend';

type Status = 'PASS' | 'FAIL' | 'WARN';
const results: { name: string; status: Status; detail: string }[] = [];
const C = { PASS: '\x1b[32m', FAIL: '\x1b[31m', WARN: '\x1b[33m', dim: '\x1b[2m', off: '\x1b[0m' };

const HINTS: [RegExp, string][] = [
  [/network policy/i, 'PATs need the user to be covered by a network policy. Add your IP to a policy, or switch to key-pair auth.'],
  [/JWT token is invalid|\bHTTP 401\b|authenticat/i, 'Auth rejected. Check SNOWFLAKE_ACCOUNT/USER, that the public key is set on the user (ALTER USER ... SET RSA_PUBLIC_KEY), or regenerate the PAT.'],
  [/does not exist or not authorized/i, 'Object missing or role lacks grants. Did scripts/deploy.sh finish? Is SNOWFLAKE_ROLE=KAVACH_APP granted to your user?'],
  [/warehouse/i, 'Warehouse problem. Check SNOWFLAKE_WAREHOUSE=KAVACH_WH exists and KAVACH_APP has USAGE on it; for Cortex Analyst also set it as the user default: ALTER USER <you> SET DEFAULT_WAREHOUSE = KAVACH_WH;'],
  [/unavailable in your region|not available|unknown model|model.*not found|legacy state/i, 'Model unavailable or retired. Remove it from KAVACH_LLM_MODELS in api/.env (or enable cross-region: ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = \'ANY_REGION\').'],
  [/CORTEX_USER|insufficient privileges/i, 'Grant Cortex: GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE KAVACH_APP;'],
  [/semantic model|semantic_model|yaml/i, 'Semantic model issue. Re-upload: snow stage copy semantic_model/kavach.yaml @KAVACH.APP.SEMANTIC_MODELS --overwrite (and GRANT READ ON STAGE to KAVACH_APP).'],
  [/ENOTFOUND|getaddrinfo|fetch failed/i, 'Cannot reach the host. SNOWFLAKE_HOST should look like <orgname>-<account>.snowflakecomputing.com (no https://).'],
];
const hint = (msg: string) => HINTS.find(([re]) => re.test(msg))?.[1];

async function check(name: string, fn: () => Promise<string | { status: Status; detail: string }>): Promise<void> {
  const t0 = Date.now();
  process.stdout.write(`${C.dim}… ${name}${C.off}\r`);
  try {
    const out = await fn();
    const r = typeof out === 'string' ? { status: 'PASS' as Status, detail: out } : out;
    results.push({ name, ...r });
    console.log(`${C[r.status]}${r.status.padEnd(4)}${C.off} ${name} ${C.dim}(${Date.now() - t0}ms)${C.off}\n     ${r.detail}`);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    results.push({ name, status: 'FAIL', detail: msg });
    console.log(`${C.FAIL}FAIL${C.off} ${name} ${C.dim}(${Date.now() - t0}ms)${C.off}\n     ${msg.slice(0, 400)}`);
    const h = hint(msg);
    if (h) console.log(`     ${C.WARN}→ ${h}${C.off}`);
  }
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  console.log('\nKavach · live Snowflake check\n');

  let backend: SnowflakeBackend;
  try {
    const auth = resolveSnowflakeAuth();
    if (!auth) throw new Error('No credentials: set SNOWFLAKE_PAT, or SNOWFLAKE_ACCOUNT + SNOWFLAKE_USER + SNOWFLAKE_PRIVATE_KEY_PATH in api/.env');
    backend = new SnowflakeBackend(auth);
    console.log(`${C.PASS}PASS${C.off} credentials\n     ${backend.mode} → https://${auth.host} · role ${config.SNOWFLAKE_ROLE} · warehouse ${config.SNOWFLAKE_WAREHOUSE}`);
  } catch (e) {
    console.log(`${C.FAIL}FAIL${C.off} credentials\n     ${(e as Error).message}`);
    process.exit(1);
  }

  await check('SQL API · session', async () => {
    const t = await backend.sql.execute('SELECT CURRENT_USER() AS U, CURRENT_ROLE() AS R, CURRENT_WAREHOUSE() AS W, CURRENT_REGION() AS REG');
    const r = t.rows[0];
    return `user ${r.U} · role ${r.R} · warehouse ${r.W} · region ${r.REG}`;
  });

  await check('Data · KAVACH.CORE tables', async () => {
    const k = await backend.kpis();
    if (!k.openAlerts && !k.totalExposure) return { status: 'WARN', detail: 'Tables are reachable but empty. Re-run sql/02_load_data.sql.' };
    return `${k.openAlerts} open alerts · ₹${(k.totalExposure / 1e7).toFixed(1)} Cr exposure · ${k.highRiskKycOverdue} high-risk KYC overdue`;
  });

  // Each model individually, so you see exactly which ones your region offers.
  const working: string[] = [];
  for (const model of config.LLM_MODELS) {
    await check(`Cortex COMPLETE · ${model}`, async () => {
      const t = await backend.sql.execute('SELECT SNOWFLAKE.CORTEX.COMPLETE(?, ?) AS R', [model, 'Reply with exactly: KAVACH OK']);
      working.push(model);
      return `replied "${String(t.rows[0].R).trim().slice(0, 60)}"`;
    });
  }
  if (!working.length) console.log(`     ${C.WARN}→ No model worked. The app will still run, with deterministic (non-LLM) answers.${C.off}`);
  else if (working[0] !== config.LLM_MODELS[0]) console.log(`     ${C.WARN}→ Tip: put ${working[0]} first in KAVACH_LLM_MODELS to skip failing models.${C.off}`);

  await check('Cortex Search · POLICY_SEARCH', async () => {
    const hits = await backend.search('structuring cash deposits below threshold escalation', 3);
    if (!hits.length) return { status: 'WARN', detail: 'Service answered with 0 hits. Is POLICY_CHUNKS loaded (sql/04)? Indexing can take a minute after creation.' };
    return hits.map((h) => `${h.chunkId}${h.score !== null ? ` (${h.score.toFixed(2)})` : ''}`).join(' · ');
  });

  await check('Cortex Analyst · semantic model', async () => {
    const a = await backend.analyst('How many open alerts do we have by rule and severity?');
    if (!a.sql) return { status: 'WARN', detail: `No SQL returned. Analyst said: ${a.text.slice(0, 200)}` };
    const t = await backend.runSql(a.sql, 50);
    return `${a.verifiedQueryUsed ? 'verified query' : 'generated SQL'} · ${t.rows.length} rows · ${a.sql.split('\n')[0].slice(0, 80)}`;
  });

  await check('Audit log · hash chain', async () => {
    const s = await backend.chainStatus();
    if (s.valid !== s.rows) return { status: 'FAIL', detail: `${s.valid}/${s.rows} records verify. The chain is broken.` };
    return `${s.valid}/${s.rows} records verify`;
  });

  if (write) {
    await check('Audit log · LOG_EVENT write', async () => {
      const r = await backend.logEvent('CONNECTION_CHECK', 'check-script', { note: 'npm run check:snowflake -- --write' });
      return `appended #${r.auditSeq} · ${r.rowHash.slice(0, 16)}…`;
    });
  }

  const fails = results.filter((r) => r.status === 'FAIL').length;
  const warns = results.filter((r) => r.status === 'WARN').length;
  console.log(`\n${fails ? C.FAIL : warns ? C.WARN : C.PASS}${results.length - fails - warns} passed · ${warns} warnings · ${fails} failed${C.off}`);
  console.log(fails ? 'Fix the failures above, then re-run.\n' : 'Ready. Start the app with: KAVACH_BACKEND=snowflake npm start\n');
  process.exit(fails ? 1 : 0);
}

main();
