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
    "google_restaurant_review_analysis_zh_tw",
    {
      title: "Google 餐廳評論分析（繁體中文）",
      description:
        "Analyze recent Google Maps restaurant reviews in Traditional Chinese. Use the Google Reviews Scraper background job tools, defaulting to the most recent 8 months.",
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
            text: buildRestaurantAnalysisPrompt(months),
          },
        },
      ],
    })
  );

  server.registerTool(
    "start_google_reviews_scrape",
    {
      title: "Start Google Maps review scrape",
      description:
        "START ONLY: create a background Google Maps review scrape job and return a jobId. Do not expect reviews from this tool. If the same url/months/maxScrolls job is already queued, running, or recently finished, this returns the existing jobId instead of starting a duplicate. After calling this tool, wait 10 seconds before calling get_google_reviews_scrape_result. If get_google_reviews_scrape_result returns status=queued or status=running, do not call this start tool again; wait 10 seconds and poll the same jobId.",
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
        "POLL ONLY: retrieve the status or completed JSON for a jobId returned by start_google_reviews_scrape. Call this only after waiting 10 seconds after start or after a previous queued/running response. If status=queued or status=running, do not call start_google_reviews_scrape again; wait 10 seconds and call this result tool again with the same jobId. Only when status=done should the reviews be summarized.",
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

  return server;
}

function normalizePromptMonths(months) {
  const parsed = Number(months);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 24) {
    return "8";
  }
  return String(Math.round(parsed));
}

function buildRestaurantAnalysisPrompt(months) {
  const monthWindow = normalizePromptMonths(months);
  return `# Google 餐廳評論分析（繁體中文）

你是一個 Google Maps 餐廳評論分析助理。當使用者提供 Google Maps 連結時，請使用 Google Reviews Scraper 工具抓取最近 ${monthWindow} 個月評論，預設 months = 8。

## 分析規則

低分定義為 1–3 星評論。

請統計：
- 店家名稱
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

# **{{店家名稱}}**

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
| 餐點 | 常被稱讚的餐點或口味 |
| 服務 | 服務態度、出餐速度、流程 |
| 環境 | 空間、清潔、氣氛 |
| 便利性 | 停車、訂位、聚餐適合度 |

### 近期評價觀察
說明高分與低分之間的落差，以及實際用餐期待。

---

## 需要注意的地方

### 用餐前建議

| 注意事項 | 建議 |
|---|---|
| 主要風險一 | 對應建議 |
| 主要風險二 | 對應建議 |
| 主要風險三 | 對應建議 |

---

## 結論

用一段話總結這家店是否值得去、主要優勢與主要風險。

若有誘導好評跡象，需補上：
**疑似誘導好評／優惠換評風險：** 有評論提到相關優惠、贈品或要求好評，因此高分評論需保留解讀。

**適合：** 適合哪些顧客。  
**不太適合：** 不適合哪些顧客。`;
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
      ? `Scrape job ${job.id} is already done. Call get_google_reviews_scrape_result with this jobId to retrieve the review JSON.`
      : `Scrape job ${job.id} is ${job.status}. Wait 10 seconds, then call get_google_reviews_scrape_result with this same jobId. Do not start another job for the same URL unless this job fails.`;
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

function toStructuredContent(data) {
  const metadata = data.metadata || {};
  const summary = metadata.summary || {};
  const ratingComparison = metadata.ratingComparison || {};

  return {
    metadata,
    reviews: Array.isArray(data.reviews) ? data.reviews : [],
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
