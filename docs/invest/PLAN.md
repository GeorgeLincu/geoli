# Plan: secțiunea privată „Investiții” pe geoli.eu

## Context
George vrea, pe geoli.eu, o zonă ascunsă, doar pentru el, accesibilă de pe orice dispozitiv, care să țină loc de
**Investment Policy Statement (IPS)**, de planificator FIRE (vârstă, capital, contribuție lunară + creștere anuală %,
ani de investit, cheltuieli la pensie, SWR, inflație), de **registru de portofoliu** (acțiuni, ETF-uri, obligațiuni,
acțiuni BVB, titluri de stat, Pilon 2/3), de **calculator fiscal pentru rezident RO** (toate pragurile editabile, pe ani),
cu **grafice** bune și **rapoarte anuale**. `Downloads/plan.html` (calculator single-file cu Chart.js: proiecție,
Monte Carlo, alocare, glidepath, CASS, decumulare) e punctul de plecare pentru logică, nu un șablon de copiat.

Decizii luate cu George:
- Intrare: **scurtătură secretă de tastatură** pe orice pagină (`g` apoi `i`) → `/vault/invest/`. Nimic vizibil.
- Date: **registru de tranzacții + instantanee anuale** (31 dec).
- Prețuri: **automat zilnic** (cursuri BNR + prețuri din surse gratuite), cu corecție manuală.
- Are: broker străin, broker românesc (BVB), titluri de stat (Tezaur/Fidelis), Pilon 2/3.

## „Echipa de experți” — ce aduce fiecare rol
| Rol | Contribuție în plan |
|---|---|
| Planificator financiar (CFP/FIRE) | Model FI: număr FI, Coast FI, Monte Carlo, risc de secvență, glidepath/bond tent, strategii de retragere (SWR fix, guardrails Guyton-Klinger, VPW). Totul **în termeni reali** + afișare nominală. |
| Consultant fiscal RO | Motor fiscal **versionat pe ani**: fiecare parametru are valoare, sursă (link ANAF/Cod fiscal) și „verificat la data”. Nimic hardcodat. Ajutor pentru Declarația Unică. |
| Analist cantitativ | XIRR (randament ponderat cu banii), TWR, cost mediu ponderat, curs BNR pe tranzacție, randament real vs inflație, benchmark. Teste unitare pentru toate formulele. |
| Data-viz | Apache ECharts (self-hosted, tree-shaken, fără CDN → CSP neschimbat), paletă din tokenurile site-ului, light/dark. |
| Frontend/arhitect | Pagini Astro sub `/vault/invest/`, logică TS pură în `src/lib/invest/`, UI în română, mobil-first, „mod discret” (ascunde sumele). |
| Securitate | Cloudflare Access + verificare în Worker că e **proprietarul** (nu orice admin/editor). Date în R2 sub prefix invizibil în Files. Backup la fiecare salvare. |

