// Robô de vendas da KashPay (fase 1, "sombra"): lê as vendas recebidas por webhook no receptor da Cloudflare
// e grava os totais do dia em entry.kp, ao lado dos números da Ratoeira, para comparação.
// O painel ainda não usa estes números para vendas — só depois de conferirmos as primeiras vendas reais.
//
// Regras: horário real do pagamento (paid_at) em Brasília; "Neuro Honey Protocol"/"Protocolo Neuro Honey" = front,
// os demais produtos (Native) = upsell; reembolsos e chargebacks contam no dia em que aconteceram.

const KP_URL = (process.env.KASHPAY_URL || 'https://kashpay-vendas.rochaepaminondasp.workers.dev').replace(/\/$/, '');
const GH_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const DAYS = Math.max(0, Math.min(10, Number(process.env.DAYS ?? 1)));
const BRANCH = process.env.DATA_BRANCH || 'dados';
const GH_API = process.env.GITHUB_API || 'https://api.github.com';
if (!GH_TOKEN || !REPO) { console.error('Falta GITHUB_TOKEN / GITHUB_REPOSITORY.'); process.exit(1); }

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const brDay = iso => { const t = Date.parse(iso || ''); return isNaN(t) ? null : ymd(new Date(t - 3 * 3600e3)); };
const today = ymd(new Date(Date.now() - 3 * 3600e3));
const days = [today]; for (let i = 1; i <= DAYS; i++) days.push(addDays(today, -i));
const r2 = v => Math.round(v * 100) / 100;
export const isFront = names => names.some(n => /protoc/i.test(n) && /honey/i.test(n));

const res = await fetch(`${KP_URL}/vendas?from=${addDays(days[days.length - 1], -1)}&t=${Date.now()}`);
if (!res.ok) { console.log(`KashPay: receptor respondeu HTTP ${res.status} — pulando.`); process.exit(0); }
const all = ((await res.json()).vendas || []).filter(v => v && v.id && !String(v.id).startsWith('test_'));

const out = Object.fromEntries(days.map(d => [d, { front: 0, frontUsd: 0, ups: 0, upsUsd: 0, ref: 0, refUsd: 0, other: {}, camps: {} }]));
for (const v of all) {
  const usd = String(v.cur || 'USD').toUpperCase() === 'USD' ? (Number(v.amt) || 0) / 100 : 0;
  const names = (v.of || []).map(o => String(o.n || ''));
  const front = isFront(names);
  const pd = brDay(v.paid);
  if (pd && out[pd] && ['paid', 'refunded', 'chargeback'].includes(v.st)) {
    const o = out[pd];
    if (String(v.cur || 'USD').toUpperCase() !== 'USD') o.other[v.cur] = (o.other[v.cur] || 0) + (Number(v.amt) || 0) / 100;
    if (front) { o.front++; o.frontUsd += usd; } else { o.ups++; o.upsUsd += usd; }
    const cid = String(v.tr?.uc || '').trim() || '—';
    const c = o.camps[cid] || (o.camps[cid] = { src: v.tr?.us || '', front: 0, ups: 0, ccs: {} });
    if (front) c.front++; else c.ups++;
    if (v.cc) c.ccs[v.cc] = (c.ccs[v.cc] || 0) + 1;
  }
  const rd = brDay(v.st === 'chargeback' ? v.cb : v.ref);
  if (rd && out[rd] && (v.st === 'refunded' || v.st === 'chargeback')) { out[rd].ref++; out[rd].refUsd += usd; }
}
for (const o of Object.values(out)) for (const k of ['frontUsd', 'upsUsd', 'refUsd']) o[k] = r2(o[k]);

const ghHeaders = { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
for (let attempt = 1; attempt <= 5; attempt++) {
  const g = await fetch(`${GH_API}/repos/${REPO}/contents/data.json?ref=${BRANCH}&t=${Date.now()}`, { headers: ghHeaders });
  if (!g.ok) { console.error('GitHub GET data.json: HTTP ' + g.status); process.exit(1); }
  const gj = await g.json(); const data = JSON.parse(Buffer.from(gj.content, 'base64').toString('utf8'));
  let changed = 0;
  for (const d of days) {
    const e = data.entries[d]; if (!e) continue;
    const next = out[d];
    if (JSON.stringify(e.kp ? { ...e.kp, at: undefined } : null) === JSON.stringify({ ...next, at: undefined })) continue;
    e.kp = { ...next, at: new Date().toISOString() }; changed++;
    console.log(`  KashPay ${d}: ${next.front} front (US$ ${next.frontUsd}), ${next.ups} upsell (US$ ${next.upsUsd}), ${next.ref} reembolso(s)`);
  }
  if (!changed) { console.log(`KashPay: ${all.length} venda(s) no receptor; nada mudou.`); process.exit(0); }
  const p = await fetch(`${GH_API}/repos/${REPO}/contents/data.json`, { method: 'PUT', headers: ghHeaders, body: JSON.stringify({ message: 'Vendas da KashPay (comparação)', content: Buffer.from(JSON.stringify(data)).toString('base64'), branch: BRANCH, sha: gj.sha }) });
  if (p.status === 200 || p.status === 201) { console.log(`KashPay: ${changed} dia(s) gravado(s).`); process.exit(0); }
  if (p.status !== 409 && p.status !== 422) { console.error('GitHub recusou: HTTP ' + p.status); process.exit(1); }
  await new Promise(r => setTimeout(r, 1500 * attempt));
}
process.exit(1);
