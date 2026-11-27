# Investiții — prompt-uri pe faze

Planul: [PLAN.md](PLAN.md). Lipește câte un prompt într-o sesiune nouă Claude Code (folderul geoli-website), înlocuind `[Antet comun]` cu textul antetului de mai jos.

## PROMPT-URI
Fiecare prompt începe cu același antet comun:

> **Antet comun (pus la începutul fiecărui prompt):**
> Read `CLAUDE.md`, `docs/STATUS.md` and `docs/invest/PLAN.md` first. Work in a new git worktree on a new branch, open a PR,
> never push to `main`. The investment section lives at `/vault/invest/` and `/vault/api/invest/`, is owner-only
> (`INVEST_EMAILS`), UI in Romanian (ro-RO number/date formats), code and docs in English. No inline script/style;
> charts with self-hosted Apache ECharts. Pure calculation logic goes in `src/lib/invest/` with vitest tests.
> Never invent numbers, holdings, tax values or IPS text: tax parameters must carry a source URL and "verified on" date
> and be confirmed by George; IPS text is written by George. Before finishing: `npm run check`, `npm run build`,
> `npx vitest run`, test with `npm run preview` in the browser pane (owner email and a non-owner email, mobile width,
> dark mode, no CSP errors), update `docs/STATUS.md` and `docs/invest/PLAN.md` (mark the phase done), then give me
> click-by-click steps for anything I must do myself. Talk to me in Romanian.

### Prompt 0 — Fundație
```
[Antet comun]
Phase 0 — foundation for the private investment section.
1. wrangler.jsonc: add var INVEST_EMAILS="george.lincu@gmail.com". worker/: owner gate for /vault/invest* and
   /vault/api/invest/* (non-owner → 404, same as unknown path). Serve /vault/invest/* pages via env.ASSETS.fetch AFTER
   the gate, overriding headers with the vault baseHeaders (private, no-store, noindex) and a CSP that allows only 'self'.
2. Hide the R2 prefix invest/ from the Files view and from canRead for everyone (it's only reachable via the invest API).
3. API (worker/invest.ts): GET/PUT /vault/api/invest/data (invest/data.json) with ETag optimistic concurrency
   (412 on conflict), JSON schema validation, size limit, and a backup copy invest/backups/<ISO>.json on every PUT
   (keep the newest 50). Same pattern for tax-rules.json and ips.json. Same-origin check is already in handleVault.
4. Astro: src/layouts/Invest.astro (noindex, no JSON-LD, not in sitemap), src/pages/vault/invest/index.astro with
   Romanian nav for the future pages (Panou, Portofoliu, Plan, Pensie, Taxe, IPS, Rapoarte), src/styles/invest.css
   reusing the site's colour tokens and light/dark theme, src/scripts/invest/ for client code (fetch data, save, errors).
5. Add echarts (tree-shaken import, canvas renderer) and a shared chart helper that reads theme colours from CSS
   variables and re-renders on theme change; prove it with one placeholder chart and check the console has no CSP errors.
6. Hidden shortcut: in src/scripts/site.ts add a keydown sequence g then i (ignore when typing in inputs/textareas,
   1.5 s window) that navigates to /vault/invest/. Nothing visible on public pages.
7. Add vitest (dev dependency), a first test, and run it in .github/workflows/ci.yml.
8. Define TypeScript types in src/lib/invest/types.ts for: Settings, Account (type: foreign_broker | ro_broker |
   gov_bonds | pillar2 | pillar3 | cash), Instrument (ticker, ISIN, name, assetClass, region, currency,
   accumulating/distributing, priceSource), Transaction (buy|sell|dividend|interest|fee|deposit|withdrawal|transfer,
   date, qty, price, currency, fees, withheldTax, accountId), TargetAllocation, Scenario, Snapshot, TaxRuleSet (per year).
```

### Prompt 1 — Plan & proiecție
```
[Antet comun]
Phase 1 — planning and projections page (/vault/invest/plan/). Use C:\Users\george.lincu\Downloads\plan.html only as
reference for the maths and inputs, not for layout. Inputs (all saved to data.json): current age, invested capital
(from the ledger when available, else manual), monthly contribution, annual change of contribution in % (real),
years to invest, desired annual spending in retirement (today's money), SWR, expected inflation, expected real return
and volatility per asset class, weights from the target allocation.
Logic in src/lib/invest/projection.ts and montecarlo.ts (tests!): yearly deterministic projection in real terms with
nominal shown alongside; FI number = spending / SWR; Coast FI; years to FI; Monte Carlo (≥2000 runs, seeded RNG,
normal and historical-bootstrap modes, run in a Web Worker so the UI stays smooth) with success probability,
p10/p50/p90, sequence-of-returns view. Saved scenarios (name + inputs) and side-by-side comparison.
Sensitivity (tornado): which input moves the FI age most.
Charts: projection area (contributions vs growth) with FI line; Monte Carlo fan; tornado; scenario comparison.
Sliders + number inputs, Romanian labels, live recalculation, mobile-friendly.
```

### Prompt 2 — Portofoliu
```
[Antet comun]
Phase 2 — portfolio ledger (/vault/invest/portofoliu/). CRUD for accounts, instruments and transactions (types from
src/lib/invest/types.ts). src/lib/invest/ledger.ts (tests!): positions per account/instrument, weighted-average cost
(the Romanian method — confirm in the PR description with a source), realized gains per sale in the transaction
currency and in RON, dividends and withheld tax, cash balances. Government bonds (Tezaur/Fidelis): face value,
coupon, maturity → maturity-ladder timeline. Pillar 2/3: manual value entries over time.
Values in EUR and RON using fx (manual rates until Phase 3 lands). Target allocation editor (asset class → region →
instrument) with drift bands; "rebalance with contributions" calculator: given this month's contribution, how much
to buy of each instrument to move toward MY target without selling. Charts: allocation sunburst, actual vs target with
bands, maturity ladder. CSV export of transactions. Do not pre-fill any holdings: I will enter my own data.
```

