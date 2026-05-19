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

## Options

- `--url`: Google Maps URL. Required unless `GOOGLE_MAPS_URL` is set.
- `--range`: `six-months` or `all`. Default: `six-months`.
- `--months`: month window for `six-months`. Default: `6`.
- `--max-scrolls`: safety limit for scrolling the review feed. Default: `120`.
- `--output-dir`: output directory. Default: `output`.
- `--locale`: browser locale. Default: `zh-TW`.
- `--headed`: show Chromium while scraping.

## Output

The scraper writes:

- `output/reviews.json`: metadata and structured reviews.
- `output/reviews.csv`: CSV export.
- `output/reviews-page.png`: full-page screenshot for debugging.

Each review includes the author, rating, original date text, parsed date, date confidence, review text, and raw captured text.

## GitHub Actions

Open the `Scrape Google Reviews` workflow, click `Run workflow`, then enter:

- `google_maps_url`: target Google Maps URL.
- `range`: `six-months` or `all`.
- `months`: month window when using `six-months`.
- `max_scrolls`: maximum scroll attempts.

After the workflow finishes, download the `google-reviews-output` artifact.
