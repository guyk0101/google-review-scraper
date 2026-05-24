const fs = require("fs");
const path = require("path");

const DEFAULT_LOCALE = "zh-TW";
const DEFAULT_MAX_SCROLLS = 120;
const DEFAULT_OUTPUT_DIR = "output";
const DEFAULT_REVIEW_RETRIES = 1;
const DEFAULT_PAGE_SETTLE_MS = 2000;
const DEFAULT_SCROLL_DELAY_MS = 2000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_STALE_SCROLL_LIMIT = 4;
const DEFAULT_SCROLL_STEP_MULTIPLIER = 1.6;
const REVIEW_CARD_SELECTOR = "div.jftiEf, div[data-review-id]";
const PROFILE_LOCK_FILES = [
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  "DevToolsActivePort",
];
const PROFILE_CACHE_PATHS = [
  "Default/Cache",
  "Default/Code Cache",
  "Default/GPUCache",
  "Default/DawnGraphiteCache",
  "Default/DawnWebGPUCache",
  "Default/ShaderCache",
  "Default/GrShaderCache",
  "Default/GraphiteDawnCache",
  "GrShaderCache",
  "ShaderCache",
  "GraphiteDawnCache",
];

function parseArgs(argv) {
  const options = {
    url: process.env.GOOGLE_MAPS_URL || "",
    months: Number(process.env.REVIEW_MONTHS || 6),
    maxScrolls: Number(process.env.MAX_SCROLLS || DEFAULT_MAX_SCROLLS),
    outputDir: process.env.OUTPUT_DIR || DEFAULT_OUTPUT_DIR,
    reviewRetries: Number(process.env.REVIEW_RETRIES || DEFAULT_REVIEW_RETRIES),
    pageSettleMs: Number(process.env.PAGE_SETTLE_MS || DEFAULT_PAGE_SETTLE_MS),
    scrollDelayMs: Number(process.env.SCROLL_DELAY_MS || DEFAULT_SCROLL_DELAY_MS),
    loadWaitMode: process.env.LOAD_WAIT_MODE || "legacy",
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS),
    staleScrollLimit: Number(process.env.STALE_SCROLL_LIMIT || DEFAULT_STALE_SCROLL_LIMIT),
    scrollStepMultiplier: Number(process.env.SCROLL_STEP_MULTIPLIER || DEFAULT_SCROLL_STEP_MULTIPLIER),
    locale: process.env.LOCALE || DEFAULT_LOCALE,
    timezone: process.env.TIMEZONE || "",
    viewportWidth: Number(process.env.VIEWPORT_WIDTH || 1440),
    viewportHeight: Number(process.env.VIEWPORT_HEIGHT || 1200),
    profileDir: process.env.PROFILE_DIR || "",
    browserChannel: process.env.BROWSER_CHANNEL || "",
    executablePath: process.env.BROWSER_EXECUTABLE_PATH || "",
    userAgent: process.env.USER_AGENT || "",
    headlessCompat: process.env.HEADLESS_COMPAT === "true",
    debugHoldMs: Number(process.env.DEBUG_HOLD_MS || 0),
    debugArtifacts: process.env.DEBUG_ARTIFACTS === "true",
    waitNetworkIdle: process.env.WAIT_NETWORKIDLE === "true",
    headless: process.env.HEADLESS !== "false",
    cleanupProfileCache: process.env.CLEAN_PROFILE_CACHE !== "false",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--url" && next) {
      options.url = next;
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
    } else if (arg === "--review-retries" && next) {
      options.reviewRetries = Number(next);
      i += 1;
    } else if (arg === "--page-settle-ms" && next) {
      options.pageSettleMs = Number(next);
      i += 1;
    } else if (arg === "--scroll-delay-ms" && next) {
      options.scrollDelayMs = Number(next);
      i += 1;
    } else if (arg === "--load-wait-mode" && next) {
      options.loadWaitMode = next;
      i += 1;
    } else if (arg === "--poll-interval-ms" && next) {
      options.pollIntervalMs = Number(next);
      i += 1;
    } else if (arg === "--stale-scroll-limit" && next) {
      options.staleScrollLimit = Number(next);
      i += 1;
    } else if (arg === "--scroll-step-multiplier" && next) {
      options.scrollStepMultiplier = Number(next);
      i += 1;
    } else if (arg === "--locale" && next) {
      options.locale = next;
      i += 1;
    } else if (arg === "--timezone" && next) {
      options.timezone = next;
      i += 1;
    } else if (arg === "--viewport-width" && next) {
      options.viewportWidth = Number(next);
      i += 1;
    } else if (arg === "--viewport-height" && next) {
      options.viewportHeight = Number(next);
      i += 1;
    } else if (arg === "--profile-dir" && next) {
      options.profileDir = next;
      i += 1;
    } else if (arg === "--browser-channel" && next) {
      options.browserChannel = next;
      i += 1;
    } else if (arg === "--executable-path" && next) {
      options.executablePath = next;
      i += 1;
    } else if (arg === "--user-agent" && next) {
      options.userAgent = next;
      i += 1;
    } else if (arg === "--headless-compat") {
      options.headlessCompat = true;
    } else if (arg === "--debug-hold-ms" && next) {
      options.debugHoldMs = Number(next);
      i += 1;
    } else if (arg === "--debug-artifacts") {
      options.debugArtifacts = true;
    } else if (arg === "--headed") {
      options.headless = false;
    } else if (arg === "--keep-profile-cache") {
      options.cleanupProfileCache = false;
    } else if (arg === "--wait-networkidle") {
      options.waitNetworkIdle = true;
    } else if (arg === "--fast") {
      options.pageSettleMs = 800;
      options.scrollDelayMs = 1800;
      options.pollIntervalMs = 80;
      options.staleScrollLimit = 4;
      options.scrollStepMultiplier = 2.2;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  if (!options.url) {
    throw new Error("Missing --url. Example: node scrape.js --url https://maps.app.goo.gl/...");
  }

  if (!Number.isFinite(options.months) || options.months <= 0) {
    throw new Error("--months must be a positive number");
  }

  if (!Number.isFinite(options.maxScrolls) || options.maxScrolls <= 0) {
    throw new Error("--max-scrolls must be a positive number");
  }

  if (!Number.isFinite(options.reviewRetries) || options.reviewRetries < 0) {
    throw new Error("--review-retries must be zero or a positive number");
  }

  if (!Number.isFinite(options.pageSettleMs) || options.pageSettleMs < 0) {
    throw new Error("--page-settle-ms must be zero or a positive number");
  }

  if (!Number.isFinite(options.scrollDelayMs) || options.scrollDelayMs < 0) {
    throw new Error("--scroll-delay-ms must be zero or a positive number");
  }

  if (!["legacy", "stable"].includes(options.loadWaitMode)) {
    throw new Error("--load-wait-mode must be legacy or stable");
  }

  if (!Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs <= 0) {
    throw new Error("--poll-interval-ms must be a positive number");
  }

  if (!Number.isFinite(options.staleScrollLimit) || options.staleScrollLimit <= 0) {
    throw new Error("--stale-scroll-limit must be a positive number");
  }

  if (!Number.isFinite(options.scrollStepMultiplier) || options.scrollStepMultiplier <= 0) {
    throw new Error("--scroll-step-multiplier must be a positive number");
  }

  if (!Number.isFinite(options.viewportWidth) || options.viewportWidth <= 0) {
    throw new Error("--viewport-width must be a positive number");
  }

  if (!Number.isFinite(options.viewportHeight) || options.viewportHeight <= 0) {
    throw new Error("--viewport-height must be a positive number");
  }

  return options;
}

