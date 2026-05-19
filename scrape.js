const fs = require("fs");
const path = require("path");

const DEFAULT_LOCALE = "zh-TW";
const DEFAULT_RANGE = "six-months";
const DEFAULT_MAX_SCROLLS = 120;
const DEFAULT_OUTPUT_DIR = "output";
const REVIEW_CARD_SELECTOR = 'div[data-review-id], div.jftiEf';

function parseArgs(argv) {
  const options = {
    url: process.env.GOOGLE_MAPS_URL || "",
    range: process.env.REVIEW_RANGE || DEFAULT_RANGE,
    months: Number(process.env.REVIEW_MONTHS || 6),
    maxScrolls: Number(process.env.MAX_SCROLLS || DEFAULT_MAX_SCROLLS),
    outputDir: process.env.OUTPUT_DIR || DEFAULT_OUTPUT_DIR,
    headless: process.env.HEADLESS !== "false",
    locale: process.env.LOCALE || DEFAULT_LOCALE,
    profileDir: process.env.PROFILE_DIR || "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--url" && next) {
      options.url = next;
      i += 1;
    } else if (arg === "--range" && next) {
      options.range = next;
      i += 1;
    } else if (arg === "--months" && next) {
      options.months = Number(next);
      i += 1;
    } else if (arg === "--max-scrolls" && next) {
      options.maxScrolls = Number(next);
      i += 1;
    } else if (arg === "--output-dir" && next) {
      options.outputDir = next;
      i += 1;
    } else if (arg === "--locale" && next) {
      options.locale = next;
      i += 1;
    } else if (arg === "--profile-dir" && next) {
      options.profileDir = next;
      i += 1;
    } else if (arg === "--headed") {
      options.headless = false;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  if (!options.url) {
    throw new Error("Missing --url. Example: node scrape.js --url https://maps.app.goo.gl/GgtVZdgwUUT2af6o9");
  }

  if (!["six-months", "all"].includes(options.range)) {
    throw new Error('--range must be "six-months" or "all"');
  }

  if (!Number.isFinite(options.months) || options.months <= 0) {
    throw new Error("--months must be a positive number");
  }

  if (!Number.isFinite(options.maxScrolls) || options.maxScrolls <= 0) {
    throw new Error("--max-scrolls must be a positive number");
  }

  return options;
}

function printHelp() {
  console.log(`
Usage:
  node scrape.js --url <google-maps-url> [options]

Options:
  --range six-months|all    Scrape recent months or every review. Default: six-months
  --months <number>         Month window for --range six-months. Default: 6
  --max-scrolls <number>    Safety limit for review-feed scrolling. Default: 120
  --output-dir <path>       Directory for reviews.json, reviews.csv, and screenshot
  --locale <locale>         Browser locale. Default: zh-TW
  --profile-dir <path>      Reuse a persistent Chromium profile for login/session state
  --headed                  Show Chromium while scraping
`);
}

async function launchBrowser(chromium, options) {
  const browserOptions = {
    headless: options.headless,
    locale: options.locale,
    viewport: { width: 1440, height: 1200 },
  };

  if (options.profileDir) {
    const profileDir = path.resolve(options.profileDir);
    fs.mkdirSync(profileDir, { recursive: true });
    console.log(`Using persistent profile: ${profileDir}`);

    const context = await chromium.launchPersistentContext(profileDir, browserOptions);
    const pages = context.pages();
    const page = pages[0] || (await context.newPage());

    return {
      page,
      close: () => context.close(),
    };
  }

  const browser = await chromium.launch({ headless: options.headless });
  const page = await browser.newPage({
    locale: options.locale,
    viewport: { width: 1440, height: 1200 },
  });

  return {
    page,
    close: () => browser.close(),
  };
}

function subtractMonths(date, months) {
  const result = new Date(date);
  result.setMonth(result.getMonth() - months);
  return result;
}

function parseReviewDate(rawDate, now = new Date()) {
  if (!rawDate) {
    return { date: null, confidence: "none" };
  }

  const value = rawDate.trim();
  const normalized = value
    .replace(/^更新於\s*/u, "")
    .replace(/^Edited\s*/iu, "")
    .replace(/^已編輯\s*/u, "")
    .trim();

  const absoluteZh = normalized.match(/(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?/u);
  if (absoluteZh) {
    return {
      date: new Date(Number(absoluteZh[1]), Number(absoluteZh[2]) - 1, Number(absoluteZh[3] || 1)),
      confidence: absoluteZh[3] ? "day" : "month",
    };
  }

  const absoluteSlash = normalized.match(/(\d{4})[/-](\d{1,2})(?:[/-](\d{1,2}))?/u);
  if (absoluteSlash) {
    return {
      date: new Date(Number(absoluteSlash[1]), Number(absoluteSlash[2]) - 1, Number(absoluteSlash[3] || 1)),
      confidence: absoluteSlash[3] ? "day" : "month",
    };
  }

  if (/今天|今日|just now|today/i.test(normalized)) {
    return { date: new Date(now), confidence: "day" };
  }

  if (/昨天|yesterday/i.test(normalized)) {
    const date = new Date(now);
    date.setDate(date.getDate() - 1);
    return { date, confidence: "day" };
  }

  const zhRelative = normalized.match(/(\d+)\s*(秒|分鐘|小時|天|週|星期|個月|月|年)前/u);
  if (zhRelative) {
    return relativeDate(Number(zhRelative[1]), zhRelative[2], now);
  }

  const enRelative = normalized.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/i);
  if (enRelative) {
    return relativeDate(Number(enRelative[1]), enRelative[2].toLowerCase(), now);
  }

  return { date: null, confidence: "unknown" };
}

function relativeDate(amount, unit, now) {
  const date = new Date(now);

  if (["秒", "second"].includes(unit)) {
    date.setSeconds(date.getSeconds() - amount);
    return { date, confidence: "day" };
  }

  if (["分鐘", "minute"].includes(unit)) {
    date.setMinutes(date.getMinutes() - amount);
    return { date, confidence: "day" };
  }

  if (["小時", "hour"].includes(unit)) {
    date.setHours(date.getHours() - amount);
    return { date, confidence: "day" };
  }

  if (["天", "day"].includes(unit)) {
    date.setDate(date.getDate() - amount);
    return { date, confidence: "day" };
  }

  if (["週", "星期", "week"].includes(unit)) {
    date.setDate(date.getDate() - amount * 7);
    return { date, confidence: "week" };
  }

  if (["個月", "月", "month"].includes(unit)) {
    date.setMonth(date.getMonth() - amount);
    return { date, confidence: "month" };
  }

  if (["年", "year"].includes(unit)) {
    date.setFullYear(date.getFullYear() - amount);
    return { date, confidence: "year" };
  }

  return { date: null, confidence: "unknown" };
}

function dateToIsoDate(date) {
  if (!date) {
    return "";
  }

  return date.toISOString().slice(0, 10);
}

function escapeCsv(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function writeCsv(filePath, reviews) {
  const headers = [
    "index",
    "author",
    "rating",
    "dateText",
    "date",
    "dateConfidence",
    "text",
    "raw",
  ];

  const rows = reviews.map((review, index) => [
    index + 1,
    review.author,
    review.rating,
    review.dateText,
    review.date,
    review.dateConfidence,
    review.text,
    review.raw,
  ]);

  fs.writeFileSync(
    filePath,
    [headers, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n")
  );
}

async function openReviews(page) {
  console.log("Opening reviews panel...");

  const reviewSelectors = [
    'button[jsaction*="pane.reviewChart.moreReviews"]',
    '[role="tab"]:has-text("評論")',
    '[role="tab"]:has-text("Reviews")',
    'button:has-text("篇評論")',
    'button:has-text("則評論")',
    'button:has-text("reviews")',
    'a:has-text("評論")',
    'a:has-text("Reviews")',
  ];

  for (const selector of reviewSelectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try {
        await locator.click({ timeout: 10000 });
        await page.locator(REVIEW_CARD_SELECTOR).first().waitFor({ timeout: 20000 });
        return;
      } catch (error) {
        await closeWriteReviewDialog(page);
        console.log(`Could not open reviews with selector ${selector}: ${error.message}`);
      }
    }
  }

  await throwIfContentRestricted(page);
  await page.locator(REVIEW_CARD_SELECTOR).first().waitFor({ timeout: 20000 });
}

async function closeWriteReviewDialog(page) {
  const dialog = page.locator('iframe[aria-label*="撰寫評論"], iframe[aria-label*="Write a review"]');
  if (!(await dialog.count())) {
    return;
  }

  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(1000);
}

async function throwIfContentRestricted(page) {
  const restricted = await page
    .getByText(/目前看到的 Google 地圖內容受限|Google Maps content is limited/i)
    .count()
    .catch(() => 0);

  if (restricted > 0) {
    throw new Error(
      "Google Maps is limiting review content in this browser session. Run locally with a regular signed-in browser/session, or use a self-hosted runner with an allowed Google session."
    );
  }
}

async function sortNewest(page) {
  console.log("Trying to sort by newest reviews...");

  const sortButtons = [
    'button:has-text("排序")',
    'button:has-text("Sort")',
    'button[aria-label*="排序"]',
    'button[aria-label*="Sort"]',
  ];

  for (const selector of sortButtons) {
    const button = page.locator(selector).first();
    if (!(await button.count())) {
      continue;
    }

    try {
      await button.click({ timeout: 5000 });
      await page.waitForTimeout(1000);

      const newest = page
        .locator('[role="menuitemradio"], [role="menuitem"], div[role="option"]')
        .filter({ hasText: /最新|Newest|Most recent/i })
        .first();

      if (await newest.count()) {
        await newest.click({ timeout: 5000 });
        await page.waitForTimeout(3000);
        return true;
      }
    } catch (error) {
      console.log(`Could not use sort button ${selector}: ${error.message}`);
    }
  }

  console.log("Newest sort was not available; continuing with the default order.");
  return false;
}

async function extractReviews(page) {
  return page.$$eval('div[data-review-id], div.jftiEf', (nodes) => {
    return nodes.map((node) => {
      const bySelector = (selector) => node.querySelector(selector)?.textContent?.trim() || "";
      const author =
        bySelector(".d4r55") ||
        bySelector('[class*="fontHeadlineSmall"]') ||
        bySelector('[role="link"]');

      const ratingLabel =
        node.querySelector('[role="img"][aria-label*="星"]')?.getAttribute("aria-label") ||
        node.querySelector('[role="img"][aria-label*="star"]')?.getAttribute("aria-label") ||
        "";

      const ratingMatch = ratingLabel.match(/([\d.]+)/);
      const dateText =
        bySelector(".rsqaWe") ||
        bySelector(".xRkPPb") ||
        Array.from(node.querySelectorAll("span"))
          .map((span) => span.textContent?.trim() || "")
          .find((text) => /前|ago|昨天|今天|\d{4}/i.test(text)) ||
        "";

      const moreButton = Array.from(node.querySelectorAll("button")).find((button) =>
        /更多|More/i.test(button.textContent || "")
      );
      if (moreButton) {
        moreButton.click();
      }

      const text =
        bySelector(".wiI7pd") ||
        bySelector(".MyEned") ||
        bySelector('[data-expandable-section]') ||
        "";

      return {
        id: node.getAttribute("data-review-id") || "",
        author,
        rating: ratingMatch ? Number(ratingMatch[1]) : null,
        ratingLabel,
        dateText,
        text,
        raw: node.innerText || "",
      };
    });
  });
}

async function scrollReviewContainer(page) {
  return page.evaluate((reviewSelector) => {
    const firstReview = document.querySelector(reviewSelector);
    if (!firstReview) {
      return { scrolled: false, reason: "no-review-card" };
    }

    let current = firstReview.parentElement;
    let best = null;

    while (current && current !== document.body) {
      const style = window.getComputedStyle(current);
      const canScroll =
        current.scrollHeight > current.clientHeight + 50 &&
        !["hidden", "clip"].includes(style.overflowY);

      if (canScroll) {
        best = current;
        break;
      }

      current = current.parentElement;
    }

    if (!best) {
      const candidates = Array.from(document.querySelectorAll("div")).filter((element) => {
        const style = window.getComputedStyle(element);
        return (
          element.scrollHeight > element.clientHeight + 100 &&
          element.clientHeight > 300 &&
          !["hidden", "clip"].includes(style.overflowY)
        );
      });
      best = candidates.sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || null;
    }

    if (!best) {
      window.scrollTo(0, document.body.scrollHeight);
      return { scrolled: true, reason: "window" };
    }

    best.scrollTop = best.scrollHeight;
    return {
      scrolled: true,
      reason: "container",
      className: best.className,
      ariaLabel: best.getAttribute("aria-label") || "",
    };
  }, REVIEW_CARD_SELECTOR);
}

function normalizeReviews(reviews, cutoffDate) {
  const seen = new Set();

  return reviews
    .map((review) => {
      const parsedDate = parseReviewDate(review.dateText);
      return {
        ...review,
        date: dateToIsoDate(parsedDate.date),
        dateConfidence: parsedDate.confidence,
        isWithinRange: parsedDate.date ? parsedDate.date >= cutoffDate : null,
      };
    })
    .filter((review) => {
      const key = review.id || `${review.author}\n${review.dateText}\n${review.text || review.raw}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function shouldStopForSixMonths(reviews, cutoffDate) {
  const datedReviews = reviews
    .map((review) => parseReviewDate(review.dateText).date)
    .filter(Boolean);

  if (datedReviews.length < 8) {
    return false;
  }

  const oldest = new Date(Math.min(...datedReviews.map((date) => date.getTime())));
  return oldest < cutoffDate;
}

async function scrollReviews(page, options, cutoffDate) {
  await page.locator(REVIEW_CARD_SELECTOR).first().waitFor({ timeout: 30000 });

  let previousCount = 0;
  let staleScrolls = 0;
  let allReviews = [];

  for (let i = 0; i < options.maxScrolls; i += 1) {
    allReviews = await extractReviews(page);
    const normalized = normalizeReviews(allReviews, cutoffDate);

    console.log(`Scroll ${i + 1}/${options.maxScrolls}: ${normalized.length} reviews loaded`);

    if (options.range === "six-months" && shouldStopForSixMonths(normalized, cutoffDate)) {
      console.log("Reached reviews older than the requested window.");
      return normalized;
    }

    if (normalized.length === previousCount) {
      staleScrolls += 1;
    } else {
      staleScrolls = 0;
      previousCount = normalized.length;
    }

    if (staleScrolls >= 5) {
      console.log("No more reviews appeared after several scrolls.");
      return normalized;
    }

    await scrollReviewContainer(page);
    await page.waitForTimeout(1800);
  }

  return normalizeReviews(await extractReviews(page), cutoffDate);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cutoffDate = subtractMonths(new Date(), options.months);
  const outputDir = path.resolve(options.outputDir);
  const { chromium } = require("playwright");

  fs.mkdirSync(outputDir, { recursive: true });

  const browserSession = await launchBrowser(chromium, options);
  const { page } = browserSession;

  try {
    console.log(`Opening ${options.url}`);
    await page.goto(options.url, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });

    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await openReviews(page);
    await sortNewest(page);

    const loadedReviews = await scrollReviews(page, options, cutoffDate);
    const filteredReviews =
      options.range === "six-months"
        ? loadedReviews.filter((review) => review.isWithinRange !== false)
        : loadedReviews;

    const metadata = {
      sourceUrl: options.url,
      range: options.range,
      months: options.range === "six-months" ? options.months : null,
      cutoffDate: options.range === "six-months" ? dateToIsoDate(cutoffDate) : null,
      scrapedAt: new Date().toISOString(),
      reviewCount: filteredReviews.length,
      loadedReviewCount: loadedReviews.length,
    };

    const jsonPath = path.join(outputDir, "reviews.json");
    const csvPath = path.join(outputDir, "reviews.csv");
    const screenshotPath = path.join(outputDir, "reviews-page.png");

    fs.writeFileSync(
      jsonPath,
      JSON.stringify({ metadata, reviews: filteredReviews }, null, 2)
    );
    writeCsv(csvPath, filteredReviews);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    console.log(`Review count: ${filteredReviews.length}`);
    console.log(`Wrote ${jsonPath}`);
    console.log(`Wrote ${csvPath}`);
    console.log(`Wrote ${screenshotPath}`);
  } catch (error) {
    const failureScreenshotPath = path.join(outputDir, "failure-page.png");
    const failureHtmlPath = path.join(outputDir, "failure-page.html");

    await page.screenshot({ path: failureScreenshotPath, fullPage: true }).catch(() => {});
    fs.writeFileSync(failureHtmlPath, await page.content().catch(() => ""));

    console.error(`Wrote ${failureScreenshotPath}`);
    console.error(`Wrote ${failureHtmlPath}`);
    throw error;
  } finally {
    await browserSession.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
