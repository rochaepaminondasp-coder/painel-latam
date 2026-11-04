// Abre o checkout como um celular (fora do Brasil: servidor do GitHub nos EUA), mede o tempo e tira print.
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
const URL_CK = process.env.CK_URL;
const b = await chromium.launch();
const out = { at: new Date().toISOString(), runs: [] };
for (const [nome, locale, tz] of [['es-MX', 'es-MX', 'America/Mexico_City'], ['es-AR', 'es-AR', 'America/Argentina/Buenos_Aires']]) {
  const ctx = await b.newContext({ ...devices['iPhone 13'], locale, timezoneId: tz });
  const p = await ctx.newPage();
  const logs = [], fails = [];
  p.on('console', m => { if (m.type() === 'error' || /Checkout|stripe|erro|error/i.test(m.text())) logs.push(m.type() + ': ' + m.text().slice(0, 200)); });
  p.on('response', r => { if (r.status() >= 400) fails.push(r.status() + ' ' + r.url().slice(0, 150)); });
  p.on('requestfailed', r => fails.push('FAIL ' + r.url().slice(0, 150) + ' ' + (r.failure()?.errorText || '')));
  const t0 = Date.now(); let pronto = null;
  await p.goto(URL_CK + '?src=vStteste&sck=vStteste', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => logs.push('goto ' + e.message));
  try { await p.waitForSelector('text=/Pagar|Pay/', { timeout: 45000 }); pronto = Date.now() - t0; } catch {}
  await p.waitForTimeout(3000);
  await p.waitForTimeout(5000);
  const frames = [];
  for (const f of p.frames()) { if (!/elements-inner-card/.test(f.url())) continue; try { frames.push(await f.evaluate(() => [...document.querySelectorAll('input')].map(i => (i.name || '') + ':' + (i.placeholder || '') + ':' + (i.disabled ? 'off' : 'on')).join(','))); } catch (e) { frames.push('erro ' + e.message.slice(0, 80)); } }
  const loc = await p.evaluate(() => fetch('/api/request-location').then(r => r.text()).catch(e => String(e)));
  const txt = (await p.innerText('body').catch(() => '')).slice(0, 600);
  await p.screenshot({ path: `ck-${nome}.png`, fullPage: true });
  out.runs.push({ frames, nome, pronto_ms: pronto, loc, txt, logs: logs.slice(0, 40), fails: fails.slice(0, 30) });
  await ctx.close();
}
await b.close();
fs.writeFileSync('ck.json', JSON.stringify(out, null, 1));