> Aplicația e un **calculator personal**, nu consultanță. Alocarea-țintă, fondurile și textul IPS le scrie George; Claude nu inventează conținut (regula #3 din CLAUDE.md).

## Arhitectură (recomandată)
- **Rute**: `/vault/invest/*` (pagini) și `/vault/api/invest/*` (API). Ambele sunt deja sub Access și `run_worker_first`.
  - `worker/index.ts`: înainte de restul rutelor vault, dacă path-ul începe cu `/vault/invest` sau `/vault/api/invest` și
    `user.email ∉ INVEST_EMAILS` (var nouă în `wrangler.jsonc`, = george.lincu@gmail.com) → 404.
  - Paginile vin din `dist/vault/invest/` (build Astro); Worker-ul le servește cu `env.ASSETS.fetch(request)` **după** verificare,
    și suprascrie headerele cu `baseHeaders` (`no-store`, `noindex`) + CSP-ul aplicației.
- **Frontend**: `src/pages/vault/invest/{index,portofoliu,plan,taxe,pensie,ips,rapoarte}.astro`, layout propriu
  `src/layouts/Invest.astro` (fără SEO/JSON-LD, `noindex`), CSS în `src/styles/invest.css`, JS în `src/scripts/invest/*.ts`.
  Fără inline script/style (CI-ul verifică). Paginile NU apar în sitemap (`src/pages/sitemap.xml.ts` e manual — ok).
- **Logică pură**: `src/lib/invest/` — `projection.ts`, `montecarlo.ts`, `withdrawal.ts`, `ledger.ts` (cost mediu ponderat,
  câștig realizat), `returns.ts` (XIRR, TWR), `tax-ro.ts`, `fx.ts`, `types.ts`. Testate cu **vitest** (dev dep nou, adăugat în CI).
- **Stocare R2** (bucket existent `geoli-vault`), prefix `invest/`, ascuns din Files pentru toți (modific `list`/`canRead`):
  - `invest/data.json` — setări plan, conturi, instrumente, tranzacții, ținte de alocare, scenarii.
  - `invest/tax-rules.json` — parametri fiscali pe ani. `invest/ips.json` — versiuni IPS.
  - `invest/prices/<an>.json`, `invest/fx/<an>.json` — istoric zilnic. `invest/snapshots/<an>-12-31.json`.
  - `invest/backups/<timestamp>.json` — copie la fiecare salvare (păstrează ultimele 50). Concurență optimistă cu ETag.
- **Prețuri**: Cron Trigger în `wrangler.jsonc` (`triggers.crons`, gratuit), zilnic după închidere: curs BNR
  (`bnr.ro/nbrfxrates.xml`; istoric din fișierele anuale BNR), prețuri ETF/acțiuni din sursă gratuită aleasă după test
  (Yahoo chart / Stooq / BVB). Doar tickere în cereri, nicio dată personală. Eșec → păstrează ultimul preț + avertisment.
- **Scurtătură**: în `src/scripts/site.ts`, listener `keydown` pentru secvența `g`,`i` (ignorat în input-uri) → `/vault/invest/`.

## Funcționalități (pe pagini)
1. **Panou** — avere netă, progres FI (%), ani până la FI, Coast FI, rata de economisire, alocare vs țintă (benzi de drift),
   alerte IPS (rebalansare, fond de urgență, termen Declarația Unică).
2. **Portofoliu** — conturi (broker RO/străin, Tezaur/Fidelis, Pilon 2/3, cash), instrumente (clasă, regiune, monedă, acumulare/distribuție),
   tranzacții (cumpărare/vânzare/dividend/dobândă/comision/transfer), poziții calculate, valori în EUR și RON, scară de scadențe titluri de stat,
   **calculator de rebalansare prin contribuții** (cât din contribuția lunară merge unde ca să te apropii de ținta ta).
3. **Plan & proiecție** — toate input-urile din plan.html + creștere anuală a contribuției, inflație, randament real per clasă;
   proiecție deterministă + **Monte Carlo** (normal și bootstrap istoric), scenarii salvate și comparate, analiză de senzitivitate.
4. **Pensie / retragere** — SWR fix, guardrails, VPW; glidepath / bond tent; Pilon 2/3 și pensia de stat (opțional, introdusă manual);
   venit net după taxe în pensie; durată portofoliu și moștenire.
5. **Taxe RO** — parametri pe ani editabili (impozit câștig capital broker străin / reținere broker RO pe durata deținerii, dividende,
   credit fiscal pentru impozit reținut în străinătate, CASS cu praguri în salarii minime, salariu minim pe an, CAS, reportarea pierderilor,
   scutire titluri de stat, deducere Pilon 3). Calculează pe an: câștig/pierdere realizată (RON, curs BNR), dividende, CASS, total;
   **fișă pentru Declarația Unică** (sume pe categorii, nu depunere automată).
6. **IPS** — document structurat (obiective, orizont, toleranță la risc, alocare-țintă și benzi, reguli de contribuție/rebalansare,
   reguli de retragere, ce NU faci, revizuire anuală), cu versiuni datate; regulile numerice devin verificări automate în Panou.
   Șablonul conține doar titluri și întrebări — conținutul îl scrie George.
7. **Rapoarte anuale** — per an: valoare început/sfârșit, contribuții, câștig de piață, dividende, comisioane, taxe, XIRR & TWR,
   randament real (inflație), alocare la 31 dec vs țintă, respectare IPS, progres FI. Imprimabil → PDF.
8. **Extra** — mod discret (blur sume), export/import JSON + CSV, import CSV de la broker (după ce George dă un export real),
   test de stres („piața scade 40% mâine”).

**Grafice (ECharts)**: avere netă stivuită pe clase (contribuții vs creștere) · evantai Monte Carlo p10/p50/p90 cu linia FI ·
sunburst alocare (clasă → regiune → instrument) · actual vs țintă cu benzi de drift · cascadă anuală (start → contribuții → câștig → dividende → taxe → final) ·
heatmap randamente lunare · drawdown („underwater”) · glidepath pe vârstă · sold în pensie cu benzi guardrails · Sankey contribuție lunară → active ·
tornado senzitivitate · cronologie scadențe titluri de stat · treaptă CASS.

## Faze (un PR per fază, fiecare cu prompt-ul din PROMPTS.md)
| # | Fază | Rezultat vizibil |
|---|---|---|
| 0 | Fundație: rută + gard proprietar + API stocare + layout + scurtătură + ECharts + vitest | `/vault/invest/` se deschide doar pentru George |
| 1 | Plan & proiecție + Monte Carlo + scenarii | Calculatorul din plan.html, mai bun, cu date salvate |
| 2 | Registru portofoliu + rebalansare | Poziții reale, alocare vs țintă |
| 3 | Prețuri & cursuri automate (cron) | Valori actualizate zilnic |
| 4 | Motor fiscal RO + fișă Declarația Unică | Taxe pe an |
| 5 | Pensie / retragere | Strategii de retragere, glidepath |
| 6 | IPS + verificări | Document IPS versionat, alerte |
| 7 | Rapoarte anuale + Panou final | Raport pe fiecare an, PDF |
| 8 | Întărire: backup, export, mod discret, review securitate, documentație | — |

Fazele 1–3 pot rula în paralel după faza 0 (fișiere diferite); 4 depinde de 2+3; 7 depinde de toate.

## Progres faze
- [x] 0 Fundație — owner gate, `/vault/api/invest/<doc>` (ETag + backups), layout, ECharts helper, `g i` shortcut, vitest
- [x] 1 Plan & proiecție — `/vault/invest/plan/`: projection (real + nominal), FI number, Coast FI, years to FI, Monte Carlo in a Web Worker (seeded, normal/lognormal + historical bootstrap from pasted data, sequence-of-returns view), tornado, saved scenarios + comparison; inputs in `data.json` `settings.projection`
- [x] 2 Portofoliu — `/vault/invest/portofoliu/`: CRUD conturi/instrumente/tranzacții, `ledger.ts` (cost mediu ponderat, art. 97 alin. (8^2) Cod fiscal), `portfolio.ts` (evaluare, drift, rebalansare prin contribuții, scadențe), `fx.ts`/`prices.ts` (manual, interfață pentru Faza 3), Pilon 2/3 manual, export CSV
- [x] 3 Prețuri & cursuri — cron (lucrătoare 17:45 + 21:30 UTC), curs BNR + backfill anual, prețuri Yahoo (Xetra/LSE/US/BVB), preț manual, „Actualizează acum”, card pe Panou. Detalii: secțiunea „Surse de date (faza 3)”. Portofoliul folosește aceleași cursuri BNR și prețuri (un singur loc pentru corecțiile manuale): `src/lib/invest/market-sources.ts`
- [x] 4 Taxe RO — `/vault/invest/taxe/`: `tax-ro.ts` (foreign broker yearly net gain + loss carry-forward with cap, RO-broker withholding by FIFO holding period, RO/foreign dividends and interest with capped foreign tax credit, Tezaur/Fidelis exemption, CASS tiers, effective rate, `estimateSales` / `estimateWithdrawal` for Phase 5), per-year parameter editor (source, verified on, confirmed per value), printable „Fișă Declarația Unică” with BNR rates used, CASS step chart. Researched 2025/2026 values in `tax-ro-defaults.ts` (all `confirmed: false` until George confirms). Details: § „Reguli fiscale (faza 4)”
- [x] Extra: import CSV — `/vault/invest/import/` (link „Importă CSV” în Portofoliu → Tranzacții). Detalii: secțiunea „Import CSV”.
- [x] 5 Pensie & retragere — `/vault/invest/pensie/`: `withdrawal.ts` (sumă constantă reală, Guyton-Klinger, VPW, podea și plafon), toate pe același Monte Carlo ca Planul (Web Worker comun, aceeași sămânță, aceleași piețe pentru toate strategiile), glidepath / bond tent pe vârstă, venituri Pilon 2/3 + pensie de stat + altele (nete, introduse de George), venit net după taxe prin `tax-ro.ts` `estimateWithdrawal`, regulile de retragere din IPS afișate lângă rezultate. Detalii: secțiunea „Pensie & retragere (faza 5)”
- [x] Extra: avere netă — `/vault/invest/avere/` (nav „Avere netă”) + card pe Panou: portofoliul din registru + alte active și datorii notate de George, total EUR/RON azi și în timp, lichid vs ilichid, fond de urgență în luni, datorii / active. Detalii: secțiunea „Avere netă”.
- [x] Extra: calendar venituri — `/vault/invest/calendar/` (nav „Calendar”) + card „Încasări în următoarele 30 de zile” pe Panou. Detalii: secțiunea „Calendar venituri”.
- [x] 6 IPS — `/vault/invest/ips/`: editor cu titluri + întrebări (fără răspunsuri scrise), ciornă + versiuni imuabile (dată, notă), diferențe între versiuni, vizualizare pentru tipărire. Reguli verificabile în `ips.json` → `versions[].rules` (`IpsRules`): alertă la ieșirea din bandă (benzile rămân în ținta din Portofoliu), fond de urgență (luni × cheltuieli, conturi alese), contribuție lunară (sumă, zi, păsuire), luna revizuirii, termen Declarația Unică (scris de George), praguri la căderi (% sub maxim, pe un instrument). Alertele pe Panou: `src/lib/invest/ips-checks.ts`. Detalii: secțiunea „IPS (faza 6)”
- [ ] 7 Rapoarte anuale & Panou
- [ ] 8 Întărire

Prompt-urile pentru fiecare fază: [PROMPTS.md](PROMPTS.md).

## Extra: scădere de la maxim + alerte pe e-mail
- [x] Page `/vault/invest/oportunitati/` (nav „Scăderi”): per instrument with an automatic price source — last price, all-time high and 52-week high (with dates), % below each, deepest historical drawdown (peak → trough). Sortable table; rows that crossed George's levels are highlighted with the level and the extra amount he planned (if any) and the distance to the next level. Toggle: measure from the all-time or 52-week high. Underwater chart per instrument (ECharts) with his levels as dashed lines, plus the five deepest drawdowns (peak, trough, recovery date, duration). Numbers and his own rules only, no recommendations.
- [x] Long history: one-off per instrument, Yahoo `interval=1wk` since listing → `invest/history/<id>.json` (weekly closes, compact `[date, close]`), plus the last 400 days of **daily** closes merged into the normal price store `invest/prices/<year>.json` (manual prices are never overwritten). Summary (`ath`, range, symbol) in `invest/history/index.json` so the cron never parses the big files. Weekly was chosen over daily because a full daily history (e.g. AAPL since 1980: 1.3 MB) risks the free plan's 10 ms CPU limit; consequence: highs older than ~13 months are weekly closes and can be slightly below the true daily-close high. Fetched by the cron (1–2 per run, inside the 50-subrequest budget, see `cronHistoryBudget`) or with „Descarcă istoricul lipsă” (owner, max 5 per click, once a minute). An instrument is re-fetched when its symbol changes.
- [x] Levels: George's own list on the page (`invest/alerts.json` → `drawdown.levels`: % below the high, optional planned extra amount + currency, note) applies to every instrument. The IPS (Phase 6, PR #31) crash rules are read from the **newest `invest/ips.json` version by date** (never the draft): `rules.crash = { referenceInstrumentId?, rules: [{ id, dropPct (decimal), action?, extraAmount? (EUR) }] }`. With „Pentru instrumentul de referință din IPS…” on (default), they replace the page levels **for the reference instrument only**; with no reference instrument they apply to none. Reader: `ipsDipLevels()` in `drawdown.ts`, choice per instrument: `levelsForInstrument()` in `alerts.ts`. Default: no levels.
- [x] E-mail alerts, run after the price job in the existing cron (weekdays 17:45 and 21:30 UTC), sent through the existing `send_email` binding `CONTACT_EMAIL` from `CONTACT_FROM` to the first `INVEST_EMAILS` address only. Everything is **off by default**. One plain-text digest per run:
  - drawdown level crossed (once per crossing; re-armed when the price recovers 2.5 points above the level; a gap through several levels names all of them);
  - automatic price older than N days (default 5; once per stale date);
  - Declarația unică deadline (date entered on the page; if empty, the next occurrence of the IPS `rules.taxReturn` month/day; reminders N days before, default 30/7/1, each once);
  - Tezaur/Fidelis (any held instrument with a maturity) maturing within N days (default 30; once per instrument and maturity).
  - Privacy: names and percentages only; prices, planned amounts and face values only with „Include prețuri și sume”. Link to the page.
  - State in `invest/alerts-state.json` (what was already announced + last 30 sends). A failed send keeps the old state so the same events are retried next run.
  - „Trimite e-mail de test”: owner only, at most one per 2 minutes and 5 per day.
- [x] Logic and tests: `src/lib/invest/drawdown.ts` (series merge, highs, underwater, episodes, levels, crossing state), `src/lib/invest/alerts.ts` (settings validation, planner, digest text, raw e-mail, rate limit). Worker: `worker/alerts.ts` (API `/vault/api/invest/alerts*`, history fetch, cron run). Client: `src/scripts/invest/drawdown.ts`, CSS `src/styles/invest-drawdown.css`.
- Not tested live: e-mail delivery on Cloudflare (locally `wrangler dev` only writes the .eml file) and Yahoo's weekly endpoint from Cloudflare's egress IPs. Tested locally on 2026-11-27 with real Yahoo data (VWCE.DE, AAPL, TLV.RO).

## Calendar venituri
Page `/vault/invest/calendar/` (`src/pages/vault/invest/calendar.astro`, `src/scripts/invest/calendar.ts`, shared loader
`calendar-data.ts`, dashboard card `calendar-card.ts`, CSS `src/styles/invest-calendar.css`). Pure logic and tests:
`src/lib/invest/calendar.ts` / `calendar.test.ts` (invented data only).
- Window: 0/12/24 months back, 12/24 ahead; display currency RON or EUR (BNR rate of the day; future dates use the latest
  rate); net or gross amounts. ECharts bars per month: expected vs received, plus „Scadențe (principal)” hidden by default.
  Monthly and yearly totals table; list grouped by month with status.
- What appears (nothing is invented):
  - **Coupons** of every instrument with `maturity` + `coupon`, counted back from the maturity every 12/frequency months,
    for each account that held units the day before (future dates: units held today). Amount = units × `faceValue` ×
    coupon / frequency. Frequency per bond in `data.json` `calendar.bonds` (1/2/4/12); unset = 1 per year, shown as
    „frecvență presupusă”. No `faceValue` → average purchase price (warned). A coupon on the purchase day is not counted.
  - **Maturities**: units × face value; principal, not income (no tax, separate from the income totals).
  - **Expected dividends** only from George's schedule `calendar.dividends`: `manual` (months, day, gross per unit,
    currency) × units held, or `lastYear` = every dividend received is expected again one year later (payments of the last
    12 months repeat for up to 3 years ahead), scaled to the units held now (per unit = amount ÷ units held on the payment date).
  - **Other planned cash-ins** `calendar.planned` (one-off, monthly, quarterly, yearly, optional end date); tax only from
    George's own % (`taxRate`), else „necunoscut”.
  - **Received** dividend/interest transactions (actuals). A past expected coupon/dividend is „încasat” when a payment of the
    same type, instrument and account exists within ±31 days (each payment matches once), else „neîncasat?”.
