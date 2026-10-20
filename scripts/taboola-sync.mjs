// Robô de tráfego da Taboola: busca na Backstage API o investimento, impressões e cliques por campanha
// e grava no data.json, igual ao robô da MGID. Os logs mostram só totais e nomes de campos.
//
// Variáveis de ambiente:
//   TABOOLA_CLIENT_ID / TABOOLA_CLIENT_SECRET  credenciais da Backstage API (segredos do repositório)
//   TABOOLA_ACCOUNT_ID  conta (ex.: minhaconta-sc); se faltar, usa a primeira conta de anunciante liberada
//   GITHUB_TOKEN / GITHUB_REPOSITORY  (o Actions preenche)
//   DAYS              quantos dias antes de hoje atualizar
//   TABOOLA_API / GITHUB_API  só para testes

const CID = String(process.env.TABOOLA_CLIENT_ID || '').trim();
const SECRET = String(process.env.TABOOLA_CLIENT_SECRET || '').trim();
let ACCOUNT = String(process.env.TABOOLA_ACCOUNT_ID || '').trim();
const GH_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const DAYS = Math.max(0, Math.min(10, Number(process.env.DAYS ?? 1)));
const BRANCH = process.env.DATA_BRANCH || 'dados';
const BASE = (process.env.TABOOLA_API || 'https://backstage.taboola.com/backstage').replace(/\/$/, '');
const GH_API = process.env.GITHUB_API || 'https://api.github.com';
const P = 'TB';

if (!CID || !SECRET) { console.log('Segredos da Taboola não configurados — pulando a Taboola.'); process.exit(0); }
if (!GH_TOKEN || !REPO) { console.error('Falta GITHUB_TOKEN / GITHUB_REPOSITORY.'); process.exit(1); }

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const today = ymd(new Date(Date.now() - 3 * 3600e3));
const days = [today]; for (let i = 1; i <= DAYS; i++) days.push(addDays(today, -i));
const num = v => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const r2 = v => Math.round(v * 100) / 100;

