const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SCRAPE_SCRIPT = path.join(__dirname, "scrape.js");

function parseArgs(argv) {
  const options = {
    outputDir: "output-verify-fast",
    passThrough: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--output-dir" && next) {
      options.outputDir = next;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      options.passThrough.push(arg);
      if (next && !next.startsWith("--")) {
        options.passThrough.push(next);
        i += 1;
      }
    }
  }

  if (!options.passThrough.includes("--url") && !process.env.GOOGLE_MAPS_URL) {
    throw new Error("Missing --url. Example: npm run verify-fast -- --url https://maps.app.goo.gl/...");
  }

  return options;
}

function printHelp() {
  console.log(`
Usage:
  node verify-fast.js --url <google-maps-url> [scrape options]

Runs a conservative baseline scrape, then an adaptive fast scrape, then compares
review IDs. The command exits with code 1 if fast misses any baseline reviews.

Options:
  --output-dir <path>  Parent directory for baseline/fast outputs. Default: output-verify-fast

All other options are forwarded to scrape.js, except output and speed options
that verify-fast controls for the two runs.
`);
}

function stripControlledArgs(args) {
  const controlledWithValues = new Set([
    "--output-dir",
    "--scroll-delay-ms",
    "--poll-interval-ms",
    "--stale-scroll-limit",
    "--scroll-step-multiplier",
    "--page-settle-ms",
  ]);
  const controlledFlags = new Set(["--fast", "--wait-networkidle"]);
  const result = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (controlledWithValues.has(arg)) {
      i += 1;
      continue;
    }
    if (controlledFlags.has(arg)) {
      continue;
    }
    result.push(arg);
  }

  return result;
}

function runNode(args, label) {
  console.log(`\n=== ${label} ===`);
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: __dirname,
    env: process.env,
    stdio: "inherit",
  });
  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`=== ${label} completed in ${elapsedSeconds}s ===`);

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function readReviews(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return data.reviews || [];
}

function reviewKey(review, index) {
  return review.id || `${review.author}\n${review.rating}\n${review.dateText}\n${review.text || review.raw}\n${index}`;
}

function toMap(reviews) {
  const map = new Map();
  reviews.forEach((review, index) => {
    map.set(reviewKey(review, index), review);
  });
  return map;
}

function compare(baselinePath, fastPath) {
  const baseline = toMap(readReviews(baselinePath));
  const fast = toMap(readReviews(fastPath));
  const missingFromFast = [...baseline.keys()].filter((key) => !fast.has(key));
  const extraInFast = [...fast.keys()].filter((key) => !baseline.has(key));

  console.log("\n=== Completeness check ===");
  console.log(`Baseline reviews: ${baseline.size}`);
  console.log(`Fast reviews: ${fast.size}`);
  console.log(`Missing from fast: ${missingFromFast.length}`);
  console.log(`Extra in fast: ${extraInFast.length}`);

  if (missingFromFast.length > 0) {
    console.log("\nMissing review IDs/keys:");
    for (const key of missingFromFast) {
      const review = baseline.get(key);
      console.log(`- ${review.rating ?? "?"} stars | ${review.dateText || "no date"} | ${review.author || "unknown"} | ${key}`);
    }
    process.exit(1);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const baseArgs = stripControlledArgs(options.passThrough);
  const parentDir = path.resolve(options.outputDir);
  const baselineDir = path.join(parentDir, "baseline");
  const fastDir = path.join(parentDir, "fast");

  fs.mkdirSync(parentDir, { recursive: true });

  runNode(
    [
      SCRAPE_SCRIPT,
      ...baseArgs,
      "--output-dir",
      baselineDir,
      "--page-settle-ms",
      "2000",
      "--scroll-delay-ms",
      "3000",
      "--poll-interval-ms",
      "100",
      "--stale-scroll-limit",
      "6",
      "--scroll-step-multiplier",
      "1.3",
    ],
    "Baseline scrape"
  );

  runNode(
    [
      SCRAPE_SCRIPT,
      ...baseArgs,
      "--output-dir",
      fastDir,
      "--fast",
    ],
    "Adaptive fast scrape"
  );

  compare(path.join(baselineDir, "reviews.json"), path.join(fastDir, "reviews.json"));
}

main();
