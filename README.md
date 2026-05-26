# google-review-scraper

Google Maps review scraper built with Playwright. Give it a Google Maps URL and choose how many recent months of reviews to collect.

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

Customize the recent review window:

```bash
npm run scrape -- --url "https://maps.app.goo.gl/GgtVZdgwUUT2af6o9" --months 3
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
- `--months`: recent-review window in months. Default: `6`.
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
- `--debug-artifacts`: also write `reviews.csv` and `reviews-page.png` on success.
- `--headed`: show Chromium while scraping.

## Output

The scraper writes:

- `output/reviews.json`: metadata and structured reviews.

With `--debug-artifacts`, it also writes:

- `output/reviews.csv`: CSV export.
- `output/reviews-page.png`: full-page screenshot for debugging successful runs.

On failures, it still writes `failure-page.png` and `failure-page.html` when possible so browser/session issues can be diagnosed.

Each review includes the author, rating, original date text, parsed date, date confidence, review text, and `likeCount` when a visible like count can be parsed.

`reviews.json` also includes a `metadata.summary` object with count, average rating, rating counts, and low-score review count.

## Local Web App

Run a local browser UI for creating review JSON files:

```bash
npm run web
```

Open `http://localhost:3000`, paste a Google Maps place URL, and start a job. Results are written under `jobs/<jobId>` and can be downloaded from the page as `reviews.json`.

The web app uses the scraper with `--headless-compat --fast`, `zh-TW`, `Asia/Taipei`, and the local `./chrome-profile` by default.

## MCP Server

Run a Streamable HTTP MCP server so ChatGPT or another MCP client can call the scraper directly:

```bash
MCP_SHARED_SECRET="replace-with-a-long-random-secret" npm run mcp
```

The server listens on `http://127.0.0.1:8787/mcp` by default. It exposes one prompt and five tools.

Prompt:

- `google_maps_review_analysis_zh_tw`: Traditional Chinese Google Maps review analysis prompt for restaurants, hotels, attractions, shops, services, and other places. It defaults to the most recent 8 months and formats the answer with low-score ratio, key negative reasons, positives, risks, and conclusion. For large review sets, the prompt instructs clients to consume reviews in batches, keep representative evidence per batch, and merge newer and older batches into one final report.

Tools:

- `start_google_reviews_scrape`: starts a background scrape and returns a `jobId`. It does not return reviews. If the same `url`/`months`/`maxScrolls` job is already queued, running, or recently finished, it returns the existing `jobId` instead of starting a duplicate.
- `get_google_reviews_scrape_status`: polls a `jobId` without returning the full `reviews` array. Use this for large places to avoid oversized MCP responses. When it returns `done`, it includes `metadata`, compact `summary`, and a recommended batch plan.
- `get_google_reviews_batch`: returns bounded review batches after a job is done. Use `order: "oldest-first"` and `batchSize: 200` for historical-to-recent analysis, then merge batch notes into a final report weighted toward newer reviews.
- `get_google_reviews_scrape_result`: legacy/full result polling. When it returns `done`, it includes `metadata`, `reviews`, and a compact `summary`. For large places, prefer `get_google_reviews_scrape_status` plus `get_google_reviews_batch` instead of this full-result tool.
- `get_google_maps_review_analysis_prompt`: returns the same Traditional Chinese analysis template as a tool for MCP clients that do not expose MCP prompt listing or prompt retrieval.

The MCP tools always use the recent-months window, so `months` is the only time-range control. The default is `months: 8` and `maxScrolls: 120`. Large places can take several minutes in the background.

Authentication:

- Preferred: send `Authorization: Bearer <MCP_SHARED_SECRET>` to `/mcp`.
- Personal testing fallback: use `/mcp/<MCP_SHARED_SECRET>` if the client cannot send an Authorization header.
- If `MCP_SHARED_SECRET` is not set, the MCP endpoint is unauthenticated. Do not expose it publicly in that mode.

Useful environment variables:

- `MCP_PORT`: MCP server port. Default: `8787`.
- `MCP_HOST`: MCP listen host. Default: `127.0.0.1`.
- `MCP_ALLOWED_HOSTS`: comma-separated hostnames accepted by the MCP SDK host-header guard. Default: `localhost,127.0.0.1,imac.tail716865.ts.net`.
- `MCP_SHARED_SECRET`: shared secret for MCP requests.
- `SCRAPE_TIMEOUT_MS`: scraper timeout per MCP call. Default: `300000` (5 minutes).
- `MCP_KEEP_JOB_FILES`: set to `true` to keep MCP job directories on disk. Default is unset/false, so successful MCP jobs are loaded into memory and their `mcp-jobs/<jobId>` files are deleted.
- `BROWSER_CHANNEL`, `PROFILE_DIR`, `LOCALE`, `TIMEZONE`, `HEADLESS`: forwarded to the scraper.

Expose with Tailscale Funnel for a personal HTTPS endpoint:

```bash
MCP_SHARED_SECRET="replace-with-a-long-random-secret" npm run mcp
tailscale funnel --bg --https=443 http://127.0.0.1:8787
```

Use the resulting Funnel URL as the MCP server URL. Prefer the bearer-token form if the client supports it; otherwise use the long secret path form only for private testing.

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
- `months`: recent-review window in months.
- `max_scrolls`: maximum scroll attempts.

After the workflow finishes, download the `google-reviews-output` artifact.

If Google limits Maps content on GitHub-hosted runners, the workflow will upload `failure-page.png` and `failure-page.html`. In that case, run the scraper locally or on a self-hosted runner with a regular browser session that can view the reviews.

Do not commit your `chrome-profile` directory. It can contain browser session data.
