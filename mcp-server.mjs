import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.MCP_PORT || 8787);
const HOST = process.env.MCP_HOST || "127.0.0.1";
const ALLOWED_HOSTS = (process.env.MCP_ALLOWED_HOSTS || "localhost,127.0.0.1,imac.tail716865.ts.net")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);
const JOBS_DIR = path.join(__dirname, "mcp-jobs");
const SCRAPE_SCRIPT = path.join(__dirname, "scrape.js");
const SHARED_SECRET = process.env.MCP_SHARED_SECRET || "";
const SCRAPE_TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS || 300000);
const FINISHED_JOB_TTL_MS = Number(process.env.MCP_FINISHED_JOB_TTL_MS || 3600000);
const KEEP_JOB_FILES = process.env.MCP_KEEP_JOB_FILES === "true";
const MAX_JOB_LOG_LINES = 300;
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
let scrapeQueue = Promise.resolve();
const scrapeJobs = new Map();
const jobsByKey = new Map();

const googleMapsUrlPattern = /^https:\/\/(www\.)?google\.[^/]+\/maps\//i;
const shortGoogleMapsUrlPattern = /^https:\/\/maps\.app\.goo\.gl\//i;

function isValidGoogleMapsUrl(url) {
  return googleMapsUrlPattern.test(url) || shortGoogleMapsUrlPattern.test(url);
}

