# geoli.eu — notes for Claude Code

Personal site + blog + private vault of **George Lincu** (Romania). **Talk to George in Romanian**; write code, commits and docs in English. He isn't a developer: give click-by-click steps for anything he must do.

**Start here:** read `docs/STATUS.md` (what exists, how it's wired, open tasks). Don't re-explore the whole repo.

## Stack (one line each)
- **Astro 7** static site → `dist/` (`src/`), EN at `/`, RO at `/ro/` (real pages, hreflang). Strings in `src/i18n/ui.ts`.
- **Cloudflare Worker `geoli`** (`worker/`), static assets + routes run first for `/vault*`, `/s/*`, `/media/*`, `/api/*`. Config in `wrangler.jsonc`.
- Deploy = **Workers Builds** on every push to `main` (wrangler runs `npm run build`). Live in ~1–2 min; `/version.json` shows the live commit.
- Content: `src/content/blog/*.md` (articles), `src/content/projects/*.md` (case studies; none yet).

## Hard rules
1. **Never push to `main`.** Branch → `gh pr create` → merge when CI is green. `gh` is at `"C:\Program Files\GitHub CLI\gh.exe"` (not on PATH).
2. Check `git status` and the branch before git work. Another Claude session may share this folder; prefer `git worktree` for parallel work.
3. **Never invent content**: no testimonials, clients, case studies, metrics, or first-person experience George didn't give you. AI-written articles get `draft: true`. (A parallel session once did this; it was reverted in PR #12, and its output is on branch `review/terminal-session`.)
4. **CSP has no `unsafe-inline`**: no inline `<script>`, `<style>` or `style=""` (CI fails). CSS goes in `src/styles/`, JS in `src/scripts/`. Any new third-party domain must be added to the CSP in `public/_headers`.
5. **Secrets are never printed or committed.** Token files live in `C:\Users\george.lincu\.secrets\` (`cloudflare-token.txt`, which **expires 2026-10-09**; `github-publishing-token.txt`, which **expires 2026-10-30**). Read them only inside commands.
6. Never delete Cloudflare's **Workers Builds token** ("geoli build token"); every build breaks if it's gone.
7. Cloudflare **Email Obfuscation must stay OFF** (it injects inline JS).

## Windows / corporate-laptop quirks
- TLS is intercepted by Netskope: use `curl --ssl-no-revoke`; Python needs an unverified SSL context; public DoH/DNS lookups are blocked.
- Bash heredocs with complex quoting break. Write Python/JS helper scripts to files instead. Keep paths short (long-path errors in temp worktrees; the vite cache fails in junctioned `node_modules`).
- Screenshots and OG images: headless Edge (`msedge.exe --headless=new --screenshot`). It returns before the file is written, so poll for it (`scripts/og-images.mjs` does).

## Commands
`npm run dev` (drafts visible) · `npm run build` · `npm run check` (astro check + worker tsc) · `npm run preview` (wrangler dev on built site; vault login is simulated via `.dev.vars` `DEV_EMAIL`, localhost only) · `npm run og` (social cards for new posts)
