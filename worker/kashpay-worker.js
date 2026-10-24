// Receptor de webhooks da KashPay (Cloudflare Worker).
//
// POST /kashpay   ← a KashPay envia os eventos aqui (assinatura HMAC-SHA256 conferida com o segredo KASHPAY_SECRET)
// GET  /vendas?from=AAAA-MM-DD  → lista as vendas guardadas (só dados da venda; nome, e-mail e telefone NÃO são guardados)
// GET  /           → status
//
// Configuração na Cloudflare:
//   - KV namespace ligado com o nome VENDAS
//   - segredo KASHPAY_SECRET = chave de assinatura gerada pela KashPay (Integrações → Webhooks)

const DDI = [ // código do telefone → país (mais longos primeiro)
  ['1809', 'DO'], ['1829', 'DO'], ['1849', 'DO'], ['1787', 'PR'],
  ['593', 'EC'], ['598', 'UY'], ['595', 'PY'], ['591', 'BO'], ['506', 'CR'], ['507', 'PA'], ['502', 'GT'],
  ['503', 'SV'], ['504', 'HN'], ['505', 'NI'], ['351', 'PT'],
  ['52', 'MX'], ['54', 'AR'], ['56', 'CL'], ['57', 'CO'], ['51', 'PE'], ['58', 'VE'], ['53', 'CU'],
  ['55', 'BR'], ['34', 'ES'], ['33', 'FR'], ['1', 'US'],
];
const ccFromPhone = p => { const d = String(p || '').replace(/\D/g, ''); const hit = DDI.find(([k]) => d.startsWith(k)); return hit ? hit[1] : ''; };

function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }
function same(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'POST' && url.pathname === '/kashpay') {
      if (!env.KASHPAY_SECRET) return new Response('KASHPAY_SECRET não configurado', { status: 503 });
      const raw = await req.text();
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.KASHPAY_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const expected = 'sha256=' + hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
      const got = (req.headers.get('x-kashpay-signature') || '').trim();
      if (!same(got, expected)) return new Response('assinatura inválida', { status: 401 });

      let ev; try { ev = JSON.parse(raw); } catch { return new Response('json inválido', { status: 400 }); }
      const d = ev.data || {};
      if (!d.id) return Response.json({ ok: true, ignored: 'sem id' });
      const t = d.tracking || {};
      const rec = { // só o necessário para o painel — sem dados pessoais
        id: d.id, ev: ev.event, st: d.status, amt: d.amount, net: d.net_amount, cur: d.currency,
        at: d.created_at, paid: d.paid_at, ref: d.refunded_at, cb: d.chargeback_at,
        of: (d.offers || []).map(o => ({ t: o.type, n: String(o.name || '').slice(0, 40), v: o.total ?? o.price, q: o.quantity })),
        cc: ccFromPhone(d.customer && d.customer.phone),
        tr: { src: t.src, sck: t.sck, ref: t.ref, uc: t.utm_campaign, us: t.utm_source, um: t.utm_medium, ut: t.utm_content, uterm: t.utm_term },
        up: new Date().toISOString(),
      };
      // um registro por pedido (o evento mais novo substitui o anterior: pago → reembolsado etc.)
      const prev = await env.VENDAS.get('o:' + d.id, 'json');
      if (prev) { rec.paid = rec.paid || prev.paid; rec.of = rec.of.length ? rec.of : prev.of; rec.tr = Object.values(rec.tr).some(Boolean) ? rec.tr : prev.tr; rec.cc = rec.cc || prev.cc; }
      const day = String(rec.paid || rec.at || '').slice(0, 10), small = JSON.stringify(rec).length < 900;
      await env.VENDAS.put('o:' + d.id, JSON.stringify(rec), { metadata: small ? { d: day, r: rec } : { d: day } });
      return Response.json({ ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/vendas') {
      const from = url.searchParams.get('from') || '';
      const out = []; let cursor;
      do {
        const page = await env.VENDAS.list({ prefix: 'o:', cursor });
        const keys = page.keys.filter(k => !from || !k.metadata || String(k.metadata.d || '') >= from);
        // a venda vem nos metadados da listagem; só lê o registro quando ele é grande demais para caber ali
        const vals = await Promise.all(keys.map(k => k.metadata && k.metadata.r ? k.metadata.r : env.VENDAS.get(k.name, 'json')));
        out.push(...vals.filter(Boolean));
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
      return Response.json({ ok: true, n: out.length, vendas: out }, { headers: cors });
    }

    if (url.pathname === '/') return Response.json({ ok: true, servico: 'painel-latam · webhooks KashPay', configurado: !!env.KASHPAY_SECRET, armazenamento: !!env.VENDAS }, { headers: cors });
    return new Response('não encontrado', { status: 404 });
  },
};