/* ---------- Backstage API ---------- */
let TOKEN = null;
async function auth() {
  const body = new URLSearchParams({ client_id: CID, client_secret: SECRET, grant_type: 'client_credentials' });
  const r = await fetch(`${BASE}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
  if (!r.ok) throw new Error(`Taboola recusou o login (HTTP ${r.status}). Confira TABOOLA_CLIENT_ID e TABOOLA_CLIENT_SECRET.`);
  TOKEN = (await r.json()).access_token;
  if (!TOKEN) throw new Error('Taboola não devolveu o token de acesso.');
}
async function api(path) {
  const r = await fetch(`${BASE}/api/1.0/${path}`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } });
  if (!r.ok) { let t = ''; try { t = (await r.text()).replace(/\s+/g, ' ').slice(0, 300); } catch {} throw new Error(`Taboola ${path.split('?')[0]}: HTTP ${r.status} ${t}`); }
  return r.json();
}

/* ---------- país da campanha ---------- */
const CC = { AR: ['argentina'], CL: ['chile'], CO: ['colombia'], MX: ['mexico'], PE: ['peru'], EC: ['ecuador', 'equador'], UY: ['uruguay', 'uruguai'], PY: ['paraguay', 'paraguai'], BO: ['bolivia'], CR: ['costa rica'], PA: ['panama'], GT: ['guatemala'], DO: ['dominicana'], SV: ['el salvador'], HN: ['honduras'], VE: ['venezuela'], US: ['estados unidos', 'united states'], ES: ['espana', 'espanha', 'spain'], BR: ['brasil', 'brazil'] };
function countryOf(name) {
  const n = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const hits = new Set(Object.entries(CC).filter(([, a]) => a.some(w => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(n))).map(([c]) => c));
  for (const t of String(name || '').match(/\b[A-Z]{2}\b/g) || []) if (CC[t] && !['DO', 'ES', 'PE'].includes(t)) hits.add(t);
  return hits.size === 1 ? [...hits][0] : 'XX';
}

/* ---------- cotação (se a conta da Taboola for em dólar) ---------- */
const BCB = 'https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarDia(dataCotacao=@dataCotacao)';
async function usdBrl(day) {
  for (let back = 0; back < 6; back++) {
    const d = addDays(day, -back), [y, m, dd] = d.split('-');
    try {
      const r = await fetch(`${BCB}?@dataCotacao='${m}-${dd}-${y}'&$format=json`, { headers: { Accept: 'application/json' } });
      if (r.ok) { const j = await r.json(); const v = Number(j?.value?.[0]?.cotacaoVenda); if (v > 0) return v; }
    } catch {}
  }
  return null;
}

/* ---------- data.json via API do GitHub ---------- */
const ghHeaders = { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
async function getData() {
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/data.json?ref=${BRANCH}&t=${Date.now()}`, { headers: ghHeaders });
  if (!r.ok) throw new Error('GitHub GET data.json: HTTP ' + r.status);
  const j = await r.json();
  return { data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')), sha: j.sha };
}
async function putData(data, sha, message) {
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/data.json`, { method: 'PUT', headers: ghHeaders, body: JSON.stringify({ message, content: Buffer.from(JSON.stringify(data)).toString('base64'), branch: BRANCH, sha }) });
  return r.status;
}

/* ---------- principal ---------- */
await auth();
if (!ACCOUNT) {
  const j = await api('users/current/allowed-accounts');
  const list = j?.results || [];
  const adv = list.find(a => (a.partner_types || []).includes('ADVERTISER')) || list[0];
  ACCOUNT = adv?.account_id || '';
  if (!ACCOUNT) throw new Error('Não achei nenhuma conta liberada para essas credenciais. Configure TABOOLA_ACCOUNT_ID.');
  console.log(`Taboola: usando a conta ${ACCOUNT} (${list.length} liberada(s)).`);
}
console.log(`Taboola: atualizando ${days.slice().reverse().join(', ')} …`);

// campanhas e seus países de segmentação
const target = {}, names = {}, status = {};
try {
  const j = await api(`${ACCOUNT}/campaigns/?fetch_level=R`);
  status.campaigns = (j?.results || []).length;
  status.running = (j?.results || []).filter(c => c.is_active && String(c.status || '').toUpperCase() === 'RUNNING').length;
  status.statuses = [...new Set((j?.results || []).map(c => String(c.status || '?')))].join(',');
  for (const c of j?.results || []) {
    const id = String(c.id); names[id] = c.name;
    const t = c.country_targeting;
    target[id] = (t && t.type === 'INCLUDE' && Array.isArray(t.value) && t.value.length === 1) ? String(t.value[0]).toUpperCase() : null;
  }
} catch (e) { console.log('Taboola: não li a segmentação das campanhas (' + e.message.slice(0, 120) + ') — uso o nome da campanha.'); }

const rep = await api(`${ACCOUNT}/reports/campaign-summary/dimensions/campaign_day_breakdown?start_date=${days[days.length - 1]}&end_date=${days[0]}`);
const rowsRep = rep?.results || [];
if (rowsRep[0]) console.log('Taboola: campos do relatório: ' + Object.keys(rowsRep[0]).join(', '));
status.rows = rowsRep.length; status.fields = rowsRep[0] ? Object.keys(rowsRep[0]).join(',') : '';
const currency = String(rowsRep.find(r => r.currency)?.currency || 'USD').toUpperCase();
console.log(`Taboola: ${rowsRep.length} linhas (campanha × dia) · moeda: ${currency}`);

const perDay = Object.fromEntries(days.map(d => [d, {}]));
for (const row of rowsRep) {
  const d = String(row.date || '').slice(0, 10), cid = String(row.campaign ?? '');
  if (!perDay[d] || !cid) continue;
  if (row.campaign_name) names[cid] = row.campaign_name;
  const o = perDay[d][cid] || (perDay[d][cid] = { spend: 0, imp: 0, clicks: 0, conv: 0 });
  o.spend += num(row.spent); o.imp += num(row.impressions); o.clicks += num(row.clicks); o.conv += num(row.cpa_actions_num);
}

for (let attempt = 1; attempt <= 5; attempt++) {
  const { data, sha } = await getData();
  const s = data.settings = data.settings || {}; s.cidMap = s.cidMap || {};
  if (!(s.platforms || []).includes(P)) s.platforms = [...(s.platforms || []), P];
  const brl = String(s.currency || 'BRL').toUpperCase() !== 'USD' && currency === 'USD';
  const stNew = { account: ACCOUNT, ...status }, { at: _a, ...stOld } = s.tbStatus || {};
  let changed = JSON.stringify(stOld) === JSON.stringify(stNew) ? 0 : 1;
  if (changed) console.log(`Taboola: ${status.campaigns ?? '?'} campanhas na conta (${status.running ?? '?'} rodando) · status: ${status.statuses || '—'}`);
  s.tbStatus = { at: new Date().toISOString(), ...stNew };
  for (const d of days) {
    const fx = brl ? (num(s.usdBrl) || await usdBrl(d) || 5.4) : 1;
    const camps = Object.entries(perDay[d]).map(([cid, v]) => ({ cid, spend: r2(v.spend * fx), imp: Math.round(v.imp), clicks: Math.round(v.clicks), conv: Math.round(v.conv) }))
      .filter(c => c.spend || c.clicks || c.imp);
    const e = data.entries[d] || (camps.length ? (data.entries[d] = { rows: [], ads: [], refunds: 0, other: 0, notes: '' }) : null);
    if (!e) continue;
    e.rows = e.rows || []; e.ads = e.ads || [];
    const before = JSON.stringify([e.rows.filter(r => r.p === P), e.ads.filter(a => a.p === P), e.tbGeo || null]);
    e.rows.forEach(r => { if (r.p === P) { r.spend = 0; r.imp = 0; r.clicks = 0; } });
    const geo = {};
    const addRow = (rc, v) => {
      let r = e.rows.find(x => x.p === P && x.cc === rc);
      if (!r) { r = { p: P, cc: rc, spend: 0, imp: 0, clicks: 0, pv: 0, link: 0, ic: 0, sales: 0, rev: 0, ups: 0, upsRev: 0 }; e.rows.push(r); }
      r.spend = r2(r.spend + v.spend); r.imp += v.imp; r.clicks += v.clicks;
    };
    for (const c of camps) {
      const known = e.ads.find(a => a.p === P && String(a.cid || '') === c.cid);
      const name = names[c.cid] || known?.name || `Campanha ${c.cid}`;
      const key = P + ':' + c.cid;
      const cc = target[c.cid] || s.cidMap[key] || (known ? (known.cc || 'XX') : countryOf(name));
      s.cidMap[key] = cc;
      let split = null;
      if (cc === 'XX') { // vários países: gasto pelo país real dos cliques
        try {
          const g = await api(`${ACCOUNT}/reports/campaign-summary/dimensions/country_breakdown?start_date=${d}&end_date=${d}&campaign=${c.cid}`);
          split = {};
          for (const row of g?.results || []) {
            const k = String(row.country || '').toUpperCase().slice(0, 2) || 'OT';
            const m = { spend: r2(num(row.spent) * fx), imp: Math.round(num(row.impressions)), clicks: Math.round(num(row.clicks)), pv: 0, ic: 0 };
            if (m.spend || m.clicks || m.imp) { addRow(k, m); split[k] = m; }
          }
          if (!Object.keys(split).length) split = null;
        } catch { split = null; }
      }
      if (split) geo[c.cid] = split; else addRow(cc, c);
      const a = known || (e.ads.push({ name, p: P, cc: cc === 'XX' ? '' : cc, cid: c.cid, spend: 0, clicks: 0, sales: 0, rev: 0 }), e.ads[e.ads.length - 1]);
      Object.assign(a, { name, cid: c.cid, spend: c.spend, clicks: c.clicks, conv: c.conv });
    }
    const seen = new Set(camps.map(c => c.cid));
    e.ads.forEach(a => { if (a.p === P && a.cid && !seen.has(String(a.cid))) Object.assign(a, { spend: 0, clicks: 0, conv: 0 }); });
    if (Object.keys(geo).length) e.tbGeo = geo; else delete e.tbGeo;
    e.rows = e.rows.filter(r => r.p !== P || ['spend', 'imp', 'clicks', 'pv', 'ic', 'sales', 'rev', 'ups', 'upsRev'].some(k => num(r[k])));
    const after = JSON.stringify([e.rows.filter(r => r.p === P), e.ads.filter(a => a.p === P), e.tbGeo || null]);
    if (before === after && e.tb) continue;
    e.tb = { at: new Date().toISOString(), src: 'taboola', cur: currency, fx: fx === 1 ? null : r2(fx * 100) / 100 };
    changed++;
    const t = camps.reduce((x, c) => ({ s: x.s + c.spend, k: x.k + c.clicks, v: x.v + c.conv }), { s: 0, k: 0, v: 0 });
    console.log(`  ${d}: ${camps.length} campanhas · investimento ${t.s.toFixed(2)} · ${t.k} cliques · ${t.v} conversões (pixel)`);
  }
  if (!changed) { console.log('Taboola: nada mudou desde a última atualização.'); process.exit(0); }
  const st = await putData(data, sha, `Tráfego da Taboola · ${days.map(d => d.slice(8, 10) + '/' + d.slice(5, 7)).reverse().join(', ')}`);
  if (st === 200 || st === 201) { console.log(`Taboola pronta: ${changed} dia(s) atualizado(s).`); process.exit(0); }
  if (st !== 409 && st !== 422) { console.error('GitHub recusou a gravação: HTTP ' + st); process.exit(1); }
  await new Promise(r => setTimeout(r, 1500 * attempt));
}
console.error('Não consegui gravar depois de 5 tentativas.'); process.exit(1);
