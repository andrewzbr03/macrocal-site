# MacroCal — ES/NQ Macro Calendar

A free-hostable, focused U.S. macro calendar built around the exact ES/NQ event list and report sub-metrics defined in `Trading.docx`.

## What this version does

- Keeps a strict whitelist of the approved U.S. ES/NQ events only.
- Searches the live FinanceCalendar feed hourly while the site is open.
- Searches backward and forward in 180-day windows until the provider stops returning relevant published occurrences (with only an internal safety guard against infinite loops).
- Keeps the verified Sep–Oct 2026 schedule as a fallback when the live feed omits a known U.S. event.
- Shows all approved sub-metrics when an event is clicked, even when the free feed does not supply a value for every sub-metric.
- Gives every sub-metric **both** its approved Investing.com link (when one exists) and the official primary-source link for that exact report/metric.
- Shows Previous / Forecast / Actual where available.
- Calculates Surprise vs Forecast as `Actual - Forecast` once both are available.
- Preserves an observed original Previous value when a later hourly sync changes it, and displays the revision as `was X` underneath the revised Previous value.
- Stores historical and future event data in browser local storage so a temporary feed outage does not erase the archive.
- Shows a compact **Other relevant events** section inside each event. It includes:
  - other approved calendar events at the exact same release time; and
  - only strictly filtered high-impact U.S. scheduled catalysts outside the main whitelist (for example select Fed events, industrial production, trade balance, or housing releases).
- The extra-context section refreshes hourly with the rest of the site and is also stored for historical dates, so old releases can show the relevant scheduled context captured by the feed.
- FOMC Minutes and the Fed press conference are treated as non-numeric events rather than given fake Previous / Forecast / Actual fields.
- ADP Pay Insights (job-stayers and job-changers) are displayed without a fabricated consensus forecast.
- Exports the visible approved calendar as an `.ics` file.

## Data-source behavior and limitations

The live schedule source is FinanceCalendar's free public API. It requires no API key and is designed to update at most hourly. A visible FinanceCalendar attribution remains in the site because their terms require attribution.

Each metric now exposes multiple references: Investing.com for the calendar-style Previous / Forecast / Actual view and the official primary source (BLS, BEA, Census, ISM, University of Michigan, Conference Board, ADP, Department of Labor, or Federal Reserve) for verification. The site does **not** scrape Investing.com directly because browser-side scraping is unreliable and can be blocked; automated fields are still populated from machine-readable calendar data when available, while official and Investing links are shown side by side for verification.

A dash (`—`) in a historical field means the free synced feed did not provide that specific field. The site deliberately does not invent consensus forecasts or revision history. Revision indicators appear when revision data is supplied by the feed or when MacroCal observes a Previous value change across syncs.

The **Other relevant events** area is intentionally low-noise. It is based on scheduled events present in the synced calendar feed. It does not claim to reconstruct unscheduled geopolitical headlines, surprise corporate news, or every historical market catalyst.

## Free hosting

The static site works without a paid service. It can be deployed on Cloudflare Pages. The included `/functions/api/filter.js` is optional and uses Cloudflare Workers AI when configured; the local smart filter works without it.

## Files

- `index.html` — layout
- `styles.css` — styling
- `app.js` — schedule sync, strict whitelist, historical archive, metric templates, surprise/revision logic, context events, filters and export
- `functions/api/filter.js` — optional Cloudflare AI natural-language filter
- `wrangler.jsonc` — Cloudflare configuration

## V7 data-integrity fixes

- History/future discovery no longer stops after a fixed ~3-year chunk count. It scans 180-day windows until the provider returns three consecutive empty relevant windows. An internal emergency loop guard exists only to prevent an infinite loop if an upstream API misbehaves.
- Multi-part reports (CPI, PCE, PPI, Michigan, ISM, NFP, Retail Sales, Durable Goods, ADP) no longer assign a generic family-level value to a specific sub-metric. If the source does not identify the component, the row remains blank rather than guessing.
- The "Other relevant events" ingestion now uses the narrow relevance list for non-calendar items. Same-time approved releases are all shown; same-day non-calendar extras are limited to two high-impact items.
- Housing Starts and Building Permits open as one combined detail report when both are present at the same timestamp.
- FOMC Minutes resolve to the specific prior FOMC decision date and construct the Federal Reserve's meeting-specific minutes PDF URL when possible.
- Approved source links were aligned to the URLs in Trading.docx where they differed.
- Historical revisions continue to be preserved when the upstream feed exposes an original/revised value or when the app observes a previous-value change across syncs. The free upstream source does not guarantee point-in-time revision history for every old release, so missing historical revisions are left blank rather than fabricated.
- Historical consensus forecasts/actuals are displayed whenever supplied by the free feed. Official agencies generally do not publish historical economist consensus forecasts; therefore the app cannot guarantee a complete old forecast archive without a dedicated point-in-time calendar data provider. Missing values stay blank with direct approved source links for verification.


## V8 multi-source references