### Prompt 3 — Prețuri & cursuri
```
[Antet comun]
Phase 3 — automatic prices and FX. Add a Cron Trigger in wrangler.jsonc (weekdays, after European close) and a
scheduled() handler. FX: BNR daily XML (EUR, USD → RON) into invest/fx/<year>.json; one-off backfill from BNR's yearly
XML files for the years that have transactions. Prices: research free sources for my instrument types (UCITS ETFs on
Xetra/LSE, US stocks, BVB shares/ETFs), test each from the Worker, pick the most reliable per exchange, document the
choice and its limits in docs/invest/PLAN.md. Send only tickers, nothing personal. Store invest/prices/<year>.json;
on failure keep the last price and show a "preț vechi din <data>" warning. Manual price override per instrument and
date. Button "Actualizează acum" (owner only, rate-limited). Show last-update time on the dashboard.
```

### Prompt 4 — Taxe România
```
[Antet comun]
Phase 4 — Romanian tax engine (/vault/invest/taxe/). Research the CURRENT rules for a Romanian tax resident and list
each value with its official source (Codul fiscal, ANAF, legea care l-a modificat) and date, then ASK ME to confirm
before saving: capital-gains tax via foreign brokers; tax withheld by Romanian brokers (by holding period);
dividend tax (RO and foreign, foreign-tax credit, W-8BEN 15% US); interest on Tezaur/Fidelis; CASS (rate, thresholds
as multiples of the minimum gross wage, which incomes count); minimum gross wage per year; CAS; loss carry-forward
rules; Pillar 3 deduction; FX rule for converting foreign transactions to RON; Declarația Unică deadline.
Store everything in tax-rules.json versioned per year, every value editable in the UI (future changes = new year
entry, old years stay intact). src/lib/invest/tax-ro.ts (tests with worked examples): per tax year, realized
gains/losses by category and broker type, dividends, interest, CASS tier, total tax, effective rate, and an
estimate for planned sales and for retirement withdrawals (feeds Phase 5).
"Fișă Declarația Unică": printable per-year summary of the amounts per section, in RON, with the BNR rates used.
It is a helper, not tax advice; say so on the page.
```

### Prompt 5 — Pensie & retragere
```
[Antet comun]
Phase 5 — retirement and withdrawals (/vault/invest/pensie/). src/lib/invest/withdrawal.ts (tests): constant SWR
(inflation-adjusted), Guyton-Klinger guardrails, VPW, and a simple floor-and-ceiling rule; all run through the Phase 1
Monte Carlo. Glidepath / bond tent editor (allocation by age) and its chart. Optional inputs: Pillar 2 and 3 payouts,
state pension estimate (I enter it), other income. Net withdrawal income after Romanian tax using tax-ro.ts.
Outputs: portfolio balance during retirement with p10/p50/p90, income per year in real terms, probability of
running out, median bequest. Charts: balance with guardrail bands, income line, glidepath stacked area.
```

### Prompt 6 — IPS
```
[Antet comun]
Phase 6 — Investment Policy Statement (/vault/invest/ips/). Structured editor with sections as headings + guiding
questions only (no pre-written answers): goals, time horizon, risk tolerance and capacity, target allocation and
rebalancing bands (linked to the Phase 2 targets, not duplicated), contribution rules, rebalancing rules,
withdrawal rules (linked to Phase 5), instruments allowed / not allowed, behaviour rules in crashes, emergency fund,
review cadence. Versioned in ips.json (date, change note), diff between versions, print view.
Machine-checkable rules (drift > band, emergency fund below N months, contribution missed, annual review due,
Declarația Unică due) become alerts on the dashboard.
```

### Prompt 7 — Rapoarte anuale & Panou
```
[Antet comun]
Phase 7 — yearly reports and dashboard. Snapshot at 31 Dec (automatic from the ledger + prices, editable) in
invest/snapshots/. src/lib/invest/returns.ts (tests): XIRR, TWR, real return using inflation (I enter yearly CPI or
it is fetched from an official source you document). Report page per year (/vault/invest/rapoarte/<an>/): start and
end value, contributions, market gain, dividends, fees, taxes, XIRR/TWR, real return, allocation vs target, IPS
compliance, FI progress; waterfall chart; monthly-returns heatmap; drawdown chart; print stylesheet for PDF.
Dashboard (/vault/invest/): net worth stacked by asset class over time, FI progress, years to FI, savings rate,
drift, alerts, last price update. Polish all charts for consistency (dataviz skill), light/dark, mobile.
```

### Prompt 8 — Întărire
```
[Antet comun]
Phase 8 — hardening. Full export/import (JSON with all invest/ files; restore from a backup with preview),
"mod discret" toggle that blurs all amounts (remembered per device), stress-test widget (instant −20/−40% shock),
broker CSV import only for formats I provide as real sample files. Run /code-review high and security-review on the
whole invest feature (owner gate, R2 prefix isolation, CSRF, input validation, cache headers, no data in URLs or
logs). Update docs/STATUS.md (section "Investiții") and write docs/invest/USER-GUIDE.md in Romanian with
click-by-click steps for: adding a transaction, yearly report, updating tax parameters, restoring a backup.
```
