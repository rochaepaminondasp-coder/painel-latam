// Robô de vendas: busca as vendas na Ratoeira Ads (via MCP) e grava no data.json do painel.
// Roda no GitHub Actions. Não imprime dados de clientes (os logs do repositório são públicos).
//
// Variáveis de ambiente:
//   RATOEIRA_MCP_URL  URL completa do MCP da Ratoeira, com ?token=...   (segredo do repositório)
//   GITHUB_TOKEN      token do próprio Actions (permissão contents: write)
//   GITHUB_REPOSITORY dono/repositorio (o Actions preenche sozinho)
//   DAYS              quantos dias para trás atualizar (padrão 3: ontem, anteontem e o dia anterior)
//   PLATFORM          código da plataforma no painel (padrão MG = MGID)
//   GITHUB_API / FX_API  só para testes

const MCP_URL = process.env.RATOEIRA_MCP_URL;
const GH_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const DAYS = Math.max(0, Math.min(10, Number(process.env.DAYS ?? 1))); // dias anteriores a hoje
const BRANCH = process.env.DATA_BRANCH || 'dados'; // galho onde fica o data.json do painel
const PLATFORM = process.env.PLATFORM || 'MG';
const GH_API = process.env.GITHUB_API || 'https://api.github.com';
const FX_API = process.env.FX_API || 'https://economia.awesomeapi.com.br/json/daily/USD-BRL/1';
const TZ_OFFSET_H = -3; // horário de Brasília

if (!MCP_URL) { console.error('Falta o segredo RATOEIRA_MCP_URL (Settings → Secrets and variables → Actions).'); process.exit(1); }
if (!GH_TOKEN || !REPO) { console.error('Falta GITHUB_TOKEN / GITHUB_REPOSITORY.'); process.exit(1); }

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const localNow = () => new Date(Date.now() + TZ_OFFSET_H * 3600e3);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
// "2026-10-13 19:39:22 -03:00" -> "2026-10-13" no horário de Brasília
function localDate(createdAt) {
  const m = String(createdAt || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s*([+-]\d{2}:?\d{2}|Z))?/);
  if (!m) return null;
  let off = m[3] || '-03:00'; if (off !== 'Z' && !off.includes(':')) off = off.slice(0, 3) + ':' + off.slice(3);
  const t = Date.parse(`${m[1]}T${m[2]}${off === 'Z' ? 'Z' : off}`);
  return isNaN(t) ? null : ymd(new Date(t + TZ_OFFSET_H * 3600e3));
}

