# Sample responses for `market.test.ts`

Real, public responses saved on 2026-11-27 (no personal data):

- `bnr-daily.xml` — `https://curs.bnr.ro/nbrfxrates.xml`
- `bnr-10days.xml` — `https://curs.bnr.ro/nbrfxrates10days.xml`
- `bnr-year-2024-excerpt.xml` — first three days of `https://curs.bnr.ro/files/xml/years/nbrfxrates2024.xml`
- `yahoo-<symbol>.json` — `https://query1.finance.yahoo.com/v8/finance/chart/<symbol>?range=10d&interval=1d`
  (VWCE.DE = Xetra/EUR, VWRL.L = LSE/GBP, VOD.L = LSE/GBp pence, AAPL = Nasdaq/USD, TLV.RO = BVB/RON)
- `yahoo-notfound.json` — Yahoo's answer for an unknown symbol (HTTP 404)