- Tax (estimate, no CASS): `estimateIncomeTax()` uses `tax-ro.ts` — `rulesFor(year)`, `div.rate` / `int.rate`, Tezaur/Fidelis
  exemption (`int.govExempt`, `isGovInterest`, now exported) and `incomeSource`. Received RO income: the tax withheld (else
  the rate); foreign: max(withheld abroad, RO rate × gross). Marked „neconfirmat” when the parameter isn't confirmed for that
  exact year; „necunoscut” without tax rules.
- „De reinvestit”: button on each maturity → `calendar.reinvest` `{instrumentId, maturity, remind, daysBefore, note}`.
  The existing alerts cron (`worker/alerts.ts` → `planAlerts`) e-mails it once per instrument and maturity when the maturity
  is within `daysBefore` days (`reinvestReminders()` in `calendar.ts`, new alert kind `reinvest`, state
  `alerts-state.json` `reinvest`). Opt-in per maturity; it still needs the master switch „Alerte pe e-mail” (page Scăderi).
  Amounts only with „Include prețuri și sume”. A changed maturity date drops the marker.
- Tested locally on 2026-11-27 with invented data (owner, non-owner 404, 375 px, dark mode, no CSP errors) and a local cron
  run (`--test-scheduled`, the .eml was written). Not tested: delivery on Cloudflare; real Tezaur/Fidelis coupon calendars.