function printHelp() {
  console.log(`
Usage:
  node scrape.js --url <google-maps-url> [options]

Options:
  --months <number>         Recent-review window in months. Default: 6
  --max-scrolls <number>    Safety limit for review-feed scrolling. Default: 120
  --output-dir <path>       Directory for reviews.json and optional debug artifacts
  --review-retries <number> Reload and retry when reviews are empty/limited. Default: 1
  --page-settle-ms <number> Wait after page load before opening reviews. Default: 2000
  --wait-networkidle        Wait for network idle after page load/reload
  --scroll-delay-ms <number> Max adaptive wait after each scroll. Default: 2000
  --load-wait-mode <mode>   Wait mode after scrolling: legacy or stable. Default: legacy
  --poll-interval-ms <number> Adaptive wait polling interval. Default: 100
  --stale-scroll-limit <n>  Stop after this many unchanged scrolls. Default: 4
  --scroll-step-multiplier <n> Scroll distance multiplier. Default: 1.6
  --fast                    Shortcut: lower delay, fewer stale checks, larger scrolls
  --locale <locale>         Browser locale. Default: zh-TW
  --timezone <timezone>     Browser timezone, e.g. Asia/Taipei
  --viewport-width <number> Browser viewport width. Default: 1440
  --viewport-height <number> Browser viewport height. Default: 1200
  --profile-dir <path>      Reuse a persistent Chromium profile for login/session state
  --keep-profile-cache      Keep browser cache after scraping. By default cache is cleaned while cookies/session are preserved
  --browser-channel <name>  Use an installed browser channel, e.g. chrome or msedge
  --executable-path <path>  Use a specific Chrome/Edge executable path
  --user-agent <string>     Override browser user agent
  --headless-compat         Reduce common headless/headed JS fingerprint differences
  --debug-hold-ms <number>  Keep the browser open for this many ms after an error
  --debug-artifacts         Also write reviews.csv and reviews-page.png on success
  --headed                  Show Chromium while scraping
`);
}

