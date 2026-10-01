# Project status: geoli.eu

_Last updated: 2026-10-01. Update this file whenever something important changes._

## 1. What's live

| Feature | Where | Notes |
|---|---|---|
| Site EN `/` + RO `/ro/`, blog `/blog/`, `/ro/blog/` | `src/pages`, `src/components/Home.astro`, `src/i18n/ui.ts` | Light/dark theme (`public/theme-init.js`, `src/scripts/theme.ts`), WCAG AA colours |
| Articles | `src/content/blog/*.md` | Schema in `src/content.config.ts` (description 50–170 chars) |
| Legal | `/legal/`, `/ro/legal/`, `/privacy/`, `/ro/privacy/` | For a **private individual in Romania** (GDPR, ANSPDCP, Law 506/2004). No home address needed. `/impressum/` redirects to `/legal/` |
| SEO | `src/layouts/Base.astro`, `src/lib/seo.ts`, `src/pages/sitemap.xml.ts`, `rss.xml.ts` | JSON-LD: Person, ProfilePage, WebSite, ProfessionalService, BlogPosting, Breadcrumb. OG card per post (`npm run og`) |
| AI agents | `src/lib/agents.ts`, `/llms.txt`, `/llms-full.txt`, `/index.md`, `/blog/<slug>.md` | MD copies are `noindex` with a canonical `Link` header (`scripts/postbuild.mjs`). `robots.txt` has `Content-Signal: search/ai-input/ai-train=yes` |
| **Contact form** | `src/scripts/form.ts` → `POST /api/contact` → `worker/contact.ts` | Email via Cloudflare Email Routing `send_email` binding `CONTACT_EMAIL`, from `formular@geoli.eu` to George's Gmail, Reply-To = visitor. Honeypot + min fill time + same-origin + rate limit |
| **Vault** `/vault/` | `worker/index.ts`, `auth.ts`, `share.ts`, `ui.ts` | Cloudflare Access login (email one-time PIN), Worker re-verifies the JWT. Files in R2. Share links `/s/<token>` (HMAC, `SHARE_SECRET`) |
| **Article editor** (vault → Articles) | `worker/posts.ts`, `worker/ui.ts` | Commits `src/content/blog/<slug>.md` via the GitHub API (`GITHUB_TOKEN` secret). Images to R2 `media/blog/…`, served at `/media/*`. Shows "Live now ✓" by polling `/version.json` |
| Roles | `wrangler.jsonc` vars | `ADMIN_EMAILS` = george.lincu@gmail.com · `EDITOR_EMAILS` = volonci.madalina@gmail.com (articles only; can't delete articles or touch files). Both must also be in the Access policy |
| Monitoring | `.github/workflows/monitor.yml` | Hourly: pages, headers, secret files 404, vault closed, TLS expiry. Opens/closes a GitHub issue |
| CI | `.github/workflows/ci.yml`, `lighthouserc.json` | astro check + worker tsc, build, inline-code guard, Lighthouse (error < 0.9) |

## 2. Cloudflare (account `5e0e9d85f90eaeb01b29249421c8ec11`, zone geoli.eu `d360fa9496e6a20bdafef77fdd8bc0b3`)
- **Worker** `geoli`, custom domains `geoli.eu` + `www.geoli.eu`; `workers_dev` and `preview_urls` are off. Secrets: `SHARE_SECRET`, `GITHUB_TOKEN`.
- **R2** bucket `geoli-vault` (WEUR): user files plus `media/` for article images.
- **Zero Trust**: team `plain-block-9dbd.cloudflareaccess.com`, app "GeoLi Vault" (`a886d9aa-7c21-46ae-84a9-21ec800457a1`) on `geoli.eu/vault*` and `www…`. Policy "Invited people": George + Madalina. Login methods: Cloudflare + one-time PIN (George added OTP; verify if login issues appear). George has MFA on his account.
- **WAF custom rules**:
  - block scanner paths (.env, .git, wp-*, .php…)
  - only GET/HEAD/OPTIONS except `/vault/`, `/cdn-cgi/`, `POST /api/contact`
  - block Bytespider
- **Rate limit**: `/vault/api/`, `/s/`, `/api/` at 40 requests per 10 s per IP. **Managed**: Free Managed Ruleset is deployed.
- **Redirect**: `www.geoli.eu/*` → `https://geoli.eu/*` (301). There's an old disabled "Root to www" rule; leave it disabled.
- **Settings**: SSL strict, Always HTTPS, TLS 1.2+, TLS 1.3, Early Hints, Browser Integrity Check, Email Obfuscation **off**.
- **Bots**: AI bot blocking off (GPTBot/ClaudeBot etc. allowed); managed robots.txt off.
- **DNS**:
  - AAAA `100::` (proxied) for the Worker
  - MX/SPF/DKIM from Email Routing
  - DMARC `p=reject`
  - CAA: letsencrypt.org, pki.goog, ssl.com, plus iodef
  - **DNSSEC active** (DNSKEY added at Hostinger)
- **Email Routing**: `contact@geoli.eu` → Gmail; catch-all drops.
- Workers Builds uses its own build token. **Never delete it.**

## 3. GitHub (`GeorgeLincu/geoli`, public)
- `main` is protected: required check "Type-check, build & Lighthouse", no force-push or delete (admins can bypass; the vault editor commits directly as George).
- Dependabot alerts and security updates on, with TypeScript 7 / `@types/node` majors ignored (`.github/dependabot.yml`). Secret scanning and push protection on. Merged branches are auto-deleted.
- If the repo goes **private**, branch protection and secret scanning stop on the Free plan, and Actions minutes drop to 2,000/month. Then change the monitor cron to every 3 h.

## 4. Content
- Published: `rpa-at-scale-lessons-from-enterprise-deployments`, plus whatever George publishes from the vault.
- Drafts awaiting George's review: Copilot Studio, zero-cost Azure, plus six articles from a parallel session (EN + RO: Azure OpenAI costs, RPA→hyperautomation, GenAI governance). Some contain invented first-person claims ("I've seen…") that must be rewritten or removed before publishing. Romanian articles currently live in the same `/blog/`; a separate RO blog would need a `lang` field in the schema.
- `testing-article.md` is George's test post; ask before deleting it.
- No case studies or testimonials yet. Only real, permitted ones may be added.

## 5. Open tasks

**George (manual):**
- [ ] Review and publish the draft articles in the vault.
- [ ] Google Search Console (Domain property, submit `/sitemap.xml`) and Bing Webmaster Tools (import from GSC).
- [ ] LinkedIn: website link, Featured section, share articles.
- [ ] Renew the **GitHub publishing token before 2026-10-30** (1-year expiry this time). Then Claude updates the `GITHUB_TOKEN` secret.
- [ ] The Cloudflare token expires **2026-10-09**. Create a new one when Cloudflare work is needed (permissions are listed in `docs/CLOUDFLARE-SETUP.md` §0).
- [ ] Optional: CV PDF at `public/assets/george-lincu-cv.pdf`, square photo `public/assets/george.jpg`, Cal.com link in `src/config.ts` `bookingUrl` (the link must exist).
- [ ] Decide whether the repo stays public (see §3).
- [ ] 2FA/passkeys on GitHub, Gmail and Hostinger; registrar lock and auto-renew.
- [ ] Check the BearingPoint contract regarding side work ("Available for projects").

**Claude (next ideas, ask before starting the big ones):**
- [ ] Optional HSTS preload submission (hstspreload.org) once George agrees.
- [ ] Turn on Cloudflare Web Analytics and Crawler Hints (needs extra token permissions).
- [ ] Separate Romanian blog (`lang` field, `/ro/blog/<slug>/`, hreflang pairs per article).
- [ ] Case studies section, once George provides real projects.
- [ ] Cloudflare Turnstile on the contact form if spam appears (needs a Turnstile token permission; add to the CSP).
- [ ] R2 backup job.
- [ ] **dermi.ro**: separate repo and session. The full brief is in `PROMPT-dermi.md` (not committed; kept locally next to this repo).

## 6. History (short)
- PR #2: Cloudflare headers, stopped serving `.git`, SEO basics.
- PR #4: Astro migration, bilingual SEO, AI-agent files, monitor.
- PR #3: vault (Access + R2 + share links).
- PR #10: legal pages for Romania.
- PR #11: article editor.
- PR #12: reverted fabricated content from a parallel session.
- PR #13: editor role.
- Then: contact form via Email Routing.
