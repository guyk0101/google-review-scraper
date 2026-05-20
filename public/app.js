const form = document.getElementById("scrapeForm");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const submitButton = document.getElementById("submitButton");
const downloadJson = document.getElementById("downloadJson");
const openRaw = document.getElementById("openRaw");
const copyJson = document.getElementById("copyJson");
const jobIdEl = document.getElementById("jobId");
const placeName = document.getElementById("placeName");
const reviewCount = document.getElementById("reviewCount");
const averageRating = document.getElementById("averageRating");
const overallRating = document.getElementById("overallRating");
const ratingTrend = document.getElementById("ratingTrend");
const lowScoreCount = document.getElementById("lowScoreCount");

let pollTimer = null;
let currentJob = null;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearInterval(pollTimer);
  resetResult();

  const payload = {
    url: document.getElementById("url").value.trim(),
    months: Number(document.getElementById("months").value || 6),
    maxScrolls: Number(document.getElementById("maxScrolls").value || 120),
  };

  submitButton.disabled = true;
  setStatus("queued");
  logEl.textContent = "Submitting job...\n";

  try {
    const response = await fetch("/api/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Failed to start job.");
    }

    currentJob = data;
    renderJob(data);
    pollTimer = setInterval(() => pollJob(data.id), 1500);
    await pollJob(data.id);
  } catch (error) {
    setStatus("failed");
    logEl.textContent += `${error.message}\n`;
    submitButton.disabled = false;
  }
});

copyJson.addEventListener("click", async () => {
  if (!currentJob?.rawJsonUrl) {
    return;
  }

  const response = await fetch(currentJob.rawJsonUrl);
  const text = await response.text();
  await navigator.clipboard.writeText(text);
  copyJson.textContent = "已複製";
  setTimeout(() => {
    copyJson.textContent = "複製 JSON";
  }, 1400);
});

async function pollJob(id) {
  const response = await fetch(`/api/jobs/${id}`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to poll job.");
  }

  currentJob = data;
  renderJob(data);

  if (data.status === "done" || data.status === "failed") {
    clearInterval(pollTimer);
    submitButton.disabled = false;
  }
}

function renderJob(job) {
  setStatus(job.status);
  jobIdEl.textContent = job.id ? `Job ${job.id}` : "";
  logEl.textContent = (job.log || []).join("\n");
  logEl.scrollTop = logEl.scrollHeight;

  if (job.summary) {
    placeName.textContent = job.placeName || "-";
    reviewCount.textContent = job.summary.reviewCount ?? "-";
    averageRating.textContent = Number.isFinite(job.summary.averageRating)
      ? job.summary.averageRating.toFixed(2)
      : "-";
    overallRating.textContent = Number.isFinite(job.overallRating)
      ? job.overallRating.toFixed(1)
      : "-";
    ratingTrend.textContent = formatTrend(job.ratingComparison);
    lowScoreCount.textContent = job.summary.lowScoreCount ?? "-";
  }

  if (job.status === "done") {
    enableLink(downloadJson, job.jsonUrl);
    enableLink(openRaw, job.rawJsonUrl);
    copyJson.disabled = false;
  }

  if (job.status === "failed" && job.error) {
    logEl.textContent += `\n${job.error}\n`;
  }
}

function setStatus(status) {
  statusEl.textContent = status;
  statusEl.className = `status ${status}`;
}

function enableLink(link, href) {
  link.href = href;
  link.classList.remove("disabled");
  link.setAttribute("aria-disabled", "false");
}

function formatTrend(comparison) {
  if (!comparison || comparison.direction === "unknown") {
    return "-";
  }

  const diff = Number.isFinite(comparison.difference) ? comparison.difference : 0;
  const signed = diff > 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2);
  if (comparison.direction === "higher") {
    return `Higher ${signed}`;
  }
  if (comparison.direction === "lower") {
    return `Lower ${signed}`;
  }
  return `Same ${signed}`;
}

function resetResult() {
  currentJob = null;
  placeName.textContent = "-";
  reviewCount.textContent = "-";
  averageRating.textContent = "-";
  overallRating.textContent = "-";
  ratingTrend.textContent = "-";
  lowScoreCount.textContent = "-";
  copyJson.disabled = true;
  downloadJson.href = "#";
  openRaw.href = "#";
  downloadJson.classList.add("disabled");
  openRaw.classList.add("disabled");
  downloadJson.setAttribute("aria-disabled", "true");
  openRaw.setAttribute("aria-disabled", "true");
  jobIdEl.textContent = "";
}