async function launchBrowser(chromium, options) {
  const launchOptions = {
    headless: options.headless,
  };

  if (options.browserChannel) {
    launchOptions.channel = options.browserChannel;
  }

  if (options.executablePath) {
    launchOptions.executablePath = path.resolve(options.executablePath);
  }

  const contextOptions = {
    locale: options.locale,
    viewport: { width: options.viewportWidth, height: options.viewportHeight },
    extraHTTPHeaders: {
      "Accept-Language": `${options.locale},zh;q=0.9,en;q=0.8`,
    },
  };

  if (options.userAgent || (options.headless && options.headlessCompat)) {
    contextOptions.userAgent = options.userAgent || defaultChromeUserAgent();
  }

  if (options.timezone) {
    contextOptions.timezoneId = options.timezone;
  }

  if (options.profileDir) {
    const profileDir = path.resolve(options.profileDir);
    fs.mkdirSync(profileDir, { recursive: true });
    clearProfileLocks(profileDir);
    console.log(`Using persistent profile: ${profileDir}`);

    const context = await chromium.launchPersistentContext(profileDir, {
      ...contextOptions,
      ...launchOptions,
    });
    await applyHeadlessCompat(context, options);
    const page = context.pages()[0] || (await context.newPage());
    return { page, close: () => context.close() };
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext(contextOptions);
  await applyHeadlessCompat(context, options);
  const page = await context.newPage();
  return { page, close: () => browser.close() };
}

function clearProfileLocks(profileDir) {
  for (const fileName of PROFILE_LOCK_FILES) {
    const filePath = path.join(profileDir, fileName);
    try {
      fs.rmSync(filePath, { force: true, recursive: true });
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`Could not remove stale profile lock ${fileName}: ${error.message}`);
      }
    }
  }
}

function defaultChromeUserAgent() {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
}

async function applyHeadlessCompat(context, options) {
  if (!options.headless || !options.headlessCompat) {
    return;
  }

  await context.addInitScript(({ width, height }) => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
      configurable: true,
    });

    Object.defineProperty(navigator, "languages", {
      get: () => ["zh-TW", "zh", "en"],
      configurable: true,
    });

    Object.defineProperty(window, "outerWidth", {
      get: () => width + 16,
      configurable: true,
    });

    Object.defineProperty(window, "outerHeight", {
      get: () => Math.max(height - 412, 768),
      configurable: true,
    });

    window.chrome = window.chrome || {};
    window.chrome.runtime = window.chrome.runtime || {};
  }, { width: options.viewportWidth, height: options.viewportHeight });
}

function subtractMonths(date, months) {
  const result = new Date(date);
  result.setMonth(result.getMonth() - months);
  return result;
}

function stripEditedPrefix(value) {
  return String(value || "")
    .replace(/^上次編輯：\s*/u, "")
    .replace(/^已編輯\s*/u, "")
    .replace(/^Edited\s*/iu, "")
    .trim();
}