- Every metric row now has separate **Investing** and **Official** buttons where applicable.
- PCE Core MoM / Core YoY link to BEA's Core PCE page; Headline MoM / Headline YoY link to BEA's headline PCE page.
- CPI rows link to BLS CPI; PPI rows to BLS PPI; NFP/unemployment/wages to the BLS Employment Situation; JOLTS to BLS JOLTS; ECI to BLS ECI; Initial Claims to U.S. Department of Labor; Durable Goods/Retail/Housing to Census; ISM components to ISM; Consumer Confidence to The Conference Board; Michigan components to the University of Michigan; ADP metrics to ADP; GDP/PCE to BEA; and FOMC events to the Federal Reserve.
- FOMC Minutes and press conferences also show both an Investing.com reference and the official Federal Reserve source.

## V9 history-source fix

- Fixed the historical/future scan window from 180 days to 90 days. FinanceCalendar documents a maximum 92-day range per `/calendar` request, so the prior 180-day requests could fail or return incomplete coverage.
- The site continues scanning consecutive 90-day windows backward and forward until the source stops returning relevant approved U.S. events, subject only to the emergency loop guard.
- Investing.com remains linked on every applicable metric for its Previous / Forecast / Actual history view, and the official agency link remains beside it for verification. Investing.com is not scraped or copied into the app; its terms prohibit storing/reproducing site data without permission.
- Machine-readable history remains sourced from FinanceCalendar because its API is explicitly free for browser/app use with attribution. Official agencies remain the verification source for the underlying releases.

## History split (V8)

MacroCal now deliberately uses two different history paths:

- **Future + captured archive (Sep 23, 2026 forward):** FinanceCalendar supplies published future occurrences and machine-readable values. Once an occurrence is captured, it remains in browser `localStorage` after it becomes a past event. On reopen, the app performs a catch-up sync before scanning future dates again.
- **Older history (before Sep 23, 2026):** the app embeds Investing.com's official Economic Calendar widget, filtered to the United States and medium/high importance, with Actual / Forecast / Previous columns and the widget's own date picker/filter controls. Older Investing.com rows are displayed directly in the iframe and are not copied into MacroCal storage.

This split avoids treating FinanceCalendar as a complete multi-year historical database while still allowing the custom archive to become more useful over time.

### Storage note
The captured archive is stored in the browser's localStorage for the site's origin. Hosting the site at a stable URL is more reliable than opening `index.html` through `file://`. Clearing site/browser storage removes the locally accumulated archive.


## Historical archive

This build contains a built-in historical archive transcribed from the verified Previous / Forecast / Actual values collected in the ChatGPT conversation that produced this site. It includes the available historical rows for CPI, PPI, PCE, NFP/jobs, JOLTS, ADP, Consumer Confidence, Durable Goods, Retail Sales, GDP, ISM Manufacturing, ISM Services, Michigan sentiment, Housing Starts, Building Permits, ECI, Initial Jobless Claims, and the listed 2026 FOMC dates.

FinanceCalendar is used for future/live events from Sep. 23, 2026 onward. As those events pass, the site keeps them in the same Previous Occurrences archive.

## Public shared-history deployment (GitHub Pages)

This build can run as a completely free public site using GitHub Pages.

- `.github/workflows/update-data.yml` runs hourly and updates `data/shared-feed.json` from FinanceCalendar.
- The updater never deletes older stored rows, so releases captured after Sep. 23, 2026 become a shared history for every visitor.
- It also retains selected market-impact headlines in `data/market-headlines.json` when the headline itself explicitly reports a move in stocks, Nasdaq/S&P, futures, Treasury yields, or the dollar.
- `.github/workflows/deploy-pages.yml` publishes the same files to GitHub Pages after updates.
- The main calendar remains the strict ES/NQ whitelist. Broader releases, Fed events, selected global catalysts, and market-impact headlines appear only inside an event's **Other relevant market events** section.

The built-in historical dataset remains available even before the first scheduled update runs.


## V13 related-market-context fix

- Related scheduled catalysts now span the selected event date plus the previous and next day.
- Approved MacroCal releases, material U.S. releases/Fed events, Treasury auctions/refunding, and selected major global catalysts can appear.
- Context items are labeled Same time, Same day, Previous day, or Next day.
- Market-impact headlines remain retrospective: they appear only after a stored headline explicitly reports a move in stocks, Nasdaq/S&P, futures, Treasury yields, or the dollar.


## V14 macro/geopolitical headline context

- Retains trusted-source headlines for major geopolitical and macro catalysts even when the title does not explicitly say markets moved.
- Examples include ceasefire/peace-deal breakdowns or escalation involving Iran/Middle East and other major conflicts, oil/OPEC/Strait of Hormuz supply disruptions, tariffs/sanctions/export controls, government shutdown/debt-ceiling risk, and major banking/credit stress.
- Explicit market-reaction headlines keep the `Market move` label. Catalyst-only headlines are labeled by theme such as `Geopolitical`, `Oil / Supply`, `Trade / Sanctions`, `Fiscal risk`, or `Financial stress`. These labels indicate potential market relevance, not proven causation.


## V15 independent market context

- `Relevant market context` is now independent of the main economic-calendar whitelist.
- Upcoming events show recent external macro/geopolitical/oil/trade/fiscal/financial-stress headlines from the last 7 days even when those headlines have no calendar event ID or matching release date.
- Historical events continue to use captured headlines around the release date for backtesting.
- Scheduled releases remain secondary context rather than the primary source of related items.
- The updater uses GDELT when available and a Google News RSS search as a fallback so a GDELT outage does not leave the context feed empty.
