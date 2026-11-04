// Diagnóstico do funil: pega as URLs dos anúncios ativos da Taboola, abre cada página (como celular),
// segue até 2 níveis procurando links de checkout e grava o resultado em funil.json (branch dados).
const BASE = 'https://backstage.taboola.com/backstage';
const E = k => String(process.env[k] || '').trim();
const CID = E('TABOOLA_CLIENT_ID'), SECRET = E('TABOOLA_CLIENT_SECRET'), ACC = E('TABOOLA_ACCOUNT_ID'), GH = E('GITHUB_TOKEN'), REPO = E('GITHUB_REPOSITORY');
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const tr = await fetch(`${BASE}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ client_id: CID, client_secret: SECRET, grant_type: 'client_credentials' }) });
const ttx = await tr.text(); let tok; try { tok = JSON.parse(ttx).access_token; } catch {}
if (!tok) console.error('token Taboola:', tr.status, ttx.slice(0, 200), 'cid?', !!CID, 'secret?', !!SECRET);
const api = async p => (await fetch(`${BASE}/api/1.0/${p}`, { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' } })).json();
if (!tok) { console.error('sem token da Taboola'); process.exit(1); }
const camps = ((await api(`${ACC}/campaigns/`)).results || []).filter(c => c.is_active && c.status === 'RUNNING');
const ads = [];
for (const c of camps) {
  const items = ((await api(`${ACC}/campaigns/${c.id}/items/`)).results || []).filter(i => i.is_active && i.status === 'RUNNING');
  for (const i of items) ads.push({ camp: c.id, name: c.name, url: i.url });
}
const out = { at: new Date().toISOString(), campanhas: camps.length, anuncios: ads.length, paginas: {}, checkouts: {} };
const seen = new Set();
async function open(url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-AR,es;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    const html = await r.text();
    return { status: r.status, final: r.url, ms: Date.now() - t0, html };
  } catch (e) { return { status: 0, erro: String(e.message || e), ms: Date.now() - t0, html: '' }; }
}
const linksOf = (html, base) => {
  const s = new Set();
  for (const m of html.matchAll(/(?:href|src|action|data-url|url)\s*[=:]\s*["']([^"']+)["']/gi)) { try { s.add(new URL(m[1].replace(/&amp;/g, '&'), base).href); } catch {} }
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>\\)]+/g)) s.add(m[0].replace(/&amp;/g, '&'));
  return [...s];
};
const isCk = u => /kashpay|checkout|pay\.|\/pay\//i.test(u) && !/\.(js|css|png|jpe?g|svg|webp|woff2?)(\?|$)/i.test(u);
async function crawl(url, depth, from) {
  const key = url.split('#')[0]; if (seen.has(key) || depth > 2) return; seen.add(key);
  const r = await open(url);
  const links = linksOf(r.html, r.final || url);
  const ck = links.filter(isCk);
  out.paginas[key] = { de: from, status: r.status, final: r.final, ms: r.ms, erro: r.erro, titulo: (r.html.match(/<title[^>]*>([^<]*)/i) || [])[1]?.trim(), checkoutLinks: ck.slice(0, 15), vturb: /vturb|converteai|smartplayer/i.test(r.html) };
  for (const u of ck) if (!out.checkouts[u.split('#')[0]]) {
    const c = await open(u);
    out.checkouts[u.split('#')[0]] = { status: c.status, final: c.final, ms: c.ms, erro: c.erro, titulo: (c.html.match(/<title[^>]*>([^<]*)/i) || [])[1]?.trim(), tamanho: c.html.length, trecho: c.html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300) };
  }
  if (depth < 2) for (const u of links.filter(u => !isCk(u) && /^https?:/.test(u) && new URL(u).hostname === new URL(r.final || url).hostname && !/\.(js|css|png|jpe?g|svg|webp|gif|ico|woff2?|mp4|m3u8|json)(\?|$)/i.test(u)).slice(0, 8)) await crawl(u, depth + 1, key);
}
const uniq = [...new Set(ads.map(a => a.url))];
out.urlsAnuncios = uniq.map(u => ({ url: u, campanhas: [...new Set(ads.filter(a => a.url === u).map(a => a.name))] }));
for (const u of uniq.slice(0, 10)) await crawl(u, 0, 'anúncio');
const h = { Authorization: `Bearer ${GH}`, Accept: 'application/vnd.github+json' };
const g = await fetch(`https://api.github.com/repos/${REPO}/contents/funil.json?ref=dados`, { headers: h });
const sha = g.ok ? (await g.json()).sha : undefined;
const p = await fetch(`https://api.github.com/repos/${REPO}/contents/funil.json`, { method: 'PUT', headers: h, body: JSON.stringify({ message: 'Diagnóstico do funil', branch: 'dados', sha, content: Buffer.from(JSON.stringify(out, null, 1)).toString('base64') }) });
console.log('gravado', p.status, Object.keys(out.paginas).length, 'páginas', Object.keys(out.checkouts).length, 'checkouts');