## Surse de date (faza 3)
Tested on 2026-11-27 from the laptop and from the Worker (`wrangler dev`, `/cdn-cgi/handler/scheduled`).

| Data | Source | Used for | Limits |
|---|---|---|---|
| BNR reference rates | `https://curs.bnr.ro/nbrfxrates10days.xml` (daily run) and `https://curs.bnr.ro/files/xml/years/nbrfxrates<year>.xml` (backfill) | EUR, USD, GBP, CHF → RON | Official, free, no key. The old `www.bnr.ro/nbrfxrates.xml` URLs now redirect to the BNR home page (the Worker treats redirects as errors). Rates are published on business days around 13:00; weekends/holidays use the previous published rate (`rateOn`). |
| Prices: Xetra, LSE, US, BVB (also Amsterdam, Milan, Paris, SIX) | Yahoo Finance chart API `query1/query2.finance.yahoo.com/v8/finance/chart/<symbol>` | Daily closes | **Unofficial**, free, no key; can change or rate-limit without notice (a call without a User-Agent got HTTP 429). Only the ticker symbol and a date range are sent, with a generic `User-Agent: Mozilla/5.0`. Some LSE lines are quoted in pence (`GBp`): converted to GBP. BVB quotes are delayed; the cron runs after the close, so the stored value is the close. One request per instrument per run; at most 20 instruments per run (free-plan limit of 50 subrequests). |
| Rejected | Stooq (`stooq.com/q/l/`, `/q/d/l/`) | — | Now answers with a JavaScript bot check (or 404), unusable from a Worker. |
| Rejected | Keyed APIs (Alpha Vantage, Twelve Data, EODHD, Finnhub) | — | Need an account and a secret; free tiers are small and most don't cover BVB. Kept as a fallback if Yahoo stops working. |