function createServer() {
  const server = new McpServer({
    name: "google-review-scraper",
    version: "1.0.0",
  });

  server.registerPrompt(
    "google_maps_review_analysis_zh_tw",
    {
      title: "Google Maps 評論分析（繁體中文）",
      description:
        "Analyze recent Google Maps reviews for restaurants, hotels, attractions, and other places in Traditional Chinese. Use the Google Reviews Scraper background job tools, defaulting to the most recent 8 months.",
      argsSchema: {
        months: z.string().optional().describe("Recent month window to analyze. Default: 8."),
      },
    },
    async ({ months = "8" }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: buildGoogleMapsAnalysisPrompt(months),
          },
        },
      ],
    })
  );

  server.registerTool(
    "get_google_maps_review_analysis_prompt",
    {
      title: "Get Traditional Chinese Google Maps review analysis prompt",
      description:
        "Returns the Traditional Chinese Google Maps review analysis template for restaurants, hotels, attractions, and other places. Use this when the MCP client does not expose MCP prompts/list or prompts/get. After retrieving this template, scrape reviews with start_google_reviews_scrape, poll large jobs with get_google_reviews_scrape_status, read reviews with get_google_reviews_batch, then format the final answer according to the returned template.",
      inputSchema: {
        months: z.number().int().min(1).max(24).default(8).describe("Recent month window to place into the prompt template. Default: 8."),
      },
      outputSchema: {
        name: z.string(),
        title: z.string(),
        months: z.number(),
        prompt: z.string(),
      },
    },
    async ({ months = 8 }) => {
      const normalizedMonths = Number(normalizePromptMonths(months));
      const prompt = buildGoogleMapsAnalysisPrompt(normalizedMonths);
      return {
        structuredContent: {
          name: "google_maps_review_analysis_zh_tw",
          title: "Google Maps 評論分析（繁體中文）",
          months: normalizedMonths,
          prompt,
        },
        content: [
          {
            type: "text",
            text: prompt,
          },
        ],
      };
    }
  );

  server.registerTool(
    "start_google_reviews_scrape",
    {
      title: "Start Google Maps review scrape",
      description:
        "START ONLY: create a background Google Maps review scrape job and return a jobId. Do not expect reviews from this tool. If the same url/months/maxScrolls job is already queued, running, or recently finished, this returns the existing jobId instead of starting a duplicate. After calling this tool, wait 10 seconds before polling. For large places, poll with get_google_reviews_scrape_status and then read reviews with get_google_reviews_batch. Do not call this start tool again for the same URL while the job is queued/running.",
      inputSchema: {
        url: z.string().trim().describe("Google Maps place URL, including maps.app.goo.gl short links."),
        months: z.number().int().min(1).max(24).default(8).describe("Number of recent months to scrape. This is the sole time-range control."),
        maxScrolls: z.number().int().min(1).max(300).default(120).describe("Maximum review-feed scroll attempts. Higher values are more complete but take longer in the background."),
      },
      outputSchema: {
        status: z.enum(["queued", "running", "done", "failed"]),
        jobId: z.string(),
        message: z.string(),
        nextPollSeconds: z.number(),
        elapsedMs: z.number(),
        log: z.array(z.string()),
      },
    },
    async ({ url, months = 8, maxScrolls = 120 }) => {
      if (!isValidGoogleMapsUrl(url)) {
        throw new Error("Please provide a valid Google Maps place URL.");
      }

      const job = createScrapeJob({ url, months, maxScrolls });
      return startJobResponse(job);
    }
  );

  server.registerTool(
    "get_google_reviews_scrape_result",
    {
      title: "Get Google Maps review scrape result",
      description:
        "LEGACY FULL RESULT: retrieve status or the completed full review JSON for a jobId returned by start_google_reviews_scrape. This can be too large for places with many reviews. For large places, poll with get_google_reviews_scrape_status and read reviews with get_google_reviews_batch instead. Only use this full-result tool when the review set is small enough to fit in one MCP response.",
      inputSchema: {
        jobId: z.string().trim().describe("The jobId returned by start_google_reviews_scrape."),
      },
      outputSchema: scrapeResultOutputSchema(),
    },
    async ({ jobId }) => {
      const job = scrapeJobs.get(jobId);
      if (!job) {
        throw new Error("Unknown or expired scrape jobId. Start a new scrape only if you do not already have a valid jobId.");
      }

      return resultJobResponse(job);
    }
  );

  server.registerTool(
    "get_google_reviews_scrape_status",
    {
      title: "Get Google Maps review scrape status",
      description:
        "STATUS ONLY: poll a scrape job without returning the full reviews array. Use this for large places to avoid oversized MCP responses. Call it every 10 seconds until status=done, then call get_google_reviews_batch to read reviews in batches. Do not call start_google_reviews_scrape again for the same URL while this job is queued/running.",
      inputSchema: {
        jobId: z.string().trim().describe("The jobId returned by start_google_reviews_scrape."),
      },
      outputSchema: scrapeStatusOutputSchema(),
    },
    async ({ jobId }) => {
      const job = scrapeJobs.get(jobId);
      if (!job) {
        throw new Error("Unknown or expired scrape jobId. Start a new scrape only if you do not already have a valid jobId.");
      }

      return statusJobResponse(job);
    }
  );

  server.registerTool(
    "get_google_reviews_batch",
    {
      title: "Get Google Maps reviews batch",
      description:
        "BATCH READ: after a scrape job is done, retrieve reviews in bounded batches instead of requesting the full JSON. Review output is de-identified: reviewer names/raw text/id fields are omitted and email addresses inside text are redacted. For analysis, read older batches first with order=oldest-first, keep internal notes with evidence, then read newer batches and make the final conclusion weighted toward recent reviews.",
      inputSchema: {
        jobId: z.string().trim().describe("The jobId returned by start_google_reviews_scrape."),
        batchIndex: z.number().int().min(1).default(1).describe("1-based batch index after applying the requested order and filters."),
        batchSize: z.number().int().min(1).max(200).default(200).describe("Reviews per batch. Maximum 200."),
        order: z.enum(["newest-first", "oldest-first"]).default("oldest-first").describe("Review order for batching. Use oldest-first when building historical-to-recent summaries."),
        ratings: z.array(z.number().int().min(1).max(5)).optional().describe("Optional rating filter, e.g. [1,2,3] for low-score reviews."),
        minLikeCount: z.number().int().min(0).optional().describe("Optional minimum likeCount/reaction count filter."),
      },
      outputSchema: scrapeBatchOutputSchema(),
    },
    async ({ jobId, batchIndex = 1, batchSize = 200, order = "oldest-first", ratings, minLikeCount }) => {
      const job = scrapeJobs.get(jobId);
      if (!job) {
        throw new Error("Unknown or expired scrape jobId. Start a new scrape only if you do not already have a valid jobId.");
      }

      return batchJobResponse(job, { batchIndex, batchSize, order, ratings, minLikeCount });
    }
  );

  return server;
}

