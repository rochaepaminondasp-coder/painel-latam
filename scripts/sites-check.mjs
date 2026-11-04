// Compara os sites (portais) da Taboola entre dois dias: gasto, cliques, conversões. Grava sites.json na branch dados.
const BASE = 'https://backstage.taboola.com/backstage';
const E = k => String(process.env[k] || '').trim();
const CID = E('TABOOLA_CLIENT_ID'), SECRET = E('TABOOLA_CLIENT_SECRET'), ACC = E('TABOOLA_ACCOUNT_ID'), GH = E('GITHUB_TOKEN'), REPO = E('GITHUB_REPOSITORY');
const tr = await fetch(`${BASE}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ client_id: CID, client_secret: SECRET, grant_type: 'client_credentials' }) });
const tok = (await tr.json()).access_token;
const api = async p => { const r = await fetch(`${BASE}/api/1.0/${p}`, { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' } }); const t = await r.text(); try { return JSON.parse(t); } catch { return { erro: r.status, t: t.slice(0, 300) }; } };
const days = (E('DIAS') || '').split(',').filter(Boolean);
const out = { at: new Date().toISOString(), dias: {} };
for (const d of days) {
  const j = await api(`${ACC}/reports/campaign-summary/dimensions/site_breakdown?start_date=${d}&end_date=${d}&include_multi_conversions=false`);
  if (!j.results) { out.dias[d] = j; continue; }
  out.dias[d] = j.results.map(r => ({ site: r.site_name || r.site, id: r.site_id || r.site, spend: r.spent, clicks: r.clicks, imp: r.impressions, conv: r.cpa_actions_num, cpc: r.cpc }));
}
// campanhas x dia também (gasto e conversões)
for (const d of days) {
  const j = await api(`${ACC}/reports/campaign-summary/dimensions/campaign_breakdown?start_date=${d}&end_date=${d}`);
  out['camp_' + d] = (j.results || []).map(r => ({ id: r.campaign, nome: r.campaign_name, spend: r.spent, clicks: r.clicks, conv: r.cpa_actions_num }));
}
const h = { Authorization: `Bearer ${GH}`, Accept: 'application/vnd.github+json' };
const g = await fetch(`https://api.github.com/repos/${REPO}/contents/sites.json?ref=dados`, { headers: h });
const sha = g.ok ? (await g.json()).sha : undefined;
const p = await fetch(`https://api.github.com/repos/${REPO}/contents/sites.json`, { method: 'PUT', headers: h, body: JSON.stringify({ message: 'Sites da Taboola', branch: 'dados', sha, content: Buffer.from(JSON.stringify(out)).toString('base64') }) });
console.log('gravado', p.status);