How it works:
- `Instrument.priceSource` = `<exchange>:<ticker>`: `xetra:VWCE` → `VWCE.DE`, `lse:VWRA` → `VWRA.L`, `us:AAPL`, `bvb:TLV` → `TLV.RO`, `ams:`, `mil:`, `par:`, `swx:`, or `yahoo:<exact symbol>`. Empty or `manual` = no automatic price.
- Cron (`wrangler.jsonc` `triggers.crons`, weekdays, UTC): `45 17 * * 1-5` after the European close, `30 21 * * 1-5` after the US close. Each run: BNR last 10 days, BNR yearly file for missing years (years with transactions + current year, max 2 per run), then for each instrument the last 14 days (or everything since a week before its first transaction, the first time).
- Storage: `invest/fx/<year>.json`, `invest/prices/<year>.json` (by instrument id; price in the listing currency), `invest/market-status.json` (last run, per-instrument result).
- A failed fetch keeps the previous prices; the dashboard shows „preț vechi din <data>” when the latest price is more than 5 days old.
- Manual price per instrument and date (`POST /vault/api/invest/market/override`, `close: null` removes it). Manual prices are never overwritten by the job.
- „Actualizează acum”: `POST /vault/api/invest/market/refresh`, owner only, at most once every 5 minutes (HTTP 429 + `Retry-After`).
- Pure logic and tests: `src/lib/invest/market.ts` (`parseBnrXml`, `parseYahooChart`, `rateOn`, `convert`, `latestPrice`, `isStale`…), fixtures in `src/lib/invest/__fixtures__/`.
- Not tested live: the Cron Trigger on Cloudflare's network (only locally) and how Yahoo treats Cloudflare's egress IPs. If prices fail after deploy, the dashboard shows the error per instrument.

