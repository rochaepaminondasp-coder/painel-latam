// Robô de tráfego: busca na API da MGID o investimento e o funil por campanha e grava no data.json.
// Roda no GitHub Actions junto com o robô da Ratoeira. Os logs mostram só totais e nomes de campos.
//
// Variáveis de ambiente:
//   MGID_TOKEN        token da API da MGID (segredo do repositório)
//   MGID_CLIENT_ID    ID do cliente anunciante (padrão abaixo)
//   GITHUB_TOKEN / GITHUB_REPOSITORY  (o Actions preenche)
//   DAYS              quantos dias para trás atualizar (padrão 3)
//   MGID_API / GITHUB_API  só para testes

const TOKEN = process.env.MGID_TOKEN;
const CLIENT = process.env.MGID_CLIENT_ID || '996870';
const GH_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const DAYS = Math.max(1, Math.min(10, Number(process.env.DAYS || 3)));
const API = (process.env.MGID_API || 'https://api.mgid.com/v1').replace(/\/$/, '');
const GH_API = process.env.GITHUB_API || 'https://api.github.com';
const P = 'MG';

if (!TOKEN) { console.log('Segredo MGID_TOKEN não configurado — pulando a MGID.'); process.exit(0); }
if (!GH_TOKEN || !REPO) { console.error('Falta GITHUB_TOKEN / GITHUB_REPOSITORY.'); process.exit(1); }

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const today = ymd(new Date(Date.now() - 3 * 3600e3)); // horário de Brasília
const days = []; for (let i = 1; i <= DAYS; i++) days.push(addDays(today, -i));
const num = v => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };

/* ---------- API da MGID ---------- */
let authMode = 'header';
async function mgid(path, params = {}) {
  const q = new URLSearchParams(params);
  for (const mode of authMode === 'header' ? ['header', 'query'] : ['query']) {
    const qs = new URLSearchParams(q); if (mode === 'query') qs.set('token', TOKEN);
    const headers = { Accept: 'application/json' }; if (mode === 'header') headers.Authorization = `Bearer ${TOKEN}`;
    const r = await fetch(`${API}${path}?${qs}`, { headers });
    if (r.status === 401 || r.status === 403) { if (mode === 'header') continue; throw new Error(`MGID recusou o token (HTTP ${r.status}). Confira o segredo MGID_TOKEN.`); }
    if (!r.ok) throw new Error(`MGID ${path}: HTTP ${r.status}`);
    authMode = mode;
    return r.json();
  }
}
const isStat = o => o && typeof o === 'object' && !Array.isArray(o) && ['spent', 'clicks', 'imps'].some(k => k in o);
// Encontra {campaignId: {spent, clicks, ...}} em qualquer nível da resposta.
function findStats(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  if (Array.isArray(obj)) {
    const rows = obj.filter(x => isStat(x) && (x.id ?? x.campaignId ?? x.campaign_id) != null);
    if (rows.length) return Object.fromEntries(rows.map(x => [String(x.id ?? x.campaignId ?? x.campaign_id), x]));
    return null;
  }
  const entries = Object.entries(obj);
  const statKids = entries.filter(([k, v]) => /^\d+$/.test(k) && isStat(v));
  if (statKids.length) return Object.fromEntries(statKids);
  // às vezes vem {campaignId: {"2026-10-13": {...}}}
  const dated = entries.filter(([k, v]) => /^\d+$/.test(k) && v && typeof v === 'object' && Object.values(v).some(isStat));
  if (dated.length) return Object.fromEntries(dated.map(([k, v]) => {
    const acc = {}; for (const s of Object.values(v)) if (isStat(s)) for (const [kk, vv] of Object.entries(s)) if (typeof vv !== 'object') acc[kk] = (acc[kk] || 0) + num(vv);
    return [k, acc];
  }));
  for (const [, v] of entries) { const f = findStats(v, depth + 1); if (f) return f; }
  return null;
}
function describe(obj, depth = 0) { // só nomes de campos, para diagnóstico
  if (!obj || typeof obj !== 'object' || depth > 3) return typeof obj;
  if (Array.isArray(obj)) return `[${obj.length}] ${describe(obj[0], depth + 1)}`;
  const ks = Object.keys(obj); return `{${ks.slice(0, 12).map(k => (/^\d+$/.test(k) ? '<id>' : k) + ':' + describe(obj[k], depth + 1)).join(', ')}${ks.length > 12 ? ', …' : ''}}`;
}
async function campaignNames() {
  try {
    const j = await mgid(`/goodhits/clients/${CLIENT}/campaigns`, { limit: 700, start: 0 });
    const out = {};
    (function walk(o, d) {
      if (!o || typeof o !== 'object' || d > 5) return;
      if (Array.isArray(o)) return o.forEach(x => walk(x, d + 1));
      const id = o.id ?? o.campaignId; if (id != null && typeof o.name === 'string') out[String(id)] = o.name;
      for (const [k, v] of Object.entries(o)) { if (/^\d+$/.test(k) && v && typeof v.name === 'string') out[k] = v.name; else if (typeof v === 'object') walk(v, d + 1); }
    })(j, 0);
    return out;
  } catch (e) { console.log('Não consegui listar os nomes das campanhas (' + e.message + '); uso os já conhecidos.'); return {}; }
}