function normalizePromptMonths(months) {
  const parsed = Number(months);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 24) {
    return "8";
  }
  return String(Math.round(parsed));
}

function buildGoogleMapsAnalysisPrompt(months) {
  const monthWindow = normalizePromptMonths(months);
  return `# Google Maps 評論分析（繁體中文）

你是一個 Google Maps 評論分析助理，適用於餐廳、飯店、景點、商店、服務場所與其他 Google Maps 地點。當使用者提供 Google Maps 連結時，請使用 Google Reviews Scraper 工具抓取最近 ${monthWindow} 個月評論，預設 months = 8。

## 分析規則

低分定義為 1–3 星評論。

請統計：
- 地點名稱
- Google 整體評分
- 最近 ${monthWindow} 個月平均評分
- 擷取評論數
- 1–3 星低分評論數
- 1–3 星低分佔比

若評論資料中有 likeCount：
- likeCount >= 2 的評論視為較重要訊號。
- 若該評論是低分，需優先納入低分原因。
- 若該評論是高分，可作為正面趨勢的重要依據。
- 若沒有 likeCount 或沒有高互動評論，不需特別說明。

## 大量評論／分批資料處理規則

若工具回傳資料過大、工具要求分批讀取，或評論數量明顯很多：
- 不要要求工具一次回傳完整 reviews JSON。
- 先用 start_google_reviews_scrape 啟動 job，接著每 10 秒用 get_google_reviews_scrape_status 等待完成；不要用會回完整 reviews 的 get_google_reviews_scrape_result 等待大型資料。
- job 完成後，使用 get_google_reviews_batch 逐批取得評論；建議 order=oldest-first、batchSize=200。
- 每批先建立內部批次筆記，不要直接輸出批次筆記給使用者。
- 每批筆記至少保留：
  - 批次範圍與日期範圍
  - 該批評論數、平均分數、1–3 星低分數與低分佔比
  - 主要低分原因與代表性 evidence
  - 常見優點與代表性 evidence
  - likeCount >= 2 的高互動評論重點
  - 疑似誘導好評／優惠換評跡象與 evidence
- 合併最終報告時，以較新的評論為主要判斷依據，較舊評論作為背景或趨勢比較。
- 若新舊批次結論衝突，需明確說明「早期評論提到 X，近期評論則顯示 Y」。
- 不要只用舊批次的摘要取代原始證據；每個重要結論至少保留可回溯的評論重點。

## 五星／打卡／優惠換評判斷

只在有明確跡象時才標註。

需要標註的跡象包含：
- 評論提到「五星好評送東西」
- 評論提到「打卡送小菜／飲料／甜點」
- 評論提到「評論 5 星享折扣」
- 評論提到「給五星送東西」
- 評論提到「結帳前被要求給好評」
- 大量 5 星短評或空白 5 星，且搭配評論指出店家要求好評
- 低分評論質疑洗評，且其他評論內容有支持跡象

若有跡象，請寫：
**疑似誘導好評／優惠換評風險：** 有評論提到「……」，因此高分評論需保留解讀。

若沒有跡象，不要寫：
- 未發現洗評
- 沒有優惠換評
- 沒有誘導好評

## 輸出格式

# **{{地點名稱}}**

> 查詢範圍：最近 ${monthWindow} 個月，約 YYYY-MM-DD 至 YYYY-MM-DD  
> 擷取評論數：N 則  
> Google 整體評分：X.X  
> 近 ${monthWindow} 個月平均評分：約 X.XX，近期評價略高於／大致相近／低於整體分數。  
> 備註：若評論數少，說明「近 ${monthWindow} 個月評論數較少，結論適合做趨勢參考。」  
> 若工具達到滾動上限或未完整到達 cutoff，需標註資料限制。  
> 若有誘導好評跡象，才加入相關備註。

---

## 低分總結

### 低分比例概況

| 項目 | 數據 |
|---|---:|
| 1–3 星低分評論 | **X 則** |
| 總評論數 | **N 則** |
| 低分佔比 | **約 Y%** |

### 主要低分原因

#### 1. 原因一
根據評論內容具體描述，不要只寫籠統結論。

#### 2. 原因二
根據評論內容具體描述。

#### 3. 原因三
根據評論內容具體描述。

---

## 整體總結

### 整體印象
說明近期評價趨勢、正負評比例、是否與 Google 整體評分一致。

### 常見優點

| 面向 | 評價重點 |
|---|---|
| 產品／體驗 | 餐點、住宿、景點、商品或服務本身的評價重點 |
| 服務 | 服務態度、處理速度、流程、入住／用餐／消費體驗 |
| 環境／設施 | 空間、清潔、氣氛、設備、房況或現場管理 |
| 便利性 | 交通、停車、訂位、排隊、入住、付款或動線 |

### 近期評價觀察
說明高分與低分之間的落差，以及實際前往、消費或入住期待。

---

## 需要注意的地方

### 前往／消費前建議

| 注意事項 | 建議 |
|---|---|
| 主要風險一 | 對應建議 |
| 主要風險二 | 對應建議 |
| 主要風險三 | 對應建議 |

---

## 結論

用一段話總結這個地點是否值得前往、消費或入住，並說明主要優勢與主要風險。

若有誘導好評跡象，需補上：
**疑似誘導好評／優惠換評風險：** 有評論提到相關優惠、贈品或要求好評，因此高分評論需保留解讀。

**適合：** 適合哪些使用者、旅客、顧客或情境。
**不太適合：** 不適合哪些使用者、旅客、顧客或情境。`;
}