## IPS (faza 6)
- Outline (headings + guiding questions only): `src/lib/invest/ips-sections.ts`. Keys are stored in `ips.json` `sections`; never rename one.
- `ips.json`: `versions[]` (immutable: `date`, `changeNote`, `sections`, `rules?`) and an optional `draft` (work in progress, never enforced).
- Rules in force = newest version by date: `activeIpsRules(doc)`. Other phases (drawdown alerts, yearly report) should read the rules through it.
- Alerts: `ipsAlerts(doc, facts)` in `src/lib/invest/ips-checks.ts`; the dashboard gathers the facts in `src/scripts/invest/ips-alerts.ts`
  (valuation with BNR rates + price store, drift with the Portofoliu default scope — no Pillar 2/3, with cash — and the same 5 pp fallback band).
- Crash rules: drawdown = latest saved close vs the highest saved close of the reference instrument (price store, plus older manual prices in `data.json`).
- Diff: line-based (`src/lib/invest/ips-diff.ts`); the rules are compared as readable lines. Print view: „Vizualizare pentru tipărire” → „Tipărește / PDF”.

## Reguli fiscale (faza 4)
Researched on 2026-11-27 from the Codul fiscal consolidated to 25.10.2026 (legislatie.just.ro 171282), Norme HG 1/2016 (307847),
Legea 141/2025, Legea 239/2025 and the US–RO treaty. Every value, with article and link, is in `src/lib/invest/tax-ro-defaults.ts`;
George loads them on the page („Încarcă valorile cercetate”), checks and confirms them. The stored copy is `invest/tax-rules.json`.

| | 2025 | 2026 |
|---|---|---|
| Foreign broker, yearly net gain (DU) | 10% | 16% |
| RO broker withholding ≥365 / <365 days (final) | 1% / 3% | 3% / 6% |
| Dividends | 10% | 16% |
| Interest (Tezaur/Fidelis exempt) | 10% | 10% |
| Loss carry-forward (foreign) | 5 years, max 70% of the year's gain | same |
| CASS 10%: 6/12/24 minimum wages; wage on 1 Jan of the income year | 4 050 lei | 4 050 lei |
| FX: gains at the daily BNR rate, foreign income at the yearly average | | |
| DU deadline | 25 May of the next year | |
Not modelled / open doubts (shown in the parameter notes): losses offset "per country"; losses from before 2024 keep their 7-year window;
whether RO-broker gains count gross or net for CASS; whether foreign income counts net of foreign tax for CASS; whether carried
losses reduce the CASS base; the rate for the purchase leg of foreign-currency trades; exact DU rows.
Engine API for Phase 5: `rulesFor(rules, year)` → `estimateWithdrawal(set, { year, withdrawalRon, gainShare, … })`
returns income tax, CASS, net amount and effective rate; `estimateSales` gives the marginal cost of planned sales.

