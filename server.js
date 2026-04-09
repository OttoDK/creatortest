const http = require('http');
const fs = require('fs');
const path = require('path');
const { BigQuery } = require('@google-cloud/bigquery');

const PORT = process.env.PORT || 3000;
const bq = new BigQuery();

const QUERY_PROGRAM = `
SELECT p.program_id, p.brand_name, p.benchmarking_vertical,
  p.program_status, CAST(p.activation_date AS STRING) AS activation_date,
  CAST(p.program_rating AS FLOAT64) AS program_rating,
  p.active_partnership_count,
  p.last_30_day_day_productive_partnership_count AS productive_30d,
  p.last_90_day_productive_partnership_count AS productive_90d,
  p.last_180_day_productive_partnership_count AS productive_180d,
  p.last_365_day_productive_partnership_count AS productive_365d,
  p.pending_application_count,
  p.last_90_day_application_received_count AS apps_received_90d,
  p.last_90_day_application_approved_count AS apps_approved_90d,
  p.last_90_day_application_declined_count AS apps_declined_90d,
  CAST(p.last_30_day_day_gtv AS FLOAT64) AS gtv_30d,
  CAST(p.last_31_to_60_day_gtv AS FLOAT64) AS gtv_31_60d,
  CAST(p.last_30_day_day_gmv AS FLOAT64) AS gmv_30d,
  CAST(p.last_31_to_60_day_gmv AS FLOAT64) AS gmv_31_60d,
  CAST(p.last_30_day_day_top_10_publisher_gtv_contribution_ratio AS FLOAT64) AS top10_gtv_ratio
FROM \`prod-data-enablement.analytics.program\` p
WHERE p.brand_id = @brand_id
ORDER BY p.active_partnership_count DESC
LIMIT 1`;

const QUERY_PARTNERSHIPS = `
SELECT COUNT(DISTINCT pa.publisher_id) AS total_influencers,
  SUM(CASE WHEN pa.has_active_contract = 1 THEN 1 ELSE 0 END) AS active_contracts,
  SUM(CASE WHEN pa.last_30_day_day_action_count > 0 THEN 1 ELSE 0 END) AS active_last_30d,
  CAST(SUM(pa.last_30_day_day_gtv) AS FLOAT64) AS influencer_gtv_30d,
  CAST(SUM(pa.last_30_day_day_action_gtv) AS FLOAT64) AS influencer_action_gtv_30d,
  CAST(SUM(pa.last_30_day_day_nonaction_gtv) AS FLOAT64) AS influencer_nonaction_gtv_30d,
  CAST(SUM(pa.lifetime_gtv) AS FLOAT64) AS influencer_lifetime_gtv,
  CAST(SUM(pa.lifetime_gmv) AS FLOAT64) AS influencer_lifetime_gmv
FROM \`prod-data-enablement.analytics.partnership_affiliation\` pa
JOIN \`prod-data-enablement.analytics.publisher\` pub
  ON pa.publisher_id = pub.publisher_id
WHERE pa.brand_id = @brand_id
  AND pub.primary_promo_method = 'SOCIAL_INFLUENCER'`;

const QUERY_CONTACTS = `
SELECT firstname, lastname, email, username, csm_name, csm_email,
  CAST(user_last_login_datetime AS STRING) AS last_login
FROM \`prod-data-enablement.reporting.brand_user_email\`
WHERE brand_account_id = @brand_id
  AND user_access_active = 1
  AND user_global_optout = 0
ORDER BY user_last_login_datetime DESC
LIMIT 10`;

const QUERY_MONTHLY = `
SELECT CAST(agg.event_month AS STRING) AS event_month,
  SUM(agg.click_count) AS clicks,
  SUM(agg.total_action_count) AS actions,
  CAST(SUM(agg.total_gtv) AS FLOAT64) AS gtv,
  CAST(SUM(COALESCE(agg.retail_gmv,0) + COALESCE(agg.nonretail_gmv,0)) AS FLOAT64) AS gmv,
  CAST(SUM(COALESCE(agg.paid_placement_gtv,0)) AS FLOAT64) AS flat_fees,
  CAST(SUM(COALESCE(agg.performance_bonus_gtv,0)) AS FLOAT64) AS bonuses,
  CAST(SUM(COALESCE(agg.action_gtv,0)) AS FLOAT64) AS commission_gtv,
  COUNT(DISTINCT agg.publisher_id) AS active_pubs
FROM \`prod-data-enablement.analytics.agg_monthly_activity_program_publisher\` agg
JOIN \`prod-data-enablement.analytics.publisher\` pub
  ON agg.publisher_id = pub.publisher_id
WHERE agg.brand_id = @brand_id
  AND pub.primary_promo_method = 'SOCIAL_INFLUENCER'
  AND agg.event_month >= DATE_SUB(CURRENT_DATE(), INTERVAL 12 MONTH)
GROUP BY agg.event_month
ORDER BY agg.event_month`;

async function runQuery(sql, brandId) {
  const options = {
    query: sql,
    params: { brand_id: parseInt(brandId) },
    location: 'US',
  };
  const [rows] = await bq.query(options);
  return rows.map(row => {
    const obj = {};
    for (const [k, v] of Object.entries(row)) {
      if (v && typeof v === 'object' && v.value !== undefined) obj[k] = v.value;
      else obj[k] = v;
    }
    return obj;
  });
}

async function fetchBrandData(brandId) {
  const [programRows, partnershipRows, monthlyRows, contactRows] = await Promise.all([
    runQuery(QUERY_PROGRAM, brandId),
    runQuery(QUERY_PARTNERSHIPS, brandId),
    runQuery(QUERY_MONTHLY, brandId),
    runQuery(QUERY_CONTACTS, brandId),
  ]);

  if (!programRows.length) {
    throw new Error(`No program found for brand_id ${brandId}`);
  }

  return {
    program: programRows[0],
    partnerships: partnershipRows[0] || { total_influencers: 0, active_contracts: 0, active_last_30d: 0 },
    monthly: monthlyRows,
    contacts: contactRows,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/brand-data') {
    const brandId = url.searchParams.get('brand_id');
    if (!brandId || !/^\d+$/.test(brandId)) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'brand_id is required and must be numeric' }));
      return;
    }

    try {
      console.log(`Fetching data for brand_id=${brandId}...`);
      const data = await fetchBrandData(brandId);
      console.log(`  Done. Program: ${data.program.brand_name}, ${data.monthly.length} months of data`);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error(`  Error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'initiative-advisor.html');
    fs.readFile(htmlPath, 'utf8', (err, data) => {
      if (err) { res.writeHead(500); res.end('File read error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Initiative Advisor running at http://localhost:${PORT}`);
  console.log('API endpoint: GET /api/brand-data?brand_id=<ID>');
});