function scrapeResultOutputSchema() {
  return {
    status: z.enum(["queued", "running", "done", "failed"]),
    jobId: z.string(),
    message: z.string(),
    nextPollSeconds: z.number(),
    elapsedMs: z.number(),
    log: z.array(z.string()),
    metadata: z.record(z.string(), z.unknown()).optional(),
    reviews: z.array(z.record(z.string(), z.unknown())).optional(),
    summary: z
      .object({
        placeName: z.string().nullable(),
        overallRating: z.number().nullable(),
        recentAverageRating: z.number().nullable(),
        reviewCount: z.number(),
        lowScoreCount: z.number(),
        ratingTrend: z.string(),
        ratingCounts: z.record(z.string(), z.number()),
      })
      .optional(),
  };
}

function scrapeStatusOutputSchema() {
  return {
    status: z.enum(["queued", "running", "done", "failed"]),
    jobId: z.string(),
    message: z.string(),
    nextPollSeconds: z.number(),
    elapsedMs: z.number(),
    log: z.array(z.string()),
    metadata: z.record(z.string(), z.unknown()).optional(),
    summary: z
      .object({
        placeName: z.string().nullable(),
        overallRating: z.number().nullable(),
        recentAverageRating: z.number().nullable(),
        reviewCount: z.number(),
        lowScoreCount: z.number(),
        ratingTrend: z.string(),
        ratingCounts: z.record(z.string(), z.number()),
      })
      .optional(),
    batchPlan: z
      .object({
        recommendedOrder: z.string(),
        recommendedBatchSize: z.number(),
        totalReviews: z.number(),
        totalBatches: z.number(),
        nextTool: z.string(),
      })
      .optional(),
  };
}

function scrapeBatchOutputSchema() {
  return {
    status: z.enum(["done"]),
    jobId: z.string(),
    message: z.string(),
    batch: z.object({
      index: z.number(),
      size: z.number(),
      totalBatches: z.number(),
      order: z.enum(["newest-first", "oldest-first"]),
      offset: z.number(),
      returnedCount: z.number(),
      totalFilteredReviews: z.number(),
      hasPreviousBatch: z.boolean(),
      hasNextBatch: z.boolean(),
      dateRange: z.object({
        oldest: z.string().nullable(),
        newest: z.string().nullable(),
      }),
    }),
    filters: z.object({
      ratings: z.array(z.number()).nullable(),
      minLikeCount: z.number().nullable(),
    }),
    batchStats: z.object({
      reviewCount: z.number(),
      averageRating: z.number().nullable(),
      lowScoreCount: z.number(),
      ratingCounts: z.record(z.string(), z.number()),
      highInteractionCount: z.number(),
    }),
    reviews: z.array(z.record(z.string(), z.unknown())),
  };
}