## Import CSV
Page `/vault/invest/import/` (`src/pages/vault/invest/import.astro`, `src/scripts/invest/import.ts`), pure logic in
`src/lib/invest/import.ts` (tests: `import.test.ts`, invented rows only; never commit George's real files).
- The file is read and parsed in the browser (`FileReader`, UTF-8 with a Windows-1250 fallback). Only the result is saved:
  new transactions + confirmed new instruments, in **one** `data.json` PUT (ETag, so the Worker makes a backup).
- Formats: comma / semicolon / tab (auto-detected), quoted cells, decimal comma or dot (auto or fixed), dates
  `2024-03-05`, `20240305`, `2024-03-05, 10:30:00`, and d.m.y / m/d/y / y-m-d with a chosen order (2-digit years = 20xx).
- Steps: (1) file + preset + format; (2) column mapping (date, type, ticker, ISIN, name, quantity, price, currency, fees,
  withheld tax, amount, account, destination account, note), type values → transaction type or „ignoră”, account values
  → app account, default account/currency, optional "type from quantity sign"; (3) unknown instruments proposed for
  creation (name, ticker, ISIN, class, region, currency, price source; class/region are only a suggestion);
  (4) preview: new / duplicate / error (with the reason) / skipped (subtotal or „ignoră” rows).
- Duplicate = same account, instrument, date, type, quantity, price and amount as an existing transaction, matched
  one-to-one (two identical fills stay two rows). Duplicates are unticked by default; errors can't be imported.
- Presets are saved in `data.json` `importPresets` (validated in `validate.ts`). Built-in presets, both shown as
  **„neverificat pe un fișier real”** until George confirms on a real file (then set `verified: true` in `BUILTIN_PRESETS`):
  - this app's own CSV export (round-trip covered by a unit test);
  - Interactive Brokers Flex Query, section **Trades**, CSV: columns `ClientAccountID, TradeDate, Symbol, Description,
    ISIN, CurrencyPrimary, Buy/Sell, Quantity, TradePrice, IBCommission`; date `yyyyMMdd` or ISO; commission negative → absolute
    value; the commission currency (`IBCommissionCurrency`) is assumed equal to the trade currency. Dividends/withholding
    tax are in other Flex sections (Cash Transactions) and are not covered by this preset.
- Currencies outside EUR/RON/USD/GBP/CHF are reported as errors (types.ts `CURRENCIES`). Transfers need a destination account column.

## Avere netă
- Page `/vault/invest/avere/` (nav „Avere netă”) and a compact card on the dashboard (`src/scripts/invest/networth-card.ts`).
- **Portfolio is never re-entered**: one item per portfolio account from `computeLedger` + `valuePortfolio` on that date (positions at market price, else face value, else cost; tracked cash; Pillar 2/3 manual values). Categories: `investments`, `pension` (Pillar 2/3), `cash` (accounts of type `cash`).
- **Other assets and debts** in `data.json` → optional `netWorth` (`NetWorthDoc`): `assets[]` (category `cash | savings | real_estate | vehicle | other`, currency, optional `liquid` / `emergency` flags, `values[]` dated) and `liabilities[]` (kind `mortgage | loan | credit_card | other`, currency, yearly `rate` decimal, `monthlyPayment`, `balances[]` dated), plus `monthlyExpenses` (EUR). A dated value stays valid until the next one; 0 = sold / paid off.
- **Liquid**: portfolio except Pillar 2/3, plus cash and savings by default (the flag overrides). **Emergency fund**: assets flagged „Fond de urgență” (default: cash and savings) plus the portfolio accounts chosen in the IPS rule (`activeIpsRules().rules.emergencyFund.accountIds`). Months = that money / monthly expenses; expenses = the page value, else the IPS rule's `monthlyExpenses`; target months from the IPS rule (the IPS dashboard alert is unchanged and still uses only its own accounts).
- **Debt / assets** = liabilities ÷ gross assets. Debts table also shows interest per month (yearly rate / 12) and an estimated payoff (annuity, fixed rate, no prepayments).
- **Over time**: month-ends from the first recorded date (transaction, Pillar 2/3 value, asset value or debt balance) to today, thinned above 180 points; stacked area per category with debts below zero and the net line; EUR/RON toggle. Market years loaded: every year from the first date to now. Positions without a price on a past date are valued at cost (counted in a warning).
- **For the yearly reports (Phase 7)**: `netWorthAt(data, { fx, prices, emergencyAccountIds }, 'YYYY-12-31')` in `src/lib/invest/networth.ts` returns totals in EUR and RON, per category, liquid/illiquid, emergency money, debt ratio and missing FX.
- Files: logic `src/lib/invest/networth.ts` (+ tests), types/validator additive (`NetWorthDoc` in `types.ts`, `netWorth` in `validate.ts`), labels in `labels.ts`, UI `src/pages/vault/invest/avere.astro`, `src/scripts/invest/networth.ts`, `src/styles/invest-networth.css`. No values are pre-filled.

## Pensie & retragere (faza 5)
Page `/vault/invest/pensie/` (`src/pages/vault/invest/pensie.astro`, `src/scripts/invest/retire.ts`, `src/styles/invest-retire.css`),
logic `src/lib/invest/withdrawal.ts` (tests: `withdrawal.test.ts`).
- Inputs from the plan (no re-entry): age, years to invest, contributions, capital, spending, SWR, inflation, plan-to age, class
  assumptions, correlation, Monte Carlo mode/runs/seed and historical data — all from `settings` / `settings.projection`.
  The page only edits `settings.retirement` (`RetirementSettings` in `types.ts`, validated in `validate.ts`) and saves with „Salvează” (ETag, backup).
- Simulation: `runRetirement()` reuses `montecarlo.ts` (`mulberry32`, `gaussian`, `percentile`, `lognormalParams`, `historyYearReturn`)
  and `projection.ts` (`grow`, `contributionInYear`, `portfolioStats`); it runs in the shared `mc.worker.ts` (message kind `retire`).
  With no glidepath it reproduces the plan's Monte Carlo exactly (unit test). All four strategies run on the same simulated
  markets (common random numbers). Real terms, withdrawal at the start of each year.
- Strategies: constant (spending − other income, or SWR × balance at retirement, chosen with „Prima retragere”);
  Guyton-Klinger (2006 defaults: ±20% guardrails, 10% cut/raise, no cuts in the last 15 years; skip the inflation raise after a
  losing year when the rate is above the initial one); VPW (annuity-due rate on the years left, return = expected return of the
  allocation at that age or a fixed one); floor and ceiling (initial rate × balance, kept between floor and ceiling × first withdrawal;
  85% / 125% are placeholders labelled „implicit”).
- Glidepath: points `{ age, weights }`, linear between points, flat outside; none = today's target allocation. Each simulated year
  draws its return for that age's allocation (normal: lognormal per year; bootstrap: one historical year, weighted by that age's allocation).