/* ---------- país da campanha pelo nome (para campanhas novas) ---------- */
const CC = { AR: ['argentina'], CL: ['chile'], CO: ['colombia'], MX: ['mexico'], PE: ['peru'], EC: ['ecuador', 'equador'], UY: ['uruguay', 'uruguai'], PY: ['paraguay', 'paraguai'], BO: ['bolivia'], CR: ['costa rica'], PA: ['panama'], GT: ['guatemala'], DO: ['dominicana'], SV: ['el salvador'], HN: ['honduras'], VE: ['venezuela'], US: ['estados unidos', 'united states'], ES: ['espana', 'espanha', 'spain'], BR: ['brasil', 'brazil'] };
function countryOf(name) {
  const n = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const hits = new Set(Object.entries(CC).filter(([, a]) => a.some(w => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(n))).map(([c]) => c));
  for (const t of String(name || '').match(/\b[A-Z]{2}\b/g) || []) if (CC[t] && !['DO', 'ES', 'PE'].includes(t)) hits.add(t);
  return hits.size === 1 ? [...hits][0] : 'XX';
}

/* ---------- data.json via API do GitHub ---------- */
const ghHeaders = { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
async function getData() {
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/data.json?ref=main&t=${Date.now()}`, { headers: ghHeaders });
  if (!r.ok) throw new Error('GitHub GET data.json: HTTP ' + r.status);
  const j = await r.json();
  return { data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')), sha: j.sha };
}
async function putData(data, sha, message) {
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/data.json`, { method: 'PUT', headers: ghHeaders, body: JSON.stringify({ message, content: Buffer.from(JSON.stringify(data)).toString('base64'), branch: 'main', sha }) });
  return r.status;
}

/* ---------- principal ---------- */
console.log(`MGID: atualizando ${days.slice().reverse().join(', ')} …`);
const names = await campaignNames();
const perDay = {};
for (const d of days) {
  const j = await mgid(`/goodhits/clients/${CLIENT}/campaigns-stat`, { dateInterval: 'interval', startDate: d, endDate: d });
  const st = findStats(j);
  if (!st) { console.error(`Formato inesperado da MGID em ${d}. Estrutura recebida: ${describe(j)}`); process.exit(1); }
  perDay[d] = st;
}

