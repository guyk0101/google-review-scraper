const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JOBS_DIR = path.join(__dirname, "jobs");
const SCRAPE_SCRIPT = path.join(__dirname, "scrape.js");
const PUBLIC_DIR = path.join(__dirname, "public");

const jobs = new Map();

fs.mkdirSync(JOBS_DIR, { recursive: true });

app.use(express.json({ limit: "64kb" }));
app.get("/favicon.ico", (_req, res) => res.status(204).end());
app.use(express.static(PUBLIC_DIR));

app.post("/api/scrape", (req, res) => {
  const url = String(req.body?.url || "").trim();
  const months = Number(req.body?.months || 6);
  const maxScrolls = Number(req.body?.maxScrolls || 120);

  if (!/^https:\/\/(www\.)?google\.[^/]+\/maps\//i.test(url) && !/^https:\/\/maps\.app\.goo\.gl\//i.test(url)) {
    return res.status(400).json({ error: "Please provide a Google Maps place URL." });
  }

  if (!Number.isFinite(months) || months <= 0 || months > 24) {
    return res.status(400).json({ error: "months must be between 1 and 24." });
  }

  if (!Number.isFinite(maxScrolls) || maxScrolls <= 0 || maxScrolls > 300) {
    return res.status(400).json({ error: "maxScrolls must be between 1 and 300." });
  }

  const id = crypto.randomUUID();
  const outputDir = path.join(JOBS_DIR, id);
  fs.mkdirSync(outputDir, { recursive: true });

  const job = {
    id,
    status: "queued",
    url,
    months,
    maxScrolls,
    outputDir,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    error: null,
    log: [],
    placeName: null,
    overallRating: null,
    ratingComparison: null,
    summary: null,
  };

  jobs.set(id, job);
  runScrape(job);
  res.status(202).json(publicJob(job));
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: "Job not found." });
  }

  refreshJobSummary(job);
  res.json(publicJob(job));
});

app.get("/api/jobs/:id/json", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: "Job not found." });
  }

  const jsonPath = path.join(job.outputDir, "reviews.json");
  if (!fs.existsSync(jsonPath)) {
    return res.status(404).json({ error: "reviews.json is not ready." });
  }

  res.download(jsonPath, `google-reviews-${job.id}.json`);
});

app.get("/api/jobs/:id/raw", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: "Job not found." });
  }

  const jsonPath = path.join(job.outputDir, "reviews.json");
  if (!fs.existsSync(jsonPath)) {
    return res.status(404).json({ error: "reviews.json is not ready." });
  }

  res.type("application/json").send(fs.readFileSync(jsonPath, "utf8"));
});

function runScrape(job) {
  job.status = "running";
  job.startedAt = new Date().toISOString();

  const args = [
    SCRAPE_SCRIPT,
    "--url",
    job.url,
    "--range",
    "six-months",
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
  ];

  const child = spawn(process.execPath, args, {
    cwd: __dirname,
    env: {
      ...process.env,
      HEADLESS: process.env.HEADLESS || "true",
    },
  });

  child.stdout.on("data", (chunk) => appendLog(job, chunk));
  child.stderr.on("data", (chunk) => appendLog(job, chunk));

  child.on("error", (error) => {
    job.status = "failed";
    job.error = error.message;
    job.finishedAt = new Date().toISOString();
  });

  child.on("close", (code) => {
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    refreshJobSummary(job);
    job.status = code === 0 ? "done" : "failed";
    if (code !== 0 && !job.error) {
      job.error = `Scraper exited with code ${code}.`;
    }
  });
}

function appendLog(job, chunk) {
  const text = chunk.toString();
  job.log.push(...text.split(/\r?\n/).filter(Boolean));
  if (job.log.length > 300) {
    job.log.splice(0, job.log.length - 300);
  }
}

function refreshJobSummary(job) {
  const jsonPath = path.join(job.outputDir, "reviews.json");
  if (!fs.existsSync(jsonPath)) {
    return;
  }

  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    job.placeName = data.metadata?.placeName || null;
    job.overallRating = data.metadata?.overallRating ?? null;
    job.ratingComparison = data.metadata?.ratingComparison || null;
    job.summary = data.metadata?.summary || null;
  } catch (error) {
    job.error = error.message;
  }
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    url: job.url,
    months: job.months,
    maxScrolls: job.maxScrolls,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    error: job.error,
    placeName: job.placeName,
    overallRating: job.overallRating,
    ratingComparison: job.ratingComparison,
    summary: job.summary,
    log: job.log,
    jsonUrl: job.status === "done" ? `/api/jobs/${job.id}/json` : null,
    rawJsonUrl: job.status === "done" ? `/api/jobs/${job.id}/raw` : null,
  };
}

app.listen(PORT, () => {
  console.log(`Google review scraper web app listening on http://localhost:${PORT}`);
});
