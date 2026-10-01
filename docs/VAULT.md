# The private vault — setup & use

`geoli.eu/vault` is a private area for sharing files and hidden pages. Everything is on Cloudflare's free tier.

| Piece | What it does | Free limit |
|---|---|---|
| **Cloudflare Zero Trust Access** | Login wall in front of `/vault` (one-time code by e-mail, or Google/GitHub sign-in) | 50 users |
| **R2 bucket `geoli-vault`** | Stores the files — never in git | 10 GB storage, no download (egress) fees |
| **The Worker** (`worker/`) | Checks the login token, lists/serves files, uploads, signed share links | 100,000 requests/day |

Who can do what:

- **Admins** (`ADMIN_EMAILS` in `wrangler.jsonc`): everything — files, share links, articles.
- **Editors** (`EDITOR_EMAILS`): write, edit, publish and unpublish articles and add images to them. For files they're like invited people (view and download only). Only admins can delete an article.
- **Invited people**: browse and download everything **except** other people's `people/<email>/` folders.
- **`people/<email>/`**: visible only to that person and admins, which makes it the place for one-person handovers.
- **Share links** (`geoli.eu/s/…`): anyone with the link can download that one file until it expires (1 hour to 30 days). No sign-in needed.
- **Markdown files** (`.md`) open as private web pages at `/vault/p/<path>.md`.

---

## One-time setup (about 20 minutes)

> Do steps 1–4 **before** merging the vault pull request. The deploy fails if the R2 bucket doesn't exist yet.

### 1. Create the R2 bucket
Cloudflare dashboard → **R2 Object Storage** → *Create bucket* → name **`geoli-vault`**, location *Automatic* (or *EU* jurisdiction if you prefer data in the EU).
Cloudflare asks for a payment method the first time you enable R2, even on the free plan. You're only charged above 10 GB or 1 M uploads a month.

### 2. Create the Access application (the login)
Dashboard → **Zero Trust** (pick the Free plan if asked; choose a team name such as `geoli`).

1. **Settings → Authentication → Login methods**: *One-time PIN* is on by default. Optionally add Google or GitHub.
2. **Access → Applications → Add an application → Self-hosted**:
   - Name: `GeoLi Vault`
   - Session duration: `24 hours`
   - Public hostname: domain `geoli.eu`, path `vault`
   - Add a second hostname: `geoli.eu`, path `vault/*`
   - (If `www.geoli.eu` also serves the site, add `www.geoli.eu` + `vault` and `vault/*` too. Better: redirect `www` to `geoli.eu`.)
3. **Policy**: name `Invited people`, action **Allow**, include → *Emails* → your address plus everyone you invite. (Or use *Emails ending in* `@yourfamily.com`.)
4. Save. Open the application again → **Overview** → copy the **Application Audience (AUD) Tag**.
5. Your **team domain** is shown under **Settings → Custom Pages**, e.g. `geoli.cloudflareaccess.com`.

⚠️ **Do not** put `/s/*` behind Access. Share links must work without sign-in.

### 3. Tell the Worker about Access
In `wrangler.jsonc`, fill in:
```jsonc
"ACCESS_TEAM_DOMAIN": "geoli.cloudflareaccess.com",
"ACCESS_AUD": "<the AUD tag>",
"ADMIN_EMAILS": "george.lincu@gmail.com"
```
These are not secrets: the Worker still verifies every login token cryptographically.

### 4. Set the share-link secret
Dashboard → **Workers & Pages → geoli → Settings → Variables and Secrets → Add** → type **Secret**, name `SHARE_SECRET`, value: a long random string (at least 32 characters). Generate one with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```
Changing this secret later invalidates all existing share links.

### 5. Merge the pull request
Workers Builds deploys it. Open `https://geoli.eu/vault/`, sign in with your e-mail's one-time code, and upload something.

---

## Everyday use

- **Invite someone**: Zero Trust → Access → Applications → GeoLi Vault → Policies → add their e-mail. Send them `https://geoli.eu/vault/`.
- **Give one person private files**: create the folder `people/<their-email>/` (lower-case) and upload into it.
- **Share with someone who has no login**: click **Share** next to a file and choose how long the link is valid.
- **Write a hidden page**: upload a `notes.md` file; it opens as a styled page.
- **Remove access**: delete their e-mail from the policy. To end active sessions immediately: Zero Trust → Access → *Revoke*.

---

## Writing and publishing articles (Articles tab)

Admins get an **Articles** tab in the vault:

- **New article**: title, URL, description (50–170 characters, it's the snippet Google shows), tags, date and the text in Markdown.
- **Insert image**: uploads to R2 and inserts the Markdown. Images are public at `geoli.eu/media/…` immediately.
- **Preview**: shows the rendered article before saving.
- **Draft** (ticked): saved but not visible on the site. Untick it and press **Publish** to put it live.
- Every save is a commit to GitHub (`src/content/blog/<slug>.md`). Cloudflare rebuilds the site and the article is live in about 1–2 minutes, including the sitemap, RSS feed, `llms.txt` and the Markdown copy for AI agents.

### One-time setup: the GitHub token (secret `GITHUB_TOKEN`)

1. GitHub → your avatar → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Fill in the token:
   - **Name:** `geoli-vault-publishing`
   - **Expiration:** 1 year (set a reminder to renew it)
   - **Repository access:** *Only select repositories* → `GeorgeLincu/geoli`
   - **Permissions → Repository permissions → Contents:** *Read and write*. Leave everything else at *No access*.
3. **Generate token**. Save the value in `C:\Users\<you>\.secrets\github-publishing-token.txt` with the same hidden-input PowerShell command used for the Cloudflare token, then tell Claude. Or add it yourself: Cloudflare → Workers & Pages → geoli → Settings → **Variables and Secrets → Add → Secret**, name `GITHUB_TOKEN`.

The token can only change files in this one repository. If it leaks, revoke it in the same GitHub page.

## Limits and safety notes

- Uploads through the browser are limited to **100 MB per file** (Workers request limit).
- HTML, SVG and other active file types are always **downloaded**, never displayed on geoli.eu, so they can't run scripts on your domain.
- Anything very sensitive (IDs, contracts): encrypt it before uploading (e.g. a 7-Zip archive with AES-256 and a password you send separately).
- Access logs: Zero Trust → Logs → Access. Worker logs: Workers & Pages → geoli → Observability.
- Local testing: copy `.dev.vars.example` to `.dev.vars`, run `npm run preview`, open <http://localhost:8787/vault/>. R2 is simulated locally, so nothing touches your real bucket.