function createJobKey({ url, months, maxScrolls }) {
  return JSON.stringify({
    url: String(url).trim(),
    months: Number(months),
    maxScrolls: Number(maxScrolls),
  });
}

function createScrapeJob({ url, months, maxScrolls }) {
  cleanupFinishedJobs();
  const key = createJobKey({ url, months, maxScrolls });
  const existingId = jobsByKey.get(key);
  const existingJob = existingId ? scrapeJobs.get(existingId) : null;
  if (existingJob) {
    return existingJob;
  }

  const id = crypto.randomUUID();
  const outputDir = path.join(JOBS_DIR, id);
  const job = {
    id,
    key,
    status: "queued",
    url,
    months,
    maxScrolls,
    outputDir,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    log: [],
    error: null,
    result: null,
    promise: null,
  };

  scrapeJobs.set(id, job);
  jobsByKey.set(key, id);
  job.promise = scrapeQueue.then(() => runScrapeJob(job));
  scrapeQueue = job.promise.catch(() => {});
  return job;
}

async function runScrapeJob(job) {
  job.status = "running";
  job.startedAt = Date.now();
  await fs.mkdir(job.outputDir, { recursive: true });

  const args = [
    SCRAPE_SCRIPT,
    "--url",
    job.url,
    "--months",
    String(job.months),
    "--max-scrolls",
    String(job.maxScrolls),
    "--output-dir",
    job.outputDir,
    "--browser-channel",
    process.env.BROWSER_CHANNEL || "chrome",
    "--profile-dir",
    process.env.PROFILE_DIR || "./chrome-profile",
    "--locale",
    process.env.LOCALE || "zh-TW",
    "--timezone",
    process.env.TIMEZONE || "Asia/Taipei",
    "--headless-compat",
    "--fast",
    "--review-retries",
    "1",
    "--scroll-delay-ms",
    "1800",
    "--poll-interval-ms",
    "80",
    "--stale-scroll-limit",
    "6",
    "--scroll-step-multiplier",
    "2.2",
  ];

  const child = spawn(process.execPath, args, {
    cwd: __dirname,
    env: {
      ...process.env,
      HEADLESS: process.env.HEADLESS || "true",
    },
  });

  let timedOut = false;
  let forceKillTimeout = null;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceKillTimeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  }, SCRAPE_TIMEOUT_MS);

  child.stdout.on("data", (chunk) => appendLog(job.log, chunk));
  child.stderr.on("data", (chunk) => appendLog(job.log, chunk));

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  }).finally(() => {
    clearTimeout(timeout);
    if (forceKillTimeout) {
      clearTimeout(forceKillTimeout);
    }
  });
  await cleanupProfileCache(process.env.PROFILE_DIR || "./chrome-profile", job.log);

  if (exitCode !== 0) {
    if (await loadCompletedResult(job)) {
      appendLog(job.log, `Scraper exited with code ${exitCode}, but reviews.json was completed and loaded.`);
      job.status = "done";
      job.finishedAt = Date.now();
      await cleanupJobFiles(job);
      return;
    }

    const reason = timedOut ? `Scraper timed out after ${Math.round(SCRAPE_TIMEOUT_MS / 1000)}s.` : `Scraper failed with exit code ${exitCode}.`;
    job.status = "failed";
    job.error = `${reason} ${lastLogLines(job.log)}`;
    job.finishedAt = Date.now();
    return;
  }

  const jsonPath = path.join(job.outputDir, "reviews.json");
  if (await loadCompletedResult(job)) {
    job.status = "done";
    await cleanupJobFiles(job);
  } else {
    job.status = "failed";
    job.error = "Scraper completed but reviews.json could not be read.";
  }
  job.finishedAt = Date.now();
}

async function loadCompletedResult(job) {
  const jsonPath = path.join(job.outputDir, "reviews.json");
  try {
    job.result = JSON.parse(await fs.readFile(jsonPath, "utf8"));
    return true;
  } catch (_error) {
    return false;
  }
}