/* ---------- cliente MCP (HTTP streamable) ---------- */
let sessionId = null, rpcId = 0;
async function mcp(method, params, notify = false) {
  const body = { jsonrpc: '2.0', method, params };
  if (!notify) body.id = ++rpcId;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const r = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = r.headers.get('mcp-session-id'); if (sid) sessionId = sid;
  if (notify) return null;
  const txt = await r.text();
  if (!r.ok) throw new Error(`MCP ${method}: HTTP ${r.status}`);
  let msg = null;
  if ((r.headers.get('content-type') || '').includes('text/event-stream') || /^(event|data):/m.test(txt)) {
    for (const line of txt.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try { const j = JSON.parse(line.slice(5).trim()); if (j.id === body.id) msg = j; } catch {}
    }
  } else msg = JSON.parse(txt);
  if (!msg) throw new Error(`MCP ${method}: resposta vazia`);
  if (msg.error) throw new Error(`MCP ${method}: ${msg.error.message || 'erro'}`);
  return msg.result;
}
function toolJson(result) {
  const text = (result?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (result?.isError) throw new Error('A Ratoeira recusou a consulta: ' + text.slice(0, 200));
  if (/conte[uú]do truncado|truncated/i.test(text)) throw new Error('resposta cortada');
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0) throw new Error('Resposta da Ratoeira sem JSON');
  return JSON.parse(text.slice(a, b + 1));
}
// O MCP da Ratoeira corta cada resposta em ~25 mil caracteres: pedimos páginas pequenas,
// só dos tipos que interessam, e diminuímos a página se ainda assim vier cortada.
const TIPOS = ['SALE', 'UPSELL', 'REFUND', 'CHARGEBACK'];
async function fetchSales(from, to) {
  await mcp('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'painel-latam', version: '1.0' } });
  await mcp('notifications/initialized', {}, true);
  const all = [], seen = new Set();
  let limit = 12, page = 1, total = null, calls = 0;
  while (calls++ < 400) {
    const res = await mcp('tools/call', { name: 'get_postback_vendas_by_cliente', arguments: {
      data_inicio: `${from} 00:00:00`, data_fim: `${to} 23:59:59`, timezone: 'America/Sao_Paulo', tipo: TIPOS, format: 'json', page, limit } });
    let j;
    try { j = toolJson(res); }
    catch (err) {
      if (limit > 2) { // resposta cortada: recomeça com páginas menores
        limit = Math.max(2, Math.floor(limit / 2)); page = 1; all.length = 0; seen.clear();
        console.log(`Resposta grande demais; tentando com ${limit} por página…`); continue;
      }
      throw err;
    }
    const lista = j?.data?.lista || j?.lista || [];
    if (total == null) total = Number(j?.data?.total ?? j?.total ?? NaN);
    for (const s of lista) { const k = String(s.id ?? JSON.stringify(s)); if (!seen.has(k)) { seen.add(k); all.push(s); } }
    if (lista.length < limit || (Number.isFinite(total) && all.length >= total)) break;
    page++;
  }
  return all;
}

/* ---------- cotação USD→BRL do dia ---------- */
// 1º PTAX do Banco Central (venda); em fim de semana/feriado usa o último dia útil anterior.
// Reserva: AwesomeAPI. Se nada responder, o painel usa a cotação fixa das Configurações (ou 5,40).
const BCB = 'https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarDia(dataCotacao=@dataCotacao)';
async function usdBrl(day) {
  for (let back = 0; back < 6; back++) {
    const d = addDays(day, -back), [y, m, dd] = d.split('-');
    try {
      const r = await fetch(`${BCB}?@dataCotacao='${m}-${dd}-${y}'&$format=json`, { headers: { Accept: 'application/json' } });
      if (r.ok) { const j = await r.json(); const v = Number(j?.value?.[0]?.cotacaoVenda); if (v > 0) return Math.round(v * 10000) / 10000; }
    } catch {}
  }
  try {
    const d = day.replace(/-/g, '');
    const r = await fetch(`${FX_API}?start_date=${d}&end_date=${d}`);
    if (r.ok) { const j = await r.json(); const v = Number(j?.[0]?.bid); if (v > 0) return Math.round(v * 10000) / 10000; }
  } catch {}
  return null;
}

/* ---------- data.json via API do GitHub ---------- */
const ghHeaders = { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
async function getData() {
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/data.json?ref=${BRANCH}&t=${Date.now()}`, { headers: ghHeaders });
  if (r.status === 404) return { data: { v: 3, settings: {}, entries: {}, demo: false }, sha: null };
  if (!r.ok) throw new Error('GitHub GET data.json: HTTP ' + r.status);
  const j = await r.json();
  return { data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')), sha: j.sha };
}
async function putData(data, sha, message) {
  const body = { message, content: Buffer.from(JSON.stringify(data)).toString('base64'), branch: BRANCH };
  if (sha) body.sha = sha;
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/data.json`, { method: 'PUT', headers: ghHeaders, body: JSON.stringify(body) });
  return r.status;
}

/* ---------- agregação ---------- */
const FRONT = new Set(['SALE', 'APPROVED', 'PURCHASE', 'COMPLETE', 'PAID']);
const UPS = new Set(['UPSELL', 'ORDER_BUMP', 'ORDERBUMP', 'BUMP', 'DOWNSELL', 'CROSS_SELL', 'CROSSSELL']);
const REF = new Set(['REFUND', 'REFUNDED', 'CHARGEBACK', 'CHARGEDBACK', 'REEMBOLSO']);
function aggregate(sales, days) {
  const out = {}; days.forEach(d => (out[d] = {}));
  let used = 0, ignored = 0, moved = 0;
  const tipoOf = s => String(s.tipo || '').toUpperCase().replace(/\s+/g, '_');
  // Upsell entra no dia da venda front do mesmo cliente (ex.: front 23:58, upsell 00:05 do dia seguinte).
  const stamp = s => Date.parse(String(s.created_at || '').replace(' ', 'T').replace(/\s+/, '')) || 0;
  const fronts = {};
  for (const s of sales) {
    const lead = s.lead_id || s.page_view_id; if (!lead || !FRONT.has(tipoOf(s))) continue;
    (fronts[lead] = fronts[lead] || []).push({ t: stamp(s), day: localDate(s.created_at) });
  }
  for (const s of sales) {
    const tipo = tipoOf(s);
    let day = localDate(s.created_at);
    if (UPS.has(tipo)) {
      const lead = s.lead_id || s.page_view_id, t = stamp(s);
      const parent = (fronts[lead] || []).filter(f => f.t <= t && t - f.t < 48 * 3600e3).sort((a, b) => b.t - a.t)[0];
      if (parent && parent.day && parent.day !== day && out[parent.day]) { day = parent.day; moved++; }
    }
    if (!day || !out[day]) continue;
    const cur = String(s.currency || 'USD').toUpperCase();
    const val = Number(s.valor ?? s.total ?? 0) || 0;
    const isFront = FRONT.has(tipo), isUps = UPS.has(tipo), isRef = REF.has(tipo), isOrder = tipo === 'ORDER_CREATED';
    if (!isFront && !isUps && !isRef && !isOrder) { ignored++; continue; }
    const cid = String(s.campaign_id || s.utm_campaign || '').trim();
    const c = out[day][cid] || (out[day][cid] = { front: 0, frontUsd: 0, ups: 0, upsUsd: 0, ref: 0, refUsd: 0, orders: 0, ccs: {} });
    const usd = cur === 'USD' ? val : val; // a Ratoeira envia em USD para esta conta; outras moedas ficam como vieram
    if (isFront) { c.front++; c.frontUsd += usd; }
    if (isUps) { c.ups++; c.upsUsd += usd; }
    if (isRef) { c.ref++; c.refUsd += usd; }
    if (isOrder) c.orders++;
    const cc = String(s.pais_sigla || s.pais || '').toUpperCase().slice(0, 2) || 'OT'; c.ccs[cc] = (c.ccs[cc] || 0) + 1;
    // vendas separadas pelo país do comprador (para campanhas com vários países)
    const b = (c.byCc = c.byCc || {})[cc] || (c.byCc[cc] = { front: 0, frontUsd: 0, ups: 0, upsUsd: 0, ref: 0, refUsd: 0 });
    if (isFront) { b.front++; b.frontUsd += usd; } if (isUps) { b.ups++; b.upsUsd += usd; } if (isRef) { b.ref++; b.refUsd += usd; }
    used++;
  }
  for (const d of days) for (const c of Object.values(out[d])) {
    c.cc = Object.entries(c.ccs).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    delete c.ccs;
    for (const k of ['frontUsd', 'upsUsd', 'refUsd']) c[k] = Math.round(c[k] * 100) / 100;
    for (const b of Object.values(c.byCc || {})) for (const k of ['frontUsd', 'upsUsd', 'refUsd']) b[k] = Math.round(b[k] * 100) / 100;
    for (const [k, b] of Object.entries(c.byCc || {})) if (!b.front && !b.ups && !b.ref) delete c.byCc[k];
  }
  if (moved) console.log(`${moved} upsell(s) lançado(s) no dia da venda front do mesmo cliente.`);
  return { out, used, ignored };
}

/* ---------- principal ---------- */
const today = ymd(localNow());
const days = [today]; for (let i = 1; i <= DAYS; i++) days.push(addDays(today, -i)); // hoje (parcial, ao vivo) + dias anteriores
const from = addDays(days[days.length - 1], -1), to = today; // janela folgada; o dia certo vem do horário de cada venda
console.log(`Atualizando vendas de ${days.slice().reverse().join(', ')} …`);

const sales = await fetchSales(from, to);
const { out, used, ignored } = aggregate(sales, days);
console.log(`Ratoeira: ${sales.length} registros na janela, ${used} usados, ${ignored} de outros tipos ignorados.`);
const fx = {}; for (const d of days) fx[d] = await usdBrl(d);

for (let attempt = 1; attempt <= 5; attempt++) {
  const { data, sha } = await getData();
  data.entries = data.entries || {};
  let changed = 0;
  for (const d of days) {
    const camps = out[d];
    const e = data.entries[d] || (Object.keys(camps).length ? { rows: [], ads: [], refunds: 0, other: 0, notes: '' } : null);
    if (!e) continue;
    const prev = JSON.stringify(e.rx ? { camps: e.rx.camps, fx: e.rx.fx } : null);
    const next = { p: PLATFORM, camps, fx: fx[d] ?? e.rx?.fx ?? null };
    if (prev === JSON.stringify({ camps: next.camps, fx: next.fx })) continue;
    e.rx = { ...next, at: new Date().toISOString(), src: 'ratoeira' };
    data.entries[d] = e; changed++;
    const t = Object.values(camps).reduce((a, c) => ({ f: a.f + c.front, u: a.u + c.ups }), { f: 0, u: 0 });
    console.log(`  ${d}: ${t.f} vendas front, ${t.u} upsells, ${Object.keys(camps).length} campanhas · USD→BRL ${next.fx ?? '—'}`);
  }
  if (!changed) { console.log('Nada mudou desde a última atualização.'); process.exit(0); }
  const st = await putData(data, sha, `Vendas da Ratoeira · ${days.map(d => d.slice(8, 10) + '/' + d.slice(5, 7)).reverse().join(', ')}`);
  if (st === 200 || st === 201) { console.log(`Pronto: ${changed} dia(s) atualizado(s) no painel.`); process.exit(0); }
  if (st !== 409 && st !== 422) { console.error('GitHub recusou a gravação: HTTP ' + st); process.exit(1); }
  console.log('O painel foi salvo ao mesmo tempo; tentando de novo…');
  await new Promise(r => setTimeout(r, 1500 * attempt));
}
console.error('Não consegui gravar depois de 5 tentativas.'); process.exit(1);