for (let attempt = 1; attempt <= 5; attempt++) {
  const { data, sha } = await getData();
  const s = data.settings = data.settings || {}; s.cidMap = s.cidMap || {};
  let changed = 0;
  for (const d of days) {
    const st = perDay[d];
    const camps = Object.entries(st).map(([cid, v]) => {
      const interest = num(v.interest), decision = num(v.decision);
      return { cid, spend: Math.round(num(v.spent ?? v.spend) * 100) / 100, imp: Math.round(num(v.imps ?? v.impressions)), clicks: Math.round(num(v.clicks)), a: interest, b: decision };
    }).filter(c => c.spend || c.clicks || c.imp);
    // a etapa com mais conversões no dia é o Page View; a outra, o Initiate Checkout
    const ta = camps.reduce((x, c) => x + c.a, 0), tb = camps.reduce((x, c) => x + c.b, 0);
    camps.forEach(c => { c.pv = Math.round(ta >= tb ? c.a : c.b); c.ic = Math.round(ta >= tb ? c.b : c.a); });
    const e = data.entries[d] || (camps.length ? (data.entries[d] = { rows: [], ads: [], refunds: 0, other: 0, notes: '' }) : null);
    if (!e) continue;
    e.rows = e.rows || []; e.ads = e.ads || [];
    const before = JSON.stringify([e.rows.filter(r => r.p === P), e.ads.filter(a => a.p === P)]);
    // zera o tráfego da MGID do dia e soma de novo pelas campanhas
    e.rows.forEach(r => { if (r.p === P) { r.spend = 0; r.imp = 0; r.clicks = 0; r.pv = 0; r.ic = 0; } });
    for (const c of camps) {
      const known = e.ads.find(a => a.p === P && String(a.cid || '') === c.cid);
      const name = names[c.cid] || known?.name || `Campanha ${c.cid}`;
      const cc = s.cidMap[c.cid] || (known ? (known.cc || 'XX') : countryOf(name));
      s.cidMap[c.cid] = cc;
      let r = e.rows.find(x => x.p === P && x.cc === cc);
      if (!r) { r = { p: P, cc, spend: 0, imp: 0, clicks: 0, pv: 0, link: 0, ic: 0, sales: 0, rev: 0, ups: 0, upsRev: 0 }; e.rows.push(r); }
      r.spend = Math.round((r.spend + c.spend) * 100) / 100; r.imp += c.imp; r.clicks += c.clicks; r.pv += c.pv; r.ic += c.ic;
      const a = known || (e.ads.push({ name, p: P, cc: cc === 'XX' ? '' : cc, cid: c.cid, spend: 0, clicks: 0, sales: 0, rev: 0 }), e.ads[e.ads.length - 1]);
      Object.assign(a, { name, cid: c.cid, spend: c.spend, clicks: c.clicks, pv: c.pv, ic: c.ic });
    }
    const after = JSON.stringify([e.rows.filter(r => r.p === P), e.ads.filter(a => a.p === P)]);
    if (before === after && e.mg) continue;
    e.mg = { at: new Date().toISOString(), src: 'mgid' };
    changed++;
    const t = camps.reduce((x, c) => ({ s: x.s + c.spend, k: x.k + c.clicks, pv: x.pv + c.pv, ic: x.ic + c.ic }), { s: 0, k: 0, pv: 0, ic: 0 });
    console.log(`  ${d}: ${camps.length} campanhas · investimento ${t.s.toFixed(2)} · ${t.k} cliques · ${t.pv} page views · ${t.ic} initiate checkouts`);
  }
  if (!changed) { console.log('MGID: nada mudou desde a última atualização.'); process.exit(0); }
  const st = await putData(data, sha, `Tráfego da MGID · ${days.map(d => d.slice(8, 10) + '/' + d.slice(5, 7)).reverse().join(', ')}`);
  if (st === 200 || st === 201) { console.log(`MGID pronta: ${changed} dia(s) atualizado(s).`); process.exit(0); }
  if (st !== 409 && st !== 422) { console.error('GitHub recusou a gravação: HTTP ' + st); process.exit(1); }
  await new Promise(r => setTimeout(r, 1500 * attempt));
}
console.error('Não consegui gravar depois de 5 tentativas.'); process.exit(1);
