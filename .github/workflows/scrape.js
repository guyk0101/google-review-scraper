const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: "zh-TW" });

  await page.goto("https://maps.app.goo.gl/9reuxTCd4JDsUdoq6?g_st=ic", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(8000);
  console.log(await page.title());

  await page.screenshot({ path: "maps-test.png", fullPage: true });

  await browser.close();
})();