async function cleanupJobFiles(job) {
  if (KEEP_JOB_FILES) {
    return;
  }

  await fs.rm(job.outputDir, { recursive: true, force: true }).catch((error) => {
    appendLog(job.log, `Could not remove job files: ${error.message}`);
  });
}

async function cleanupProfileCache(profileDir, log) {
  if (process.env.CLEAN_PROFILE_CACHE === "false") {
    return;
  }

  const root = path.resolve(__dirname, profileDir);
  for (const relativePath of PROFILE_CACHE_PATHS) {
    const target = path.resolve(root, relativePath);
    if (!target.startsWith(`${root}${path.sep}`)) {
      continue;
    }

    await fs.rm(target, { recursive: true, force: true }).catch((error) => {
      appendLog(log, `Could not clean profile cache ${relativePath}: ${error.message}`);
    });
  }
}

function elapsedMs(job) {
  return (job.finishedAt || Date.now()) - job.createdAt;
}

function baseJobContent(job, message) {
  return {
    status: job.status,
    jobId: job.id,
    message,
    nextPollSeconds: job.status === "done" || job.status === "failed" ? 0 : 10,
    elapsedMs: elapsedMs(job),
    log: job.log.slice(-20),
  };
}

function startJobResponse(job) {
  const message =
    job.status === "done"
      ? `Scrape job ${job.id} is already done. For large places, call get_google_reviews_batch with this jobId to retrieve reviews in batches.`
      : `Scrape job ${job.id} is ${job.status}. Wait 10 seconds, then call get_google_reviews_scrape_status with this same jobId. Do not start another job for the same URL unless this job fails.`;
  const structuredContent = baseJobContent(job, message);

  return {
    structuredContent,
    content: [{ type: "text", text: message }],
  };
}

