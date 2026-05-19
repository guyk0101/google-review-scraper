const { chromium } = require("playwright");
const fs = require("fs");

const GOOGLE_MAPS_URL =
  "https://maps.app.goo.gl/9reuxTCd4JDsUdoq6?g_st=ic";

(async () => {
  const browser = await chromium.launch({
    headless: true,
  });

  const page = await browser.newPage({
    locale: "zh-TW",
  });

  console.log("Opening Google Maps...");

  await page.goto(GOOGLE_MAPS_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(8000);

  // 點評論按鈕
  console.log("Opening reviews...");

  const reviewButton = page.locator('button:has-text("評論")');

  await reviewButton.first().click();

  await page.waitForTimeout(5000);

  // 捲動評論區
  console.log("Scrolling reviews...");

  const scrollContainer = await page.locator(
    'div[role="feed"]'
  );

  for (let i = 0; i < 20; i++) {
    await scrollContainer.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });

    await page.waitForTimeout(2000);
  }

  // 擷取評論
  console.log("Extracting reviews...");

  const reviews = await page.$$eval(
    'div[data-review-id]',
    (nodes) => {
      return nodes.map((node) => {
        const text =
          node.innerText || "";

        return {
          raw: text,
        };
      });
    }
  );

  console.log("Review count:", reviews.length);

  fs.writeFileSync(
    "reviews.json",
    JSON.stringify(reviews, null, 2)
  );

  await page.screenshot({
    path: "reviews-page.png",
    fullPage: true,
  });

  await browser.close();

  console.log("Done");
})();
