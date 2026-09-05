const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = "http://localhost:3000";
const OUT = path.join(__dirname, "screenshots");
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "Demo1234!");
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
}

async function shot(page, url, name, opts = {}) {
  await page.goto(`${BASE}${url}`, { waitUntil: "networkidle" });
  if (opts.wait) await page.waitForTimeout(opts.wait);
  await page.screenshot({ path: path.join(OUT, name), fullPage: true });
  console.log("captured", name);
}

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", headless: true });

  // ---------- Desktop pass ----------
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const db = require("./lib/db");
  const study = db.prepare("SELECT id FROM studies ORDER BY id DESC LIMIT 1").get();
  const studyId = study.id;

  // --- Admin / Research ---
  await login(page, "admin@inicio.demo");
  await shot(page, "/admin", "01-admin-ops-dashboard.png");
  await shot(page, "/admin/studies", "02-admin-studies-list.png");
  await shot(page, `/admin/studies/${studyId}`, "03-dev-console-settings-thresholds.png");
  await shot(page, `/admin/studies/${studyId}/questionnaire`, "04-dev-console-questionnaire-builder.png");
  await shot(page, `/admin/studies/${studyId}/questionnaire/upload`, "04b-dev-console-questionnaire-upload.png");

  // Upload a real CSV through the browser to capture the Review Import preview screen
  await page.setInputFiles('input[name="file"]', "/tmp/test_q.csv");
  await Promise.all([page.waitForLoadState("networkidle"), page.click('button:has-text("Upload & Parse")')]);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, "04c-dev-console-questionnaire-review-import.png"), fullPage: true });
  console.log("captured 04c-dev-console-questionnaire-review-import.png");

  await shot(page, `/admin/studies/${studyId}/skip-logic`, "05-dev-console-skip-logic.png");
  await shot(page, `/admin/studies/${studyId}/brands`, "06-dev-console-brand-sku-list.png");
  await shot(page, `/admin/studies/${studyId}/consent`, "07-dev-console-consent-wording.png");
  await shot(page, `/admin/studies/${studyId}/kpis`, "08-dev-console-client-kpis.png");
  await shot(page, `/admin/studies/${studyId}/respondents`, "09-admin-respondents-list.png");
  await shot(page, `/admin/studies/${studyId}/media`, "09b-admin-media-review.png");
  await shot(page, "/admin/qc", "10-admin-qc-worklist.png");
  await shot(page, "/admin/whatsapp-outbox", "11-admin-whatsapp-outbox.png");
  await shot(page, "/admin/users", "12-admin-users.png");

  // --- Interviewer (F2F onboarding) ---
  await login(page, "interviewer@inicio.demo");
  await shot(page, "/interviewer", "13-interviewer-dashboard.png");
  await shot(page, `/interviewer/register?study=${studyId}`, "14-interviewer-f2f-onboarding.png");

  // --- Client ---
  await login(page, "client@inicio.demo");
  await shot(page, "/client", "15-client-dashboard.png");

  // --- Respondent (token-based, no login), desktop viewport ---
  const respondent = db.prepare("SELECT unique_token FROM respondents WHERE respondent_code = 'R01-0007'").get();
  await shot(page, `/r/${respondent.unique_token}`, "16-respondent-diary-home.png");
  await shot(page, `/r/${respondent.unique_token}/diary/new`, "17-respondent-diary-mode-picker.png");
  await page.evaluate(() => localStorage.clear()).catch(() => {});
  await shot(page, `/r/${respondent.unique_token}/diary/new?mode=standard`, "17b-respondent-diary-entry-form.png");
  await shot(page, `/r/${respondent.unique_token}/diary/new?mode=video`, "17c-respondent-diary-video-capture.png");
  // Clear any local draft from the earlier mode=standard visit so the video-mode
  // screenshot isn't cluttered with an unrelated "restore banner".
  await page.evaluate(() => localStorage.clear());

  // Upload a real (tiny, fake) video through the browser to capture the AI-review-then-form screen
  await page.setInputFiles('input[name="video"]', "/tmp/test_video.mp4");
  await Promise.all([page.waitForLoadState("networkidle"), page.click('button:has-text("Analyze Video")')]);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, "17d-respondent-diary-video-analyzed-form.png"), fullPage: true });
  console.log("captured 17d-respondent-diary-video-analyzed-form.png");

  await page.evaluate(() => localStorage.clear());
  await shot(page, `/r/${respondent.unique_token}/diary/new?mode=audio`, "17e-respondent-diary-audio-mode-form.png");

  await page.close();

  // ---------- Mobile pass (installable PWA) ----------
  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    isMobile: true,
    hasTouch: true,
  });
  await shot(mobile, `/r/${respondent.unique_token}`, "18-mobile-respondent-diary-home.png");
  await shot(mobile, `/r/${respondent.unique_token}/diary/new`, "18b-mobile-respondent-diary-mode-picker.png");

  // The sticky bottom action bar is `position: fixed`, which renders mid-page as a
  // duplicated overlay in a fullPage screenshot (a Chromium/Playwright screenshot
  // quirk, not how it behaves in a real scrolling browser). Capture it correctly:
  // one true-viewport shot showing the bar pinned at the bottom, and one fullPage
  // shot of the rest of the form with the bar hidden.
  await mobile.goto(`${BASE}/r/${respondent.unique_token}/diary/new?mode=standard`, { waitUntil: "networkidle" });
  await mobile.screenshot({ path: path.join(OUT, "19-mobile-respondent-diary-entry-form.png") });
  console.log("captured 19-mobile-respondent-diary-entry-form.png");
  await mobile.evaluate(() => { document.querySelector(".sm\\:hidden.fixed")?.style.setProperty("display", "none"); });
  await mobile.screenshot({ path: path.join(OUT, "19b-mobile-respondent-diary-entry-form-full.png"), fullPage: true });
  console.log("captured 19b-mobile-respondent-diary-entry-form-full.png");
  await mobile.close();

  await browser.close();
  console.log("Done. Screenshots in", OUT);
})();