function resultJobResponse(job) {
  if (job.status === "done") {
    const structured = toStructuredContent(job.result);
    const message = `Scraped ${structured.summary.reviewCount} reviews for ${structured.summary.placeName || "the place"}.`;
    const structuredContent = {
      ...baseJobContent(job, message),
      ...structured,
    };

    return {
      structuredContent,
      content: [
        {
          type: "text",
          text:
            `${message} ` +
            "Use the structured review JSON to summarize positives, negatives, food/service risks, rating trend, and notable low-score themes.",
        },
      ],
    };
  }

  if (job.status === "failed") {
    const message = job.error || "Scrape job failed.";
    return {
      structuredContent: baseJobContent(job, message),
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }

  const message =
    `Scrape job ${job.id} is ${job.status}. ` +
    "Do not call start_google_reviews_scrape again. Wait 10 seconds, then call get_google_reviews_scrape_result with this same jobId.";
  return {
    structuredContent: baseJobContent(job, message),
    content: [{ type: "text", text: message }],
  };
}

function statusJobResponse(job) {
  if (job.status === "done") {
    const structured = toStructuredContent(job.result);
    const batchSize = 200;
    const totalReviews = structured.reviews.length;
    const totalBatches = Math.max(1, Math.ceil(totalReviews / batchSize));
    const message =
      `Scrape job ${job.id} is done with ${totalReviews} reviews for ${structured.summary.placeName || "the place"}. ` +
      "For large review sets, call get_google_reviews_batch instead of get_google_reviews_scrape_result.";
    const structuredContent = {
      ...baseJobContent(job, message),
      metadata: structured.metadata,
      summary: structured.summary,
      batchPlan: {
        recommendedOrder: "oldest-first",
        recommendedBatchSize: batchSize,
        totalReviews,
        totalBatches,
        nextTool: "get_google_reviews_batch",
      },
    };

    return {
      structuredContent,
      content: [{ type: "text", text: message }],
    };
  }

  if (job.status === "failed") {
    const message = job.error || "Scrape job failed.";
    return {
      structuredContent: baseJobContent(job, message),
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }

  const message =
    `Scrape job ${job.id} is ${job.status}. ` +
    "Do not call start_google_reviews_scrape again. Wait 10 seconds, then call get_google_reviews_scrape_status with this same jobId.";
  return {
    structuredContent: baseJobContent(job, message),
    content: [{ type: "text", text: message }],
  };
}

function batchJobResponse(job, options) {
  if (job.status !== "done") {
    throw new Error(
      `Scrape job ${job.id} is ${job.status}. Wait 10 seconds, then call get_google_reviews_scrape_status before reading batches.`
    );
  }

  const structured = toStructuredContent(job.result, { sanitizeReviews: false });
  const allReviews = filterBatchReviews(structured.reviews, options);
  const orderedReviews = options.order === "oldest-first" ? [...allReviews].reverse() : [...allReviews];
  const batchSize = Math.min(Math.max(Number(options.batchSize) || 200, 1), 200);
  const totalBatches = Math.max(1, Math.ceil(orderedReviews.length / batchSize));
  const batchIndex = Math.min(Math.max(Number(options.batchIndex) || 1, 1), totalBatches);
  const offset = (batchIndex - 1) * batchSize;
  const reviews = orderedReviews.slice(offset, offset + batchSize);
  const batchStats = summarizeReviews(reviews);
  const dateRange = reviewDateRange(reviews);
  const responseReviews = sanitizeReviewsForResponse(reviews, offset);
  const message =
    `Returned batch ${batchIndex}/${totalBatches} with ${reviews.length} reviews ` +
    `(${options.order}, ${orderedReviews.length} filtered reviews total).`;

  return {
    structuredContent: {
      status: "done",
      jobId: job.id,
      message,
      batch: {
        index: batchIndex,
        size: batchSize,
        totalBatches,
        order: options.order,
        offset,
        returnedCount: reviews.length,
        totalFilteredReviews: orderedReviews.length,
        hasPreviousBatch: batchIndex > 1,
        hasNextBatch: batchIndex < totalBatches,
        dateRange,
      },
      filters: {
        ratings: Array.isArray(options.ratings) && options.ratings.length > 0 ? options.ratings : null,
        minLikeCount: Number.isFinite(options.minLikeCount) ? options.minLikeCount : null,
      },
      batchStats,
      reviews: responseReviews,
    },
    content: [
      {
        type: "text",
        text:
          `${message} Create internal notes for this batch, preserve representative evidence, ` +
          "then request the next batch if hasNextBatch=true.",
      },
    ],
  };
}

function filterBatchReviews(reviews, options) {
  const ratingSet = Array.isArray(options.ratings) && options.ratings.length > 0
    ? new Set(options.ratings.map(Number))
    : null;
  const minLikeCount = Number.isFinite(options.minLikeCount) ? Number(options.minLikeCount) : null;

  return reviews.filter((review) => {
    if (ratingSet && !ratingSet.has(Number(review.rating))) {
      return false;
    }

    if (minLikeCount !== null && reviewLikeCount(review) < minLikeCount) {
      return false;
    }

    return true;
  });
}

function summarizeReviews(reviews) {
  const ratingCounts = {};
  let ratingTotal = 0;
  let ratedCount = 0;
  let lowScoreCount = 0;
  let highInteractionCount = 0;

  for (const review of reviews) {
    const rating = Number(review.rating);
    if (Number.isFinite(rating)) {
      const key = String(rating);
      ratingCounts[key] = (ratingCounts[key] || 0) + 1;
      ratingTotal += rating;
      ratedCount += 1;
      if (rating >= 1 && rating <= 3) {
        lowScoreCount += 1;
      }
    } else {
      ratingCounts.unknown = (ratingCounts.unknown || 0) + 1;
    }

    if (reviewLikeCount(review) >= 2) {
      highInteractionCount += 1;
    }
  }

  return {
    reviewCount: reviews.length,
    averageRating: ratedCount > 0 ? ratingTotal / ratedCount : null,
    lowScoreCount,
    ratingCounts,
    highInteractionCount,
  };
}

function reviewLikeCount(review) {
  const value = review.likeCount ?? review.reactionCount ?? review.likes;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function reviewDateRange(reviews) {
  const dates = reviews
    .map((review) => String(review.date || "").trim())
    .filter(Boolean)
    .sort();

  return {
    oldest: dates[0] || null,
    newest: dates[dates.length - 1] || null,
  };
}

const REVIEW_PRIVATE_FIELDS = new Set([
  "author",
  "email",
  "id",
  "name",
  "raw",
  "reviewer",
  "reviewerName",
]);

function sanitizeReviewsForResponse(reviews, offset = 0) {
  return reviews.map((review, index) => {
    const sanitized = {
      reviewNumber: offset + index + 1,
    };

    for (const [key, value] of Object.entries(review || {})) {
      if (REVIEW_PRIVATE_FIELDS.has(key)) {
        continue;
      }

      sanitized[key] = sanitizeValueForResponse(value);
    }

    return sanitized;
  });
}

function sanitizeValueForResponse(value) {
  if (typeof value === "string") {
    return redactEmails(value);
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeValueForResponse);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !REVIEW_PRIVATE_FIELDS.has(key))
        .map(([key, nestedValue]) => [key, sanitizeValueForResponse(nestedValue)])
    );
  }

  return value;
}

