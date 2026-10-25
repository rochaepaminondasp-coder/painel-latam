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
const KP_URL = (process.env.KASHPAY_URL || 'https://kashpay-vendas.rochaepaminondasp.workers.dev').replace(/\/$/, '');
const KP_START = process.env.KP_START || '2026-10-25'; // a partir deste dia vendas/upsells/reembolsos vêm SÓ da KashPay (horário real do pagamento)
const brDay = iso => { const t = Date.parse(iso || ''); return isNaN(t) ? null : ymd(new Date(t + TZ_OFFSET_H * 3600e3)); };
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
  let r;
  for (let t = 1; ; t++) { // a Ratoeira limita o ritmo: se pedir pausa, espera e tenta de novo
    r = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    if (r.status !== 429 || t >= 4) break;
    console.log(`Ratoeira pediu pausa (muitas consultas); esperando ${20 * t}s…`);
    await new Promise(ok => setTimeout(ok, 20000 * t));
  }
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
const TIPOS = ['SALE', 'UPSELL', 'REFUND', 'CHARGEBACK', 'ORDER_CREATED'];
let mcpReady = false;
async function fetchList(tool, from, to, extra = {}, limit = 12) {
  if (!mcpReady) {
    await mcp('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'painel-latam', version: '1.0' } });
    await mcp('notifications/initialized', {}, true); mcpReady = true;
  }
  const all = [], seen = new Set();
  let page = 1, total = null, calls = 0;
  while (calls++ < 400) {
    const res = await mcp('tools/call', { name: tool, arguments: {
      data_inicio: `${from} 00:00:00`, data_fim: `${to} 23:59:59`, timezone: 'America/Sao_Paulo', ...extra, format: 'json', page, limit } });
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
const fetchSales = (from, to) => fetchList('get_postback_vendas_by_cliente', from, to, { tipo: TIPOS }, 12);
// checkouts iniciados (Initiate Checkout), já com plataforma, campanha e país
const fetchCheckouts = (from, to) => fetchList('get_checkout_vendas_by_cliente', from, to, {}, 8);

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
// plataforma da venda pela origem do clique na Ratoeira (pixel / tipo de rastreio)
function platformOf(s) {
  const tipo = String(s.tipo_ads || '').toLowerCase();
  const t = [tipo, s.pixel, s.utm_source, s.network].map(v => String(v || '').toLowerCase()).join(' ');
  if (t.includes('taboola') || tipo.startsWith('tbl')) return 'TB';
  if (t.includes('mgid')) return 'MG';
  if (t.includes('outbrain') || tipo.startsWith('ob_')) return 'OB';
  const rede = { 4: 'TB', 6: 'MG' }[String(s.rede_ads_id || '')]; // rede de anúncios na Ratoeira
  return rede || PLATFORM;
}
const FRONT = new Set(['SALE', 'APPROVED', 'PURCHASE', 'COMPLETE', 'PAID']);
const UPS = new Set(['UPSELL', 'ORDER_BUMP', 'ORDERBUMP', 'BUMP', 'DOWNSELL', 'CROSS_SELL', 'CROSSSELL']);
const REF = new Set(['REFUND', 'REFUNDED', 'CHARGEBACK', 'CHARGEDBACK', 'REEMBOLSO']);
function aggregate(sales, days, checkouts = []) {
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
    if (UPS.has(tipo) && process.env.UPSELL_NO_DIA_DO_FRONT === '1') { // desligado: tudo conta no dia em que chegou na Ratoeira
      const lead = s.lead_id || s.page_view_id, t = stamp(s);
      const parent = (fronts[lead] || []).filter(f => f.t <= t && t - f.t < 48 * 3600e3).sort((a, b) => b.t - a.t)[0];
      if (parent && parent.day && parent.day !== day) {
        if (!out[parent.day]) continue; // pertence a um dia que esta rodada não regrava: fica lá, não vem para cá
        day = parent.day; moved++;
      }
    }
    if (!day || !out[day]) continue;
    const cur = String(s.currency || 'USD').toUpperCase();
    const val = Number(s.valor ?? s.total ?? 0) || 0;
    const isFront = FRONT.has(tipo), isUps = UPS.has(tipo), isRef = REF.has(tipo), isOrder = tipo === 'ORDER_CREATED';
    if (!isFront && !isUps && !isRef && !isOrder) { ignored++; continue; }
    const cid = String(s.campaign_id || s.utm_campaign || '').trim();
    const plat = platformOf(s);
    const c = out[day][cid] || (out[day][cid] = { p: plat, ic: 0, front: 0, frontUsd: 0, ups: 0, upsUsd: 0, ref: 0, refUsd: 0, orders: 0, ccs: {} });
    const usd = cur === 'USD' ? val : val; // a Ratoeira envia em USD para esta conta; outras moedas ficam como vieram
    if (isFront) { c.front++; c.frontUsd += usd; }
    if (isUps) { c.ups++; c.upsUsd += usd; }
    if (isRef) { c.ref++; c.refUsd += usd; }
    if (isOrder) c.orders++;
    const cc = String(s.pais_sigla || s.pais || '').toUpperCase().slice(0, 2) || 'OT'; c.ccs[cc] = (c.ccs[cc] || 0) + 1;
    // vendas separadas pelo país do comprador (para campanhas com vários países)
    const b = (c.byCc = c.byCc || {})[cc] || (c.byCc[cc] = { ic: 0, front: 0, frontUsd: 0, ups: 0, upsUsd: 0, ref: 0, refUsd: 0 });
    if (isFront) { b.front++; b.frontUsd += usd; } if (isUps) { b.ups++; b.upsUsd += usd; } if (isRef) { b.ref++; b.refUsd += usd; }
    used++;
  }
  for (const s of checkouts) {
    const day = localDate(s.created_at); if (!day || !out[day]) continue;
    const cid = String(s.campaign_id || s.utm_campaign || '').trim();
    const c = out[day][cid] || (out[day][cid] = { p: platformOf(s), ic: 0, front: 0, frontUsd: 0, ups: 0, upsUsd: 0, ref: 0, refUsd: 0, orders: 0, ccs: {} });
    const cc = String(s.pais_sigla || s.pais || '').toUpperCase().slice(0, 2) || 'OT';
    c.ic++; c.ccs = c.ccs || {};
    const b = (c.byCc = c.byCc || {})[cc] || (c.byCc[cc] = { ic: 0, front: 0, frontUsd: 0, ups: 0, upsUsd: 0, ref: 0, refUsd: 0 });
    b.ic++;
  }
  for (const d of days) for (const c of Object.values(out[d])) {
    c.cc = Object.entries(c.ccs).sort((a, b) => b[1] - a[1])[0]?.[0] || Object.keys(c.byCc || {})[0] || '';
    delete c.ccs;
    for (const k of ['frontUsd', 'upsUsd', 'refUsd']) c[k] = Math.round(c[k] * 100) / 100;
    for (const b of Object.values(c.byCc || {})) for (const k of ['frontUsd', 'upsUsd', 'refUsd']) b[k] = Math.round(b[k] * 100) / 100;
    for (const [k, b] of Object.entries(c.byCc || {})) if (!b.front && !b.ups && !b.ref && !b.ic) delete c.byCc[k];
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
// checkouts são muitos registros (muitas páginas): só a cada algumas rodadas (CHECKOUTS=0 pula e mantém os últimos)
let checkouts = [], icOk = process.env.CHECKOUTS !== '0';
if (icOk) try { checkouts = await fetchCheckouts(from, to); } catch (e) { icOk = false; console.log('Checkouts da Ratoeira indisponíveis agora (' + e.message.slice(0, 120) + ').'); }
// vendas da KashPay (webhooks): buscadas antes, para não contar duas vezes a mesma pessoa
let kpList = null;
const pvOfKp = v => String(v.tr?.sck || v.tr?.ref || v.tr?.um || '').replace(/^vSt/, '');
if (days.some(d => d >= KP_START)) {
  try {
    const r = await fetch(`${KP_URL}/vendas?from=${addDays(days[days.length - 1], -2)}&t=${Date.now()}`);
    if (r.ok) kpList = ((await r.json()).vendas || []).filter(v => v && v.id && !String(v.id).startsWith('test_'));
  } catch {}
}
// a Ratoeira continua valendo para quem NÃO veio pela KashPay (vendas antes do webhook, ou aviso que falhou)
const kpPv = new Set((kpList || []).map(pvOfKp).filter(Boolean));
const salesAgg = kpList ? sales.filter(s => {
  const t = String(s.tipo || '').toUpperCase().replace(/\s+/g, '_');
  if (!FRONT.has(t) && !UPS.has(t) && !REF.has(t)) return true;
  return (localDate(s.created_at) || '') < KP_START; // nos dias da KashPay, nenhum postback da Ratoeira conta como venda
}) : sales;
if (kpList) console.log(`KashPay: ${kpList.length} venda(s) no receptor · ${sales.length - salesAgg.length} postback(s) da Ratoeira ignorado(s) nos dias da KashPay.`);
const { out, used, ignored } = aggregate(salesAgg, days, checkouts);

/* ---------- conferência com o Dashboard Financeiro da Ratoeira ----------
   A lista de postbacks às vezes demora a registrar uma venda que o financeiro já mostra.
   Se o financeiro tiver mais vendas/upsells no dia, a diferença entra como provisória (est: 1)
   na campanha do pedido criado que ainda não virou venda (mesmo cliente); o registro real substitui depois. */
async function finDay(day) {
  const res = await mcp('tools/call', { name: 'get_financial_dashboard', arguments: { periodoAtual: { dataInicio: day, dataFim: day }, usarCache: false, format: 'json' } });
  const j = toolJson(res), r = j?.metrics?.resultadoPeriodoSelecionado;
  if (!r) return null;
  return { front: num(r.vendas_sem_upsell_quantidade), frontUsd: num(r.vendas_sem_upsell_valor_dolar), ups: num(r.vendas_upsell_quantidade), upsUsd: num(r.vendas_upsell_total_valor_dolar) };
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
let reconciled = 0;
for (const d of days) {
  if (d >= KP_START) continue; // dias da KashPay não precisam da conferência
  let fin = null;
  try { fin = await finDay(d); } catch (e) { console.log(`Financeiro da Ratoeira indisponível para ${d} (${e.message.slice(0, 80)}).`); continue; }
  if (!fin) continue;
  // compara pela data original de cada registro (o financeiro conta assim), não pelo dia em que o upsell foi lançado
  const camps = out[d], tot = { f: 0, u: 0, fu: 0, uu: 0 };
  for (const s of sales) {
    if (localDate(s.created_at) !== d) continue;
    const t = String(s.tipo || '').toUpperCase().replace(/\s+/g, '_'), v = num(s.valor ?? s.total);
    if (FRONT.has(t)) { tot.f++; tot.fu += v; } else if (UPS.has(t)) { tot.u++; tot.uu += v; }
  }
  let mf = fin.front - tot.f, mu = fin.ups - tot.u;
  if (mf <= 0 && mu <= 0) continue;
  const fUsd = mf > 0 ? Math.max(0, fin.frontUsd - tot.fu) / mf : 0, uUsd = mu > 0 ? Math.max(0, fin.upsUsd - tot.uu) / mu : 0;
  // pedidos criados no dia sem venda do mesmo cliente, do mais recente para o mais antigo
  const paid = new Set(sales.filter(s => FRONT.has(String(s.tipo || '').toUpperCase())).map(s => s.lead_id || s.page_view_id));
  const open = sales.filter(s => String(s.tipo || '').toUpperCase() === 'ORDER_CREATED' && localDate(s.created_at) === d && !paid.has(s.lead_id || s.page_view_id))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const used = new Set(), hit = [];
  const slot = (cid, p, cc) => {
    const c = camps[cid] || (camps[cid] = { p, ic: 0, front: 0, frontUsd: 0, ups: 0, upsUsd: 0, ref: 0, refUsd: 0, orders: 0, cc, byCc: {} });
    c.est = 1; c.byCc = c.byCc || {};
    return [c, c.byCc[cc] || (c.byCc[cc] = { ic: 0, front: 0, frontUsd: 0, ups: 0, upsUsd: 0, ref: 0, refUsd: 0 })];
  };
  for (; mf > 0; mf--) {
    const o = open.find(x => !used.has(x.lead_id || x.page_view_id));
    const cid = o ? String(o.campaign_id || o.utm_campaign || '') : '', cc = o ? String(o.pais_sigla || 'OT').toUpperCase().slice(0, 2) : 'OT';
    if (o) { used.add(o.lead_id || o.page_view_id); hit.push([cid, platformOf(o), cc]); }
    const [c, b] = slot(cid, o ? platformOf(o) : PLATFORM, cc);
    c.front++; c.frontUsd = Math.round((c.frontUsd + fUsd) * 100) / 100; b.front++; b.frontUsd = Math.round((b.frontUsd + fUsd) * 100) / 100; reconciled++;
  }
  for (let i = 0; mu > 0; mu--, i++) { // upsell provisório vai junto da venda provisória (mesmo cliente), se houver
    const [cid, p, cc] = hit[i] || ['', PLATFORM, 'OT'];
    const [c, b] = slot(cid, p, cc);
    c.ups++; c.upsUsd = Math.round((c.upsUsd + uUsd) * 100) / 100; b.ups++; b.upsUsd = Math.round((b.upsUsd + uUsd) * 100) / 100; reconciled++;
  }
}
if (reconciled) console.log(`Financeiro da Ratoeira: ${reconciled} venda(s)/upsell(s) ainda sem postback lançada(s) como provisória(s).`);

/* ---------- vendas da KashPay (webhooks) ----------
   A partir de KP_START, front/upsell/reembolso de quem passou pela KashPay vêm dela (horário real do pagamento);
   os postbacks da Ratoeira só contam para quem não veio pela KashPay.
   Campanha = utm_campaign; plataforma e país = registro da Ratoeira com o mesmo código de visita (vSt…). */
const kpDays = days.filter(d => d >= KP_START);
const visUsed = {}; // dia → visitas com país conhecido (guardado em rx.vis)
let kpSrc = false;
if (kpDays.length) {
  const kp = kpList;
  if (!kp) console.log('KashPay indisponível agora — mantendo as vendas da Ratoeira nesta rodada.');
  else {
    kpSrc = true;
    const pvOf = pvOfKp;
    // código de visita → plataforma e país. Vem da Ratoeira (pedido criado, venda ou checkout) e fica guardado
    // no próprio dia (rx.vis), para a venda não perder o país nas rodadas em que a Ratoeira não traz aquele registro.
    const visit = {};
    try { const { data: prevData } = await getData(); for (const d of kpDays) Object.assign(visit, prevData.entries?.[d]?.rx?.vis || {}); } catch {}
    for (const s of [...sales, ...checkouts]) { const pv = s.page_view_id, cc = String(s.pais_sigla || s.pais || '').toUpperCase().slice(0, 2); if (pv && cc) visit[pv] = { p: platformOf(s), cc }; }
    const isFrontKp = v => (v.of || []).some(o => /protoc/i.test(o.n || '') && /honey/i.test(o.n || ''));
    const usdOf = (v, d) => { const a = (Number(v.amt) || 0) / 100; return String(v.cur || 'USD').toUpperCase() === 'USD' ? a : a / (fxKp[d] || 5.4); };
    const fxKp = {}; for (const d of kpDays) fxKp[d] = await usdBrl(d);
    const frontDay = {}; // upsell conta no dia da venda front do mesmo cliente
    for (const v of kp) if (isFrontKp(v) && v.paid) frontDay[pvOf(v)] = brDay(v.paid);
    const slot = (d, v) => {
      const cid = String(v.tr?.uc || '').trim(), info = visit[pvOf(v)] || {};
      if (visit[pvOf(v)]) (visUsed[d] = visUsed[d] || {})[pvOf(v)] = visit[pvOf(v)]; else pend++;
      const camps = out[d];
      const c = camps[cid] || (camps[cid] = { p: info.p || PLATFORM, ic: 0, front: 0, frontUsd: 0, ups: 0, upsUsd: 0, ref: 0, refUsd: 0, orders: 0, cc: '', byCc: {} });
      if (info.p) c.p = info.p;
      const cc = (v.cc || info.cc || c.cc || 'OT').toUpperCase(); if (!c.cc) c.cc = cc;
      const b = (c.byCc = c.byCc || {})[cc] || (c.byCc[cc] = { ic: 0, front: 0, frontUsd: 0, ups: 0, upsUsd: 0, ref: 0, refUsd: 0 });
      return [c, b];
    };
    let n = 0, pend = 0;
    for (const v of kp) {
      if (!['paid', 'refunded', 'chargeback'].includes(v.st) || !v.paid) continue;
      const front = isFrontKp(v);
      let d = brDay(v.paid);
      if (!front) { const fd = frontDay[pvOf(v)]; if (fd && fd !== d && out[fd] && fd >= KP_START) d = fd; }
      if (out[d] && d >= KP_START) {
        const [c, b] = slot(d, v), usd = usdOf(v, d);
        if (front) { c.front++; c.frontUsd += usd; b.front++; b.frontUsd += usd; } else { c.ups++; c.upsUsd += usd; b.ups++; b.upsUsd += usd; }
        n++;
      }
      const rd = brDay(v.st === 'chargeback' ? v.cb : v.ref);
      if ((v.st === 'refunded' || v.st === 'chargeback') && rd && out[rd] && rd >= KP_START) {
        const [c, b] = slot(rd, v), usd = usdOf(v, rd); c.ref++; c.refUsd += usd; b.ref++; b.refUsd += usd;
      }
    }
    for (const d of kpDays) for (const c of Object.values(out[d])) {
      for (const k of ['frontUsd', 'upsUsd', 'refUsd']) c[k] = Math.round(c[k] * 100) / 100;
      for (const [k, b] of Object.entries(c.byCc || {})) { for (const f of ['frontUsd', 'upsUsd', 'refUsd']) b[f] = Math.round(b[f] * 100) / 100; if (!b.front && !b.ups && !b.ref && !b.ic) delete c.byCc[k]; }
    }
    console.log(`KashPay: ${n} venda(s)/upsell(s) lançada(s) em ${kpDays.join(', ')}${pend ? ` · ${pend} ainda sem país (aguardando a Ratoeira)` : ''}.`);
  }
}

/* ---------- dias da KashPay: completa com o financeiro da Ratoeira ----------
   Só lança provisório quando faltam quantidade E valor (diferença real, não de classificação),
   na campanha de um pedido criado sem venda; quando o registro de verdade chegar, ele toma o lugar. */
for (const d of (process.env.KP_FIN === '1' ? kpDays : [])) { // desligado: o financeiro da Ratoeira usa o horário de chegada, não o da compra
  let fin = null;
  try { fin = await finDay(d); } catch (e) { console.log(`Financeiro da Ratoeira indisponível para ${d} (${e.message.slice(0, 80)}).`); continue; }
  if (!fin) continue;
  const camps = out[d], tot = { f: 0, u: 0, fu: 0, uu: 0 };
  for (const c of Object.values(camps)) { tot.f += c.front; tot.u += c.ups; tot.fu += c.frontUsd; tot.uu += c.upsUsd; }
  const mf = fin.front - tot.f, mu = fin.ups - tot.u, gf = fin.frontUsd - tot.fu, gu = fin.upsUsd - tot.uu;
  const addF = mf > 0 && gf > 1 ? mf : 0, addU = mu > 0 && gu > 1 ? mu : 0;
  if (!addF && !addU) continue;
  const paidPv = new Set([...kpPv, ...sales.filter(x => FRONT.has(String(x.tipo || '').toUpperCase())).map(x => x.page_view_id)]);
  const open = sales.filter(x => String(x.tipo || '').toUpperCase() === 'ORDER_CREATED' && localDate(x.created_at) === d && !paidPv.has(x.page_view_id))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const slotP = (cid, p, cc) => {
    const c = camps[cid] || (camps[cid] = { p, ic: 0, front: 0, frontUsd: 0, ups: 0, upsUsd: 0, ref: 0, refUsd: 0, orders: 0, cc, byCc: {} });
    c.est = 1; c.byCc = c.byCc || {};
    return [c, c.byCc[cc] || (c.byCc[cc] = { ic: 0, front: 0, frontUsd: 0, ups: 0, upsUsd: 0, ref: 0, refUsd: 0 })];
  };
  const hit = [];
  for (let i = 0; i < addF; i++) {
    const o = open[i]; const cid = o ? String(o.campaign_id || '') : '', cc = o ? String(o.pais_sigla || 'OT').toUpperCase().slice(0, 2) : 'OT', p = o ? platformOf(o) : PLATFORM;
    hit.push([cid, p, cc]);
    const [c, b] = slotP(cid, p, cc), v = Math.round(gf / addF * 100) / 100;
    c.front++; c.frontUsd = Math.round((c.frontUsd + v) * 100) / 100; b.front++; b.frontUsd = Math.round((b.frontUsd + v) * 100) / 100;
  }
  for (let i = 0; i < addU; i++) {
    const [cid, p, cc] = hit[i] || ['', PLATFORM, 'OT'];
    const [c, b] = slotP(cid, p, cc), v = Math.round(gu / addU * 100) / 100;
    c.ups++; c.upsUsd = Math.round((c.upsUsd + v) * 100) / 100; b.ups++; b.upsUsd = Math.round((b.upsUsd + v) * 100) / 100;
  }
  console.log(`Financeiro da Ratoeira (${d}): ${addF} venda(s) e ${addU} upsell(s) ainda sem registro lançados como provisórios.`);
}
console.log(`Ratoeira: ${checkouts.length} checkouts na janela.`);
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
    if (kpSrc && d >= KP_START) // plataforma pela própria campanha (IDs vindos das APIs da MGID e da Taboola)
      for (const [cid, c] of Object.entries(camps)) { const ad = (e.ads || []).find(a => String(a.cid || '') === cid); if (ad) c.p = ad.p; }
    if (d >= KP_START && !kpList) continue; // KashPay fora do ar nesta rodada: mantém o que já estava
    const prev = JSON.stringify(e.rx ? { camps: e.rx.camps, fx: e.rx.fx } : null);
    if (!icOk && e.rx?.ic) // sem os checkouts agora: mantém os que já estavam
      for (const [cid, o] of Object.entries(e.rx.camps || {})) {
        if (!o.ic) continue;
        const c = camps[cid] || (camps[cid] = { p: o.p, ic: 0, front: 0, frontUsd: 0, ups: 0, upsUsd: 0, ref: 0, refUsd: 0, orders: 0, cc: o.cc, byCc: {} });
        c.ic = o.ic; c.byCc = c.byCc || {};
        for (const [k, b] of Object.entries(o.byCc || {})) if (b.ic) (c.byCc[k] = c.byCc[k] || { ic: 0, front: 0, frontUsd: 0, ups: 0, upsUsd: 0, ref: 0, refUsd: 0 }).ic = b.ic;
      }
    const next = { p: PLATFORM, ps: ['MG', 'TB'], ic: icOk || !!e.rx?.ic, camps, fx: fx[d] ?? e.rx?.fx ?? null };
    const visNew = kpSrc && d >= KP_START && Object.keys(visUsed[d] || {}).some(k => !(e.rx?.vis || {})[k]);
    if (prev === JSON.stringify({ camps: next.camps, fx: next.fx }) && !visNew) continue;
    e.rx = { ...next, at: new Date().toISOString(), src: kpSrc && d >= KP_START ? 'kashpay' : 'ratoeira' };
    if (kpSrc && d >= KP_START) e.rx.vis = { ...(e.rx.vis || {}), ...(visUsed[d] || {}) }; // países já descobertos
    data.entries[d] = e; changed++;
    const t = Object.values(camps).reduce((a, c) => ({ f: a.f + c.front, u: a.u + c.ups }), { f: 0, u: 0 });
    const bp = {}; for (const c of Object.values(camps)) bp[c.p] = (bp[c.p] || 0) + c.front;
    console.log(`  ${d}: ${t.f} vendas front (${Object.entries(bp).map(([k, v]) => k + ' ' + v).join(', ') || '—'}), ${t.u} upsells, ${Object.keys(camps).length} campanhas · USD→BRL ${next.fx ?? '—'}`);
  }
  if (!changed) { console.log('Nada mudou desde a última atualização.'); process.exit(0); }
  const st = await putData(data, sha, `Vendas da Ratoeira · ${days.map(d => d.slice(8, 10) + '/' + d.slice(5, 7)).reverse().join(', ')}`);
  if (st === 200 || st === 201) { console.log(`Pronto: ${changed} dia(s) atualizado(s) no painel.`); process.exit(0); }
  if (st !== 409 && st !== 422) { console.error('GitHub recusou a gravação: HTTP ' + st); process.exit(1); }
  console.log('O painel foi salvo ao mesmo tempo; tentando de novo…');
  await new Promise(r => setTimeout(r, 1500 * attempt));
}
console.error('Não consegui gravar depois de 5 tentativas.'); process.exit(1);