function parseReviewDate(rawDate, now = new Date()) {
  const value = stripEditedPrefix(rawDate);
  if (!value) {
    return { date: null, confidence: "none" };
  }

  const absoluteZh = value.match(/(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?/u);
  if (absoluteZh) {
    return {
      date: new Date(Number(absoluteZh[1]), Number(absoluteZh[2]) - 1, Number(absoluteZh[3] || 1)),
      confidence: absoluteZh[3] ? "day" : "month",
    };
  }

  const absoluteSlash = value.match(/(\d{4})[/-](\d{1,2})(?:[/-](\d{1,2}))?/u);
  if (absoluteSlash) {
    return {
      date: new Date(Number(absoluteSlash[1]), Number(absoluteSlash[2]) - 1, Number(absoluteSlash[3] || 1)),
      confidence: absoluteSlash[3] ? "day" : "month",
    };
  }

  if (/剛剛|今天|just now|today/i.test(value)) {
    return { date: new Date(now), confidence: "day" };
  }

  if (/昨天|yesterday/i.test(value)) {
    const date = new Date(now);
    date.setDate(date.getDate() - 1);
    return { date, confidence: "day" };
  }

  const zhRelative = value.match(/(\d+)\s*(秒|分鐘|小時|天|週|周|星期|個月|月|年)前/u);
  if (zhRelative) {
    return relativeDate(Number(zhRelative[1]), zhRelative[2], now);
  }

  const enRelative = value.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/i);
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

  if (["週", "周", "星期", "week"].includes(unit)) {
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

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function escapeCsv(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(filePath, reviews) {
  const headers = [
    "index",
    "author",
    "rating",
    "ratingLabel",
    "likeCount",
    "dateText",
    "date",
    "dateConfidence",
    "isWithinRange",
    "text",
  ];

  const rows = reviews.map((review, index) => [
    index + 1,
    review.author,
    review.rating,
    review.ratingLabel,
    review.likeCount,
    review.dateText,
    review.date,
    review.dateConfidence,
    review.isWithinRange,
    review.text,
  ]);

  fs.writeFileSync(filePath, [headers, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n"));
}

function compactReviewText(value) {
  return String(value ?? "")
    .replace(/\\[rn]/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function stripInternalReviewFields(reviews) {
  return reviews.map(({ id: _id, raw: _raw, ...review }) => review);
}

async function dismissGoogleOverlays(page) {
  const buttons = [
    page.getByRole("button", { name: /接受全部|全部接受|Accept all/i }),
    page.getByRole("button", { name: /拒絕全部|Reject all/i }),
    page.getByRole("button", { name: /稍後|Not now/i }),
  ];

  for (const button of buttons) {
    try {
      if (await button.count()) {
        await button.first().click({ timeout: 2000 });
        await page.waitForTimeout(800);
      }
    } catch (_error) {
      // Best effort only.
    }
  }
}

async function openReviews(page) {
  console.log("Opening reviews panel...");

  await dismissGoogleOverlays(page);

  const selectors = [
    '[role="tab"]:has-text("評論")',
    '[role="tab"]:has-text("Reviews")',
    'button:has-text("篇評論")',
    'button:has-text("則評論")',
    'button:has-text("reviews")',
    'button[jsaction*="pane.reviewChart.moreReviews"]',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!(await locator.count())) {
      continue;
    }

    try {
      await locator.click({ timeout: 10000 });
      await page.locator(REVIEW_CARD_SELECTOR).first().waitFor({ timeout: 25000 });
      return;
    } catch (error) {
      await throwIfContentRestricted(page);
      console.log(`Could not open reviews with ${selector}: ${error.message}`);
      await page.keyboard.press("Escape").catch(() => {});
    }
  }

  await throwIfContentRestricted(page);
  await page.locator(REVIEW_CARD_SELECTOR).first().waitFor({ timeout: 25000 });
}

async function throwIfContentRestricted(page) {
  const restricted = await page
    .getByText(/Google Maps content is limited|Google 地圖內容受到限制|無法載入/i)
    .count()
    .catch(() => 0);

  if (restricted > 0) {
    throw new Error(
      "Google Maps is limiting review content in this browser session. Try --headed with --profile-dir and a regular signed-in browser session."
    );
  }

  const bodyText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  if (/目前看到的 Google 地圖內容受限|內容受限|content is limited/i.test(bodyText)) {
    throw new Error(
      "Google Maps is limiting review content in this browser session. Try --headed with --profile-dir and a regular signed-in browser session."
    );
  }
}

async function sortNewest(page) {
  console.log("Trying to sort by newest reviews...");

  const buttons = [
    page.getByRole("button", { name: /排序評論|排序|Sort/i }),
    page.locator('button[aria-label*="排序"]').first(),
    page.locator('button[aria-label*="Sort"]').first(),
  ];

  for (const button of buttons) {
    try {
      if (!(await button.count())) {
        continue;
      }

      await button.first().click({ timeout: 5000 });
      await page.waitForTimeout(800);

      const newest = page
        .locator('[role="menuitemradio"], [role="menuitem"], div[role="option"]')
        .filter({ hasText: /最新|Newest|Most recent/i })
        .first();

      if (await newest.count()) {
        await newest.click({ timeout: 5000 });
        await page.waitForTimeout(2500);
        return true;
      }
    } catch (error) {
      console.log(`Could not sort with one candidate: ${error.message}`);
      await page.keyboard.press("Escape").catch(() => {});
    }
  }

  console.log("Newest sort was not available; continuing with the default order.");
  return false;
}

async function expandVisibleReviews(page) {
  await page.evaluate((reviewSelector) => {
    const cards = Array.from(document.querySelectorAll(reviewSelector));
    for (const card of cards) {
      for (const button of Array.from(card.querySelectorAll("button"))) {
        const text = (button.textContent || "").trim();
        const label = button.getAttribute("aria-label") || "";
        if (/更多|顯示更多|More/i.test(text) || /更多|More/i.test(label)) {
          button.click();
        }
      }
    }
  }, REVIEW_CARD_SELECTOR);
}

async function extractReviews(page) {
  await expandVisibleReviews(page);

  return page.$$eval(REVIEW_CARD_SELECTOR, (nodes) => {
    return nodes.map((node) => {
      const textOf = (selector) => node.querySelector(selector)?.textContent?.trim() || "";
      const author =
        textOf(".d4r55") ||
        textOf('[class*="fontTitleMedium"]') ||
        textOf('[class*="fontHeadlineSmall"]') ||
        node.getAttribute("aria-label") ||
        "";

      const ratingResult = extractRating(node);

      const dateText =
        textOf(".rsqaWe") ||
        textOf(".xRkPPb") ||
        Array.from(node.querySelectorAll("span"))
          .map((span) => span.textContent?.trim() || "")
          .find((text) => /前$|上次編輯|ago$|\d{4}/i.test(text)) ||
        "";

      const reviewText =
        textOf(".wiI7pd") ||
        textOf(".MyEned") ||
        textOf('[data-expandable-section]') ||
        "";
      const rawText = node.innerText || "";

      return {
        id: node.getAttribute("data-review-id") || "",
        author,
        rating: ratingResult.rating,
        ratingLabel: ratingResult.label,
        likeCount: extractLikeCount(node),
        dateText,
        text: cleanupReviewText(reviewText),
        raw: cleanupReviewText(rawText),
      };
    });

    function extractRating(node) {
      const attributeCandidates = Array.from(
        node.querySelectorAll("[aria-label], [title], [data-tooltip], [data-value]")
      ).flatMap((element) => [
        element.getAttribute("aria-label") || "",
        element.getAttribute("title") || "",
        element.getAttribute("data-tooltip") || "",
        element.getAttribute("data-value") || "",
      ]);

      const textCandidates = [
        ...Array.from(
          node.querySelectorAll(
            '[role="img"], [class*="kvMYJc"], [class*="fzvQIb"], [class*="ceNzKf"], [class*="lTi8oc"]'
          )
        ).map((element) => element.textContent || ""),
      ];

      for (const candidate of [...attributeCandidates, ...textCandidates]) {
        const rating = parseRating(candidate);
        if (rating !== null) {
          return { rating, label: String(candidate || "").trim() };
        }
      }

      return { rating: null, label: "" };
    }

    function parseRating(value) {
      const text = String(value || "").replace(",", ".").trim();
      if (!text) {
        return null;
      }

      const patterns = [
        /([1-5](?:\.\d)?)\s*(顆星|星|stars?|\/\s*5|分)/i,
        /(評分|分數|rating|rated|rate|給予|給了)[^\d]{0,12}([1-5](?:\.\d)?)/i,
        /([1-5](?:\.\d)?)[^\d]{0,12}(滿分|out of)\s*5/i,
      ];

      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (!match) {
          continue;
        }
        const numeric = Number((match[2] && /^\d/.test(match[2]) ? match[2] : match[1]).replace(",", "."));
        if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 5) {
          return numeric;
        }
      }

      return null;
    }

    function extractLikeCount(node) {
      const candidates = [
        ...Array.from(node.querySelectorAll("[aria-label]")).map(
          (element) => element.getAttribute("aria-label") || ""
        ),
        ...Array.from(node.querySelectorAll("button")).map((button) => button.textContent || ""),
        node.innerText || "",
      ];

      for (const text of candidates) {
        const value = parseLikeCount(text);
        if (value !== null) {
          return value;
        }
      }

      return null;
    }

    function parseLikeCount(value) {
      const text = String(value || "").trim();
      const match =
        text.match(/(?:有\s*)?([\d,]+)\s*(?:人)?(?:覺得|認為)?.{0,16}(?:實用|有幫助|按讚|喜歡|讚|like[s]?|helpful)/i) ||
        text.match(/(?:實用|有幫助|按讚|喜歡|讚|like[s]?|helpful).{0,16}([\d,]+)/i) ||
        text.match(/([\d,]+).{0,16}(?:實用|有幫助|按讚|喜歡|讚|like[s]?|helpful)/i);

      if (!match) {
        return null;
      }

      const count = Number(match[1].replace(/,/g, ""));
      return Number.isFinite(count) ? count : null;
    }

    function cleanupReviewText(value) {
      return String(value || "")
        .replace(/\n(餐點類型|餐點：|服務：|氣氛：|平均每人消費金額|建議的餐點|停車位|停車選項|訂單類型)[\s\S]*$/u, "")
        .replace(/\n(更多|More)$/iu, "")
        .replace(/\\[rn]/g, " ")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
    }
  });
}

async function scrollReviewContainer(page, options) {
  return page.evaluate(({ reviewSelector, scrollStepMultiplier }) => {
    const firstReview = document.querySelector(reviewSelector);
    const candidates = [];

    if (firstReview) {
      let current = firstReview.parentElement;
      while (current && current !== document.body) {
        candidates.push(current);
        current = current.parentElement;
      }
    }

    candidates.push(...Array.from(document.querySelectorAll("div")));

    const scroller = candidates
      .filter((element) => {
        const style = window.getComputedStyle(element);
        return (
          element.scrollHeight > element.clientHeight + 100 &&
          element.clientHeight > 250 &&
          !["hidden", "clip"].includes(style.overflowY)
        );
      })
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];

    if (!scroller) {
      window.scrollBy(0, window.innerHeight);
      return { scrolled: true, target: "window" };
    }

    const before = scroller.scrollTop;
    scroller.scrollBy(0, Math.max(900, scroller.clientHeight * scrollStepMultiplier));
    return {
      scrolled: scroller.scrollTop !== before,
      target: "container",
      className: scroller.className,
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
    };
  }, { reviewSelector: REVIEW_CARD_SELECTOR, scrollStepMultiplier: options.scrollStepMultiplier });
}

async function getReviewCardCount(page) {
  return page
    .locator(REVIEW_CARD_SELECTOR)
    .count()
    .catch(() => 0);
}

async function getReviewFeedState(page) {
  return page
    .evaluate((reviewSelector) => {
      const cardCount = document.querySelectorAll(reviewSelector).length;
      const firstReview = document.querySelector(reviewSelector);
      const candidates = [];

      if (firstReview) {
        let current = firstReview.parentElement;
        while (current && current !== document.body) {
          candidates.push(current);
          current = current.parentElement;
        }
      }

      candidates.push(...Array.from(document.querySelectorAll("div")));

      const scroller = candidates
        .filter((element) => {
          const style = window.getComputedStyle(element);
          return (
            element.scrollHeight > element.clientHeight + 100 &&
            element.clientHeight > 250 &&
            !["hidden", "clip"].includes(style.overflowY)
          );
        })
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];

      if (!scroller) {
        return {
          cardCount,
          scrollTop: window.scrollY,
          scrollHeight: document.documentElement.scrollHeight,
          clientHeight: window.innerHeight,
          bottomGap: document.documentElement.scrollHeight - window.scrollY - window.innerHeight,
        };
      }

      return {
        cardCount,
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        bottomGap: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
      };
    }, REVIEW_CARD_SELECTOR)
    .catch(() => ({
      cardCount: 0,
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      bottomGap: 0,
    }));
}

function hasReviewCardGrown(previous, current) {
  return current.cardCount > previous.cardCount;
}

function hasFeedLayoutChanged(previous, current) {
  return (
    current.cardCount !== previous.cardCount ||
    Math.abs(current.scrollHeight - previous.scrollHeight) > 20 ||
    Math.abs(current.scrollTop - previous.scrollTop) > 20
  );
}

function isSameFeedState(a, b) {
  return (
    a.cardCount === b.cardCount &&
    Math.abs(a.scrollHeight - b.scrollHeight) <= 2 &&
    Math.abs(a.scrollTop - b.scrollTop) <= 2
  );
}

async function waitForReviewLoadAfterScroll(page, previousState, options) {
  if (options.scrollDelayMs <= 0) {
    return { loaded: false, state: await getReviewFeedState(page) };
  }

  const deadline = Date.now() + options.scrollDelayMs;
  const stableMs = Math.min(700, Math.max(250, options.pollIntervalMs * 4));
  let sawGrowth = false;
  let stableSince = 0;
  let lastState = previousState;

  while (Date.now() < deadline) {
    await page.waitForTimeout(options.pollIntervalMs);
    const currentState = await getReviewFeedState(page);

    if (hasReviewCardGrown(previousState, currentState)) {
      sawGrowth = true;
    }

    if (sawGrowth && isSameFeedState(lastState, currentState)) {
      if (!stableSince) {
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= stableMs) {
        return { loaded: true, state: currentState };
      }
    } else if (hasFeedLayoutChanged(lastState, currentState)) {
      stableSince = 0;
    }

    lastState = currentState;
  }

  return { loaded: sawGrowth, state: lastState };
}

async function waitForReviewGrowthLegacy(page, previousCardCount, options) {
  if (options.scrollDelayMs <= 0) {
    return false;
  }

  const deadline = Date.now() + options.scrollDelayMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(options.pollIntervalMs);
    const cardCount = await getReviewCardCount(page);
    if (cardCount > previousCardCount) {
      return true;
    }
  }

  return false;
}

function normalizeReviews(reviews, cutoffDate, now = new Date()) {
  const seen = new Set();

  return reviews
    .map((review) => {
      const parsedDate = parseReviewDate(review.dateText, now);
      return {
        ...review,
        author: compactReviewText(review.author),
        ratingLabel: compactReviewText(review.ratingLabel),
        dateText: compactReviewText(review.dateText),
        text: compactReviewText(review.text),
        raw: compactReviewText(review.raw),
        date: dateToIsoDate(parsedDate.date),
        dateConfidence: parsedDate.confidence,
        isWithinRange: parsedDate.date ? parsedDate.date >= cutoffDate : null,
      };
    })
    .filter((review) => {
      const key = review.id || `${review.author}\n${review.rating}\n${review.dateText}\n${review.text || review.raw}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function shouldStopForRange(reviews, cutoffDate) {
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
  let previousCardCount = 0;
  let staleScrolls = 0;
  let normalized = [];

  for (let i = 0; i < options.maxScrolls; i += 1) {
    const extracted = await extractReviews(page);
    const currentCardCount = extracted.length;
    const previousFeedState = await getReviewFeedState(page);
    normalized = normalizeReviews(extracted, cutoffDate);
    console.log(`Scroll ${i + 1}/${options.maxScrolls}: ${normalized.length} reviews loaded`);

    if (shouldStopForRange(normalized, cutoffDate)) {
      console.log("Reached reviews older than the requested window.");
      return normalized;
    }

    if (normalized.length === previousCount && currentCardCount === previousCardCount) {
      staleScrolls += 1;
    } else {
      previousCount = normalized.length;
      previousCardCount = currentCardCount;
      staleScrolls = 0;
    }

    if (staleScrolls >= options.staleScrollLimit) {
      console.log("No more reviews appeared after several scrolls.");
      return normalized;
    }

    await scrollReviewContainer(page, options);
    if (options.loadWaitMode === "legacy") {
      const loaded = await waitForReviewGrowthLegacy(page, currentCardCount, options);
      if (!loaded) {
        console.log("No new review batch detected after this scroll.");
      }
    } else {
      const waitResult = await waitForReviewLoadAfterScroll(page, previousFeedState, options);
      if (!waitResult.loaded) {
        console.log("No new review batch detected after this scroll.");
      }
    }
  }

  return normalizeReviews(await extractReviews(page), cutoffDate);
}

async function waitForMapReady(page, options) {
  if (options.waitNetworkIdle) {
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    return;
  }

  if (options.pageSettleMs > 0) {
    await page.waitForTimeout(options.pageSettleMs);
  }
}

async function collectReviewsWithRetry(page, options, cutoffDate) {
  let lastError = null;
  const attempts = options.reviewRetries + 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      console.log(`Retrying reviews after reload (${attempt}/${attempts})...`);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 });
      await waitForMapReady(page, options);
    }

    try {
      await openReviews(page);
      await sortNewest(page);

      const loadedReviews = await scrollReviews(page, options, cutoffDate);
      if (loadedReviews.length > 0) {
        return loadedReviews;
      }

      lastError = new Error("No reviews were loaded from the reviews panel.");
      console.log(lastError.message);
    } catch (error) {
      lastError = error;
      console.log(`Review collection attempt ${attempt}/${attempts} failed: ${error.message}`);
    }
  }

  throw lastError || new Error("No reviews were loaded from the reviews panel.");
}

async function closeBrowserSession(browserSession, timeoutMs = 10000) {
  let timeout;
  try {
    await Promise.race([
      browserSession.close(),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function cleanupProfileCache(profileDir) {
  if (!profileDir) {
    return;
  }

  const root = path.resolve(profileDir);
  for (const relativePath of PROFILE_CACHE_PATHS) {
    const target = path.resolve(root, relativePath);
    if (!target.startsWith(`${root}${path.sep}`)) {
      continue;
    }

    try {
      fs.rmSync(target, { force: true, recursive: true });
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`Could not clean profile cache ${relativePath}: ${error.message}`);
      }
    }
  }
}

async function extractPlaceName(page) {
  const heading = await page
    .locator("h1")
    .first()
    .innerText({ timeout: 3000 })
    .catch(() => "");

  if (heading.trim()) {
    return heading.trim();
  }

  const title = await page.title().catch(() => "");
  return title
    .replace(/\s*-\s*Google\s*(地圖|Maps)\s*$/iu, "")
    .replace(/\s*-\s*Google\s*$/iu, "")
    .trim();
}

async function extractOverallRating(page, placeName = "") {
  return page
    .evaluate((name) => {
      const parseRating = (value) => {
        const match = String(value || "").match(/([1-5](?:[.,]\d)?)/);
        return match ? Number(match[1].replace(",", ".")) : null;
      };

      const ariaCandidate = Array.from(document.querySelectorAll("[aria-label]"))
        .map((element) => element.getAttribute("aria-label") || "")
        .find((label) => /([1-5](?:[.,]\d)?)\s*(顆星|stars?)/i.test(label));
      const ariaRating = parseRating(ariaCandidate);
      if (Number.isFinite(ariaRating)) {
        return ariaRating;
      }

      const h1 = document.querySelector("h1");
      const containers = [];
      let current = h1;
      while (current && containers.length < 6) {
        containers.push(current);
        current = current.parentElement;
      }
      containers.push(document.body);

      for (const container of containers) {
        const lines = (container.innerText || "")
          .split(/\n+/)
          .map((line) => line.trim())
          .filter(Boolean);
        const start = name ? Math.max(0, lines.findIndex((line) => line.includes(name))) : 0;
        const nearby = lines.slice(start, start + 12);
        const ratingLine = nearby.find((line) => /^[1-5](?:[.,]\d)?$/.test(line));
        const rating = parseRating(ratingLine);
        if (Number.isFinite(rating)) {
          return rating;
        }
      }

      return null;
    }, placeName)
    .catch(() => null);
}

function buildRatingComparison(overallRating, recentAverageRating) {
  if (!Number.isFinite(overallRating) || !Number.isFinite(recentAverageRating)) {
    return {
      overallRating: Number.isFinite(overallRating) ? overallRating : null,
      recentAverageRating: Number.isFinite(recentAverageRating) ? recentAverageRating : null,
      difference: null,
      direction: "unknown",
    };
  }

  const difference = recentAverageRating - overallRating;
  const direction = Math.abs(difference) < 0.05 ? "same" : difference > 0 ? "higher" : "lower";
  return {
    overallRating,
    recentAverageRating,
    difference,
    direction,
  };
}

function buildSummary(reviews) {
  const ratingCounts = {};
  for (const review of reviews) {
    const key = review.rating == null ? "unknown" : String(review.rating);
    ratingCounts[key] = (ratingCounts[key] || 0) + 1;
  }

  const rated = reviews.filter((review) => Number.isFinite(review.rating));
  const averageRating = rated.length
    ? rated.reduce((sum, review) => sum + review.rating, 0) / rated.length
    : null;

  return {
    reviewCount: reviews.length,
    averageRating,
    ratingCounts,
    lowScoreCount: reviews.filter((review) => Number.isFinite(review.rating) && review.rating <= 3).length,
  };
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
    await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await waitForMapReady(page, options);

    const placeName = await extractPlaceName(page);
    const overallRating = await extractOverallRating(page, placeName);
    const loadedReviews = await collectReviewsWithRetry(page, options, cutoffDate);
    const filteredReviews = loadedReviews.filter((review) => review.isWithinRange !== false);
    const summary = buildSummary(filteredReviews);

    const metadata = {
      sourceUrl: options.url,
      placeName,
      overallRating,
      months: options.months,
      cutoffDate: dateToIsoDate(cutoffDate),
      scrapedAt: new Date().toISOString(),
      reviewCount: filteredReviews.length,
      loadedReviewCount: loadedReviews.length,
      summary,
      ratingComparison: buildRatingComparison(overallRating, summary.averageRating),
    };

    const jsonPath = path.join(outputDir, "reviews.json");
    const outputReviews = stripInternalReviewFields(filteredReviews);

    fs.writeFileSync(jsonPath, JSON.stringify({ metadata, reviews: outputReviews }, null, 2));

    if (options.debugArtifacts) {
      const csvPath = path.join(outputDir, "reviews.csv");
      const screenshotPath = path.join(outputDir, "reviews-page.png");
      writeCsv(csvPath, outputReviews);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`Wrote ${csvPath}`);
      console.log(`Wrote ${screenshotPath}`);
    }

    console.log(`Review count: ${filteredReviews.length}`);
    console.log(`Place name: ${metadata.placeName || "n/a"}`);
    console.log(`Overall rating: ${metadata.overallRating ?? "n/a"}`);
    console.log(`Average rating: ${metadata.summary.averageRating ?? "n/a"}`);
    console.log(`Rating trend: ${metadata.ratingComparison.direction}`);
    console.log(`Wrote ${jsonPath}`);
  } catch (error) {
    const failureScreenshotPath = path.join(outputDir, "failure-page.png");
    const failureHtmlPath = path.join(outputDir, "failure-page.html");

    await page.screenshot({ path: failureScreenshotPath, fullPage: true }).catch(() => {});
    fs.writeFileSync(failureHtmlPath, await page.content().catch(() => ""));

    console.error(`Wrote ${failureScreenshotPath}`);
    console.error(`Wrote ${failureHtmlPath}`);
    if (options.debugHoldMs > 0) {
      console.error(`Holding browser open for ${options.debugHoldMs}ms for debugging...`);
      await page.waitForTimeout(options.debugHoldMs).catch(() => {});
    }
    throw error;
  } finally {
    await closeBrowserSession(browserSession);
    if (options.cleanupProfileCache) {
      cleanupProfileCache(options.profileDir);
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  parseReviewDate,
  normalizeReviews,
  buildSummary,
  extractPlaceName,
  extractOverallRating,
  buildRatingComparison,
};
