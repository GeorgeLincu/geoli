// Renders a 1200×630 social card for every blog post that doesn't have one yet:
//   npm run og            (add --force to re-render all)
// Uses the locally installed Edge/Chrome in headless mode — no extra dependencies.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root    = resolve(import.meta.dirname, '..');
const blogDir = join(root, 'src/content/blog');
const outDir  = join(root, 'public/assets/og');
const fonts   = pathToFileURL(join(root, 'public/assets/fonts')).href;
const force   = process.argv.includes('--force');

const candidates = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const browser = candidates.find(p => existsSync(p));
if (!browser) throw new Error('No Edge/Chrome found — set BROWSER=/path/to/chrome');

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const field = (fm, key) => fm.match(new RegExp(`^${key}:\\s*"?(.+?)"?\\s*$`, 'm'))?.[1] ?? '';

function card({ title, tag }) {
  const size = title.length > 60 ? 58 : title.length > 40 ? 66 : 76;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Inter;src:url('${fonts}/inter.woff2');font-weight:100 900}
@font-face{font-family:Syne;src:url('${fonts}/syne.woff2');font-weight:400 800}
html,body{margin:0;width:1200px;height:630px;overflow:hidden;background:#08090f;font-family:Inter}
.a{position:absolute;border-radius:50%;filter:blur(90px)}
.g{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:60px 60px}
.c{position:absolute;inset:78px 88px 70px;display:flex;flex-direction:column}
.logo{font-family:Syne;font-weight:800;font-size:36px;color:#f1f5f9}.logo span{color:#22d3ee}
.tag{align-self:flex-start;margin-top:auto;border:1px solid rgba(99,102,241,.4);background:rgba(99,102,241,.14);color:#c7d2fe;border-radius:100px;padding:8px 20px;font-size:22px;font-weight:500}
h1{font-family:Syne;font-weight:800;font-size:${size}px;line-height:1.05;margin:22px 0 auto;color:#f1f5f9;letter-spacing:-.5px}
.f{display:flex;justify-content:space-between;font-size:24px;color:#94a3b8}.f b{color:#a5b4fc;font-weight:500}
</style></head><body>
<div class="a" style="width:620px;height:620px;background:#6366f1;left:-200px;top:-260px;opacity:.4"></div>
<div class="a" style="width:520px;height:520px;background:#22d3ee;right:-180px;bottom:-200px;opacity:.25"></div>
<div class="g"></div>
<div class="c"><div class="logo">GeoLi<span>.</span></div>
<div class="tag">${esc(tag)}</div><h1>${esc(title)}</h1>
<div class="f"><span>George Lincu</span><b>geoli.eu/blog</b></div></div></body></html>`;
}

function shoot(html, png) {
  const work = join(tmpdir(), `geoli-og-${process.pid}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const page = join(work, 'card.html');
  writeFileSync(page, html);
  return new Promise((ok, fail) => {
    const p = spawn(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      `--user-data-dir=${join(work, 'profile')}`, '--force-device-scale-factor=1', '--window-size=1200,630',
      `--screenshot=${png}`, pathToFileURL(page).href], { stdio: 'ignore' });
    p.on('error', fail);
    // Edge on Windows may return before the file is written — wait for it
    p.on('exit', () => {
      const t0 = Date.now();
      const poll = () => existsSync(png) && statSync(png).size > 0 ? ok()
        : Date.now() - t0 > 30000 ? fail(new Error(`Timed out rendering ${png}`)) : setTimeout(poll, 250);
      poll();
    });
  }).finally(() => {
    // Edge can hold its profile open for a moment after exiting — cleanup is best-effort
    try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch {}
  });
}

mkdirSync(outDir, { recursive: true });
for (const file of readdirSync(blogDir).filter(f => f.endsWith('.md') && !f.startsWith('_'))) {
  const slug = file.replace(/\.md$/, '');
  const png  = join(outDir, `${slug}.png`);
  if (existsSync(png) && !force) continue;
  const fm = readFileSync(join(blogDir, file), 'utf8').split('---')[1] ?? '';
  const tag = fm.match(/^tags:\s*\[\s*"([^"]+)"/m)?.[1] ?? 'Insights';
  await shoot(card({ title: field(fm, 'title'), tag }), png);
  console.log(`✓ ${slug}.png`);
}
