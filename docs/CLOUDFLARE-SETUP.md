# Cloudflare & domain hardening checklist

Everything here is free. Each item says **why** it matters. There are two ways to get it done:

- **A — let Claude do it:** create one API token (section 0, about 5 minutes). Claude then applies sections 1–5 through the Cloudflare API and verifies them.
- **B — do it yourself:** click through the dashboard steps below.

---

## 0. (Option A) Give Claude a scoped, expiring API token

Dashboard → top-right profile → **My Profile → API Tokens → Create Token → Create Custom Token**

- **Name:** `claude-geoli-setup`
- **Permissions:**

  | Scope | Item | Level |
  |---|---|---|
  | Account | Workers R2 Storage | Edit |
  | Account | Workers Scripts | Edit |
  | Account | Access: Apps and Policies | Edit |
  | Account | Access: Organizations, Identity Providers, and Groups | Read |
  | Account | Email Routing Addresses | Edit |
  | Zone | DNS | Edit |
  | Zone | Zone Settings | Edit |
  | Zone | Zone WAF | Edit |
  | Zone | Single Redirect | Edit |
  | Zone | Bot Management | Edit |
  | Zone | Email Routing Rules | Edit |
  | Zone | Zone | Read |

- **Account Resources:** Include → your account
- **Zone Resources:** Include → Specific zone → `geoli.eu`
- **TTL (expiry):** 7 days from today, so it stops working automatically

Copy the token and save it **in a file outside this project**, never in chat and never in git:
```
C:\Users\george.lincu\.secrets\cloudflare-token.txt
```
Then tell Claude "token is ready". Delete the token when the work is done, or let it expire.

> Two things only you can do, even with a token: **turn on R2** (Cloudflare asks for a payment card, but nothing is charged below 10 GB) and **pick the Zero Trust Free plan** the first time you open Zero Trust.

---

## 1. Let AI assistants learn about you (visibility)

**Why:** Cloudflare's AI Crawl Control currently blocks GPTBot (ChatGPT), ClaudeBot, CCBot (Common Crawl, used by many models) and Amazonbot. We tested these and they get `403`. Search-style agents are already allowed. For a personal brand, being in the models' knowledge is a plus.

Dashboard → `geoli.eu` → **AI Crawl Control** (or *Security → Bots*):
- Set **GPTBot, ClaudeBot, CCBot, Google-Extended, Applebot-Extended, Amazonbot, Meta-ExternalAgent** to **Allow**.
- Keep **Bytespider** blocked.
- Leave "Manage robots.txt" **off**. The site's own `robots.txt` already says what's allowed.

## 2. Stop people sending e-mail as `@geoli.eu` (anti-spoofing)

**Why:** the domain has no SPF, DKIM or DMARC records today. Anyone can send phishing mail "from" `you@geoli.eu`, and receiving servers can't tell it's fake.

- **If you want `contact@geoli.eu`:** Dashboard → **Email → Email Routing → Get started**. Create `contact@geoli.eu` → forward to your Gmail. Cloudflare adds the MX and SPF records for you.
- **Then add a DMARC record** (DNS → Add record):
  - Type `TXT`, name `_dmarc`
  - Value: `v=DMARC1; p=reject; adkim=s; aspf=s`
  - Optionally use **Email → DMARC Management** to get free reports.
- **If you don't want any e-mail on the domain,** add these instead:
  - `TXT @ "v=spf1 -all"`
  - `MX @ 0 .` (a "null MX")
  - the same DMARC record as above

## 3. Certificates & DNS integrity

- **CAA records** (only Cloudflare's certificate authorities may issue certificates for your domain). DNS → Add record:
  - Type `CAA`, name `@`, tag *Only allow specific hostnames*, value `letsencrypt.org`
  - Add the same record with `pki.goog`
  - Add the same record with `ssl.com`
- **DNSSEC:** DNS → Settings → **Enable DNSSEC**. Cloudflare shows a DS record; add it at the company where you bought `geoli.eu`. Their panel usually has a "DNSSEC" section.
- **SSL/TLS:**
  - Edge Certificates → **Always Use HTTPS**: on
  - **Minimum TLS**: 1.2
  - **TLS 1.3**: on
  - **Automatic HTTPS Rewrites**: on

## 4. One address only (SEO)

**Why:** `www.geoli.eu` and `geoli.eu` both serve the site, so Google sees two copies.

Rules → **Redirect Rules → Create rule → Redirect from WWW to root** template:
- Match `www.geoli.eu/*`
- Redirect to `https://geoli.eu/${1}`
- Status 301
- Preserve query string

## 5. Protection against attacks & abuse

- **Security → WAF → Managed rules:** enable the **Cloudflare Free Managed Ruleset**.
- **Security → WAF → Rate limiting rules (1 free):**
  - Match path starts with `/vault/api/` **or** path starts with `/s/`
  - Limit: 60 requests per 10 seconds per IP
  - Action: Block for 1 minute
- **Security → Bots → Bot Fight Mode:** on. If the GitHub site monitor starts reporting failures, turn it off or add a WAF *skip* rule for its user agent `geoli-monitor`.
- **Security → Settings → Browser Integrity Check:** on.
- **Speed/Caching → Crawler Hints:** on. It tells Bing and Yandex (via IndexNow) as soon as a page changes.
- **Analytics → Web Analytics → Add site** `geoli.eu`. It's cookie-free, so no consent banner is needed.

## 6. Optional: HSTS preload

The site now sends `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`. After step 4 is live, you can submit `geoli.eu` at <https://hstspreload.org>. Browsers will then never even try plain HTTP.

⚠️ It's a long-term commitment: every subdomain you ever create must support HTTPS. With Cloudflare that's automatic.

## 7. Search engines & profiles (visibility)

- **Google Search Console:**
  - Add a *Domain* property `geoli.eu`. Cloudflare can add the DNS verification in one click.
  - Submit `https://geoli.eu/sitemap.xml`.
  - Use *URL inspection → Request indexing* for `/`, `/ro/` and each article.
- **Bing Webmaster Tools:** import from Search Console. Bing powers ChatGPT search and Copilot, so it matters for AI visibility.
- **LinkedIn:**
  - Put `https://geoli.eu` in your profile's *website* field and *Featured* section.
  - Post each article with a link back.
  - Consistent name + headline everywhere helps Google and AI models connect "George Lincu" to one entity.
- **Google Business Profile:** optional; worth it if you want local "AI consultant near me" searches.
