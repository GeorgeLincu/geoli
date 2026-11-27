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
- [ ] 1 Plan & proiecție
- [x] 2 Portofoliu — `/vault/invest/portofoliu/`: CRUD conturi/instrumente/tranzacții, `ledger.ts` (cost mediu ponderat, art. 97 alin. (8^2) Cod fiscal), `portfolio.ts` (evaluare, drift, rebalansare prin contribuții, scadențe), `fx.ts`/`prices.ts` (manual, interfață pentru Faza 3), Pilon 2/3 manual, export CSV
- [ ] 3 Prețuri & cursuri
- [ ] 4 Taxe RO
- [ ] 5 Pensie & retragere
- [ ] 6 IPS
- [ ] 7 Rapoarte anuale & Panou
- [ ] 8 Întărire

Prompt-urile pentru fiecare fază: [PROMPTS.md](PROMPTS.md).

## Verificare (pentru fiecare fază)
- `npm run check`, `npm run build`, `npx vitest run` verzi; CI verde (inclusiv garda anti-inline și Lighthouse).
- `npm run preview` cu `.dev.vars` `DEV_EMAIL` = proprietar → paginile merg; cu alt email → 404. Fără erori CSP în consolă.
- Testat pe lățime de telefon și în dark mode (browser pane).
- După merge: `/version.json` arată commit-ul; `/vault/invest/` deschis de pe telefon; Madalina (editor) primește 404.
