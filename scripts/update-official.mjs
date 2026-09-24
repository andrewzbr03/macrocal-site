import fs from 'node:fs/promises';

// FRED publishes these series from ETA, BLS, and BEA. Observation dates are
// shown explicitly because they are not the same thing as calendar release dates.
const SERIES = {
  claims: 'ICSA', unemployment: 'UNRATE', payrolls: 'PAYEMS', jolts: 'JTSJOL',
  cpi: 'CPIAUCSL', coreCpi: 'CPILFESL', pce: 'PCEPI', corePce: 'PCEPILFE'
};
const SOURCE = 'https://fred.stlouisfed.org/series/';
const value = n => Number(n.toFixed(1)).toString();
const claimsValue = n => `${value(n / 1000)}K`;
const monthChange = rows => rows.length < 2 ? null : `${value((rows.at(-1).value / rows.at(-2).value - 1) * 100)}%`;
const latest = rows => rows.at(-1);

export function parseFredCsv(csv, id) {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.shift()?.trim() !== `observation_date,${id}`) throw new Error(`Unexpected ${id} CSV header`);
  const rows = lines.map(line => {
    const [date, raw] = line.split(',');
    return { date, value: Number(raw) };
  }).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.value) && row.value > 0);
  if (!rows.length) throw new Error(`No observations in ${id}`);
  return rows;
}

export function releaseDateForClaims(weekEnding) {
  // ETA's weekly initial claims observation ends Saturday and is normally
  // released the following Thursday. Match only scheduled Thursday events.
  return new Date(Date.parse(`${weekEnding}T12:00:00Z`) + 5 * 86400000).toISOString().slice(0, 10);
}

export function buildOfficialFeed(series, generatedAt = new Date().toISOString()) {
  const readings = {};
  const add = (family, label, id, formatted) => {
    const row = series[id]?.at(-1);
    if (row && formatted !== null) (readings[family] ||= []).push({ label, value: formatted, period: row.date, url: SOURCE + id });
  };
  add('claims', 'Initial claims', 'ICSA', series.ICSA && claimsValue(latest(series.ICSA).value));
  add('jobs', 'Nonfarm payroll change', 'PAYEMS', series.PAYEMS && series.PAYEMS.length > 1 ? `${value(latest(series.PAYEMS).value - series.PAYEMS.at(-2).value)}K` : null);
  add('jobs', 'Unemployment rate', 'UNRATE', series.UNRATE && `${value(latest(series.UNRATE).value)}%`);
  add('jolts', 'Job openings', 'JTSJOL', series.JTSJOL && `${value(latest(series.JTSJOL).value / 1000)}M`);
  for (const [family, label, id] of [
    ['cpi', 'Headline CPI MoM', 'CPIAUCSL'], ['cpi', 'Core CPI MoM', 'CPILFESL'],
    ['pce', 'Headline PCE MoM', 'PCEPI'], ['pce', 'Core PCE MoM', 'PCEPILFE']
  ]) add(family, label, id, series[id] && monthChange(series[id]));

  const claimsByRelease = {};
  const claims = series.ICSA || [];
  for (let i = Math.max(1, claims.length - 30); i < claims.length; i++) {
    const current = claims[i], previous = claims[i - 1];
    claimsByRelease[releaseDateForClaims(current.date)] = {
      actual: claimsValue(current.value), previous: claimsValue(previous.value),
      period: current.date, url: SOURCE + 'ICSA'
    };
  }
  return { generated_at: generatedAt, readings, claims_by_release: claimsByRelease };
}

async function update() {
  const old = await fs.readFile('data/official-readings.json', 'utf8').then(JSON.parse).catch(() => ({ readings: {} }));
  const series = {};
  await Promise.all(Object.values(SERIES).map(async id => {
    try {
      const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, { headers: { 'User-Agent': 'MacroCal-Official-Readings/1.0' }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      series[id] = parseFredCsv(await res.text(), id);
    } catch (err) { console.warn(`FRED ${id}: ${err.message}`); }
  }));
  if (!Object.keys(series).length) throw new Error('All official readings unavailable');
  const fresh = buildOfficialFeed(series);
  const readings = { ...old.readings, ...fresh.readings };
  const claims_by_release = { ...old.claims_by_release, ...fresh.claims_by_release };
  await fs.writeFile('data/official-readings.json', JSON.stringify({ generated_at: fresh.generated_at, readings, claims_by_release }, null, 2) + '\n');
  console.log(`Updated ${Object.keys(fresh.readings).length} official reading groups`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  update().catch(err => { console.warn(`Official reading refresh skipped: ${err.message}`); process.exitCode = 0; });
}
