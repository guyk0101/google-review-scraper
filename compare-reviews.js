const fs = require("fs");
const path = require("path");

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

function usage() {
  console.error("Usage: node compare-reviews.js <baseline-reviews.json> <candidate-reviews.json>");
  process.exit(2);
}

const [baselinePath, candidatePath] = process.argv.slice(2);
if (!baselinePath || !candidatePath) {
  usage();
}

const baseline = toMap(readReviews(path.resolve(baselinePath)));
const candidate = toMap(readReviews(path.resolve(candidatePath)));

const missingFromCandidate = [...baseline.keys()].filter((key) => !candidate.has(key));
const extraInCandidate = [...candidate.keys()].filter((key) => !baseline.has(key));

console.log(`Baseline reviews: ${baseline.size}`);
console.log(`Candidate reviews: ${candidate.size}`);
console.log(`Missing from candidate: ${missingFromCandidate.length}`);
console.log(`Extra in candidate: ${extraInCandidate.length}`);

if (missingFromCandidate.length > 0) {
  console.log("\nMissing review IDs/keys:");
  for (const key of missingFromCandidate) {
    const review = baseline.get(key);
    console.log(`- ${review.rating ?? "?"} stars | ${review.dateText || "no date"} | ${review.author || "unknown"} | ${key}`);
  }
}

if (extraInCandidate.length > 0) {
  console.log("\nExtra review IDs/keys:");
  for (const key of extraInCandidate) {
    const review = candidate.get(key);
    console.log(`- ${review.rating ?? "?"} stars | ${review.dateText || "no date"} | ${review.author || "unknown"} | ${key}`);
  }
}

process.exit(missingFromCandidate.length === 0 ? 0 : 1);
