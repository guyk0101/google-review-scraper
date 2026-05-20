# google-review-scraper

Google Maps review scraper built with Playwright. Give it a Google Maps URL and choose whether to collect reviews from the most recent six months or all loaded reviews.

> Use this only for data you are allowed to collect. Google Maps pages can change, throttle automation, or require manual adjustments over time.

## Requirements

- Node.js 20+
- Playwright Chromium browser

## Install

```bash
npm install
npm run install:browsers
```

## Usage

Scrape reviews from the most recent six months:

```bash
npm run scrape -- --url "https://maps.app.goo.gl/GgtVZdgwUUT2af6o9"
```

Scrape all reviews that can be loaded before the scroll limit:

```bash
npm run scrape -- --url "https://maps.app.goo.gl/GgtVZdgwUUT2af6o9" --range all
```

Customize the recent review window:

```bash
npm run scrape -- --url "https://maps.app.goo.gl/GgtVZdgwUUT2af6o9" --range six-months --months 3
```

Run with a visible browser for debugging:

```bash
npm run scrape -- --url "https://maps.app.goo.gl/GgtVZdgwUUT2af6o9" --headed
```

Use an installed Chrome or Edge if Playwright's bundled Chromium cannot be downloaded:

```bash
npm run scrape -- --url "https://maps.app.goo.gl/GgtVZdgwUUT2af6o9" --browser-channel chrome
npm run scrape -- --url "https://maps.app.goo.gl/GgtVZdgwUUT2af6o9" --browser-channel msedge
```

Reuse a persistent browser profile so Google login/session state is kept:

```bash
npm run scrape -- --url "https://maps.app.goo.gl/GgtVZdgwUUT2af6o9" --profile-dir ./chrome-profile --headed
```

On the first run, sign in to Google in the opened browser if Maps asks you to. Close the browser after the scraper finishes or after you finish signing in. Future runs can reuse the same profile:

```bash
npm run scrape -- --url "https://maps.app.goo.gl/GgtVZdgwUUT2af6o9" --profile-dir ./chrome-profile
```

Run headless after the profile has been warmed up:

```bash
npm run scrape -- --url "https://maps.app.goo.gl/GgtVZdgwUUT2af6o9" --browser-channel chrome --profile-dir ./chrome-profile --locale zh-TW --timezone Asia/Taipei --headless-compat --fast
```

## Options

- `--url`: Google Maps URL. Required unless `GOOGLE_MAPS_URL` is set.
- `--range`: `six-months` or `all`. Default: `six-months`.
- `--months`: month window for `six-months`. Default: `6`.
- `--max-scrolls`: safety limit for scrolling the review feed. Default: `120`.
- `--output-dir`: output directory. Default: `output`.
- `--review-retries`: reload and retry when reviews are empty or limited. Default: `1`.
- `--page-settle-ms`: wait after page load before opening reviews. Default: `2000`.
- `--wait-networkidle`: wait for network idle after page load/reload. Slower but conservative.
- `--fast`: faster adaptive scrolling preset. Uses shorter page settle time and larger scroll steps.
- `--scroll-delay-ms`: maximum adaptive wait after each review-feed scroll. Default: `2000`.
- `--poll-interval-ms`: adaptive wait polling interval. Default: `100`.
- `--stale-scroll-limit`: stop after this many scrolls with no new reviews. Default: `4`.
- `--scroll-step-multiplier`: review-feed scroll distance multiplier. Default: `1.6`.
- `--locale`: browser locale. Default: `zh-TW`.
- `--timezone`: browser timezone, such as `Asia/Taipei`.
- `--viewport-width`: browser viewport width. Default: `1440`.
- `--viewport-height`: browser viewport height. Default: `1200`.
- `--profile-dir`: persistent Chromium profile directory for login/session state.
- `--browser-channel`: installed browser channel, such as `chrome` or `msedge`.
- `--executable-path`: explicit Chrome/Edge executable path.
- `--user-agent`: override browser user agent.
- `--headless-compat`: reduce common headless/headed JavaScript fingerprint differences.
- `--debug-hold-ms`: keep the browser open for this many milliseconds after an error.
- `--headed`: show Chromium while scraping.

## Output

The scraper writes:

- `output/reviews.json`: metadata and structured reviews.
- `output/reviews.csv`: CSV export.
- `output/reviews-page.png`: full-page screenshot for debugging.

Each review includes the author, rating, original date text, parsed date, date confidence, review text, and raw captured text.

`reviews.json` also includes a `metadata.summary` object with count, average rating, rating counts, and low-score review count.

## Local Web App

Run a local browser UI for creating review JSON files:

```bash
npm run web
```

Open `http://localhost:3000`, paste a Google Maps place URL, and start a job. Results are written under `jobs/<jobId>` and can be downloaded from the page as `reviews.json`.

The web app uses the scraper with `--headless-compat --fast`, `zh-TW`, `Asia/Taipei`, and the local `./chrome-profile` by default.

## Completeness Check

For a no-miss confidence check, run one conservative baseline and one faster candidate, then compare review IDs:

```bash
npm run verify-fast -- --url "https://maps.app.goo.gl/GgtVZdgwUUT2af6o9" --browser-channel chrome --profile-dir ./chrome-profile
```

The verification command writes `output-verify-fast/baseline` and `output-verify-fast/fast`, then exits with code `1` if adaptive fast missed any baseline reviews.

You can also run the steps manually:

```bash
npm run scrape -- --url "https://maps.app.goo.gl/GgtVZdgwUUT2af6o9" --browser-channel chrome --profile-dir ./chrome-profile --output-dir output-baseline --scroll-delay-ms 3000 --stale-scroll-limit 6
npm run scrape -- --url "https://maps.app.goo.gl/GgtVZdgwUUT2af6o9" --browser-channel chrome --profile-dir ./chrome-profile --output-dir output-fast --fast
npm run compare -- output-baseline/reviews.json output-fast/reviews.json
```

If `Missing from candidate` is `0`, the faster run matched the baseline for the loaded review set.

## GitHub Actions

Open the `Scrape Google Reviews` workflow, click `Run workflow`, then enter:

- `google_maps_url`: target Google Maps URL.
- `range`: `six-months` or `all`.
- `months`: month window when using `six-months`.
- `max_scrolls`: maximum scroll attempts.

After the workflow finishes, download the `google-reviews-output` artifact.

If Google limits Maps content on GitHub-hosted runners, the workflow will upload `failure-page.png` and `failure-page.html`. In that case, run the scraper locally or on a self-hosted runner with a regular browser session that can view the reviews.

Do not commit your `chrome-profile` directory. It can contain browser session data.