function redactEmails(value) {
  return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]");
}

function cleanupFinishedJobs() {
  const cutoff = Date.now() - FINISHED_JOB_TTL_MS;
  for (const [id, job] of scrapeJobs) {
    if (job.finishedAt && job.finishedAt < cutoff) {
      scrapeJobs.delete(id);
      if (jobsByKey.get(job.key) === id) {
        jobsByKey.delete(job.key);
      }
    }
  }
}

function appendLog(log, chunk) {
  log.push(...chunk.toString().split(/\r?\n/).filter(Boolean));
  if (log.length > MAX_JOB_LOG_LINES) {
    log.splice(0, log.length - MAX_JOB_LOG_LINES);
  }
}

function lastLogLines(log) {
  return log.slice(-12).join(" ");
}

function toStructuredContent(data, { sanitizeReviews = true } = {}) {
  const metadata = data.metadata || {};
  const summary = metadata.summary || {};
  const ratingComparison = metadata.ratingComparison || {};
  const reviews = Array.isArray(data.reviews) ? data.reviews : [];

  return {
    metadata,
    reviews: sanitizeReviews ? sanitizeReviewsForResponse(reviews) : reviews,
    summary: {
      placeName: metadata.placeName || null,
      overallRating: numberOrNull(metadata.overallRating),
      recentAverageRating: numberOrNull(summary.averageRating),
      reviewCount: Number(summary.reviewCount ?? metadata.reviewCount ?? 0),
      lowScoreCount: Number(summary.lowScoreCount ?? 0),
      ratingTrend: String(ratingComparison.direction || "unknown"),
      ratingCounts: summary.ratingCounts || {},
    },
  };
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function isAuthorized(req) {
  if (!SHARED_SECRET) {
    return true;
  }

  const authHeader = String(req.headers.authorization || "");
  const bearerToken = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  return bearerToken === SHARED_SECRET || req.params.token === SHARED_SECRET;
}

async function handleMcpRequest(req, res) {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
}

const app = createMcpExpressApp({
  host: HOST,
  allowedHosts: ALLOWED_HOSTS,
});

app.get("/", (_req, res) => {
  res.json({
    name: "google-review-scraper-mcp",
    status: "ok",
    mcpEndpoint: SHARED_SECRET ? "/mcp/<secret> or /mcp with Authorization: Bearer <secret>" : "/mcp",
  });
});

app.post("/mcp", handleMcpRequest);
app.post("/mcp/:token", handleMcpRequest);

for (const route of ["/mcp", "/mcp/:token"]) {
  app.get(route, (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed. Use POST with Streamable HTTP.",
      },
      id: null,
    });
  });
  app.delete(route, (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    });
  });
}

app.listen(PORT, HOST, (error) => {
  if (error) {
    console.error("Failed to start MCP server:", error);
    process.exit(1);
  }

  if (!SHARED_SECRET) {
    console.warn("MCP_SHARED_SECRET is not set. The MCP endpoint is unauthenticated.");
  }
  console.log(`Google review scraper MCP server listening on http://${HOST}:${PORT}/mcp`);
});
