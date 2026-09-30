# geoli.eu

Personal site of George Lincu — built with [Astro](https://astro.build), deployed to **Cloudflare Workers** (static assets) by *Workers Builds* on every push to `main`.

## Everyday tasks

| I want to… | Do this |
|---|---|
| **Run the site locally** | `npm install` once, then `npm run dev` → <http://localhost:4321> (drafts are visible here) |
| **Write an article** | Add `src/content/blog/my-slug.md` (copy the frontmatter of an existing post). Keep `draft: true` while writing |
| **Publish an article** | Set `draft: false`, then `npm run og` to create its social-media image, commit and push |
| **Preview drafts in a production build** | `PREVIEW_DRAFTS=1 npm run build` (never set this in Cloudflare) |
| **Add a case study** | Copy `src/content/projects/_template.md` to e.g. `invoice-bot.md`, fill it in, set `draft: false`. The *Projects* section appears automatically |
| **Show my CV button** | Put the PDF at `public/assets/george-lincu-cv.pdf` |
| **Show my photo** | Put a square JPG at `public/assets/george.jpg` |
| **Add a "Book a call" button** | Set `bookingUrl` in `src/config.ts` (e.g. a free Cal.com link) |
| **Turn on the contact form** | Put your Web3Forms key in `web3formsKey` in `src/config.ts` |
| **Change any text** | `src/i18n/ui.ts` — every key exists in English and Romanian |
| **Share files privately** | Use **geoli.eu/vault** — see [docs/VAULT.md](docs/VAULT.md) for setup and everyday use |
| **Harden Cloudflare / DNS, boost visibility** | Follow [docs/CLOUDFLARE-SETUP.md](docs/CLOUDFLARE-SETUP.md) |
| **Test exactly like production** | `npm run preview` (builds, then serves with Cloudflare's headers/redirects via wrangler) |

## Structure

```
src/
  pages/            routes: /, /ro/, /blog/, /ro/blog/, /blog/<slug>/, /legal/, /privacy/ (+ /ro/ versions), 404, rss.xml, sitemap.xml
  components/       Home, Nav, Footer, BlogIndex
  layouts/Base.astro  <head>: SEO, hreflang, Open Graph, JSON-LD
  content/          blog + projects (Markdown)
  i18n/ui.ts        all UI strings (EN/RO)
  styles/           CSS (dark + light theme tokens in base.css)
  scripts/          small client-side TypeScript (nav, theme, form, animations)
public/
  _headers          security headers (CSP!) + caching — applied by Cloudflare
  _redirects        short links (/cv, /imprint, /datenschutz)
  assets/           fonts, icons, images, og/ social cards
worker/             Cloudflare Worker: private /vault (Access login + R2 files) and /s/ share links
scripts/og-images.mjs  renders social cards with local Edge/Chrome
wrangler.jsonc      Cloudflare config (build command, 404 handling, R2 binding, Access settings)
```

## Rules that keep the site secure

- **The repo is public.** Never commit private files, keys or personal data other than what's on the site.
- **No inline `<script>`/`<style>`/`style=""`.** The Content-Security-Policy in `public/_headers` blocks them; CI fails if any appear. Put CSS in `src/styles/` and JS in `src/scripts/`.
- Adding a third-party service (analytics, embeds, forms) needs its domain added to the CSP in `public/_headers`.

## CI

`.github/workflows/ci.yml` type-checks, builds, guards against inline code and runs Lighthouse on every PR. Dependabot opens monthly update PRs.