- Other income (`incomes`): Pillar 2, Pillar 3, state pension, other — NET real EUR per year, start age, optional end age (inclusive).
  Not taxed again. In „spending” mode they reduce what the portfolio pays.
- Outputs: balance p10/p50/p90 (Guyton-Klinger also shows the balance levels where the median withdrawal hits the cut/raise
  guardrails), income per year p10/p50/p90 + median net after tax + spending line, probability of running out (and median age),
  share of runs with at least one year below the spending need, median and p10 bequest, comparison table of all strategies.
- Tax: the median withdrawal of each year goes through `estimateWithdrawal` with the current year's rule set (`rulesFor`), today's
  thresholds, `gainShare` (default 100% = prudent, labelled) and the latest BNR EUR rate (or a manual one). A warning lists
  unconfirmed or missing parameters and when another year's rules are used.
- IPS: the `withdrawal` section text of the IPS in force (`activeIpsRules(doc)?.version`, else `latestIpsVersion`) is shown under the
  results. `IpsRules` has no machine-checkable withdrawal rule, so it is text only.
- Not modelled: tax on Pillar 2/3 and state pension (entered net), CASS on pensions, future changes of thresholds,
  the order of withdrawals across accounts.

## Verificare (pentru fiecare fază)
- `npm run check`, `npm run build`, `npx vitest run` verzi; CI verde (inclusiv garda anti-inline și Lighthouse).
- `npm run preview` cu `.dev.vars` `DEV_EMAIL` = proprietar → paginile merg; cu alt email → 404. Fără erori CSP în consolă.
- Testat pe lățime de telefon și în dark mode (browser pane).
- După merge: `/version.json` arată commit-ul; `/vault/invest/` deschis de pe telefon; Madalina (editor) primește 404.
