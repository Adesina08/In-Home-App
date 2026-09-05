require("dotenv").config();
const express = require("express");
require("express-async-errors");
const session = require("express-session");
const { MongoStore } = require("connect-mongo");
const path = require("path");
const multer = require("multer");
const fs = require("fs");

const store = require("./lib/store");
const { requireLogin } = require("./lib/auth");
const { icon } = require("./lib/icons");
const { renderPipeHtml } = require("./lib/piping");
const { CATEGORIES, formatCategories } = require("./lib/categories");
const { STUDY_TABS, studyTabHref, studyTabNeighbours } = require("./lib/studyTabs");
const { getMediaUrl } = require("./lib/mediaStorage");
const { ensureDemoSuperadmin } = require("./lib/demoSuperadmin");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const uploadsRoot = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
app.use("/uploads", express.static(uploadsRoot));
app.use("/public", express.static(path.join(__dirname, "public")));
// Keep serving the retirement worker for browsers that installed the old PWA.
// New pages no longer register it; existing registrations fetch this once and
// unregister themselves.
app.get("/sw.js", (req, res) => res.sendFile(path.join(__dirname, "public", "sw.js")));

const isProduction = process.env.NODE_ENV === "production";
if (isProduction) app.set("trust proxy", 1);

const sessionStore = process.env.MONGODB_URI
  ? MongoStore.create({
      mongoUrl: process.env.MONGODB_URI,
      dbName: process.env.MONGODB_DB || "inicio",
      collectionName: "sessions",
      ttl: 8 * 60 * 60,
      autoRemove: "interval",
      autoRemoveInterval: 10,
    })
  : undefined;

app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-only-insecure-secret-change-me",
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: { maxAge: 8 * 60 * 60 * 1000, secure: isProduction },
  })
);

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.currentPath = req.path;
  next();
});

if (!fs.existsSync(uploadsRoot)) fs.mkdirSync(uploadsRoot, { recursive: true });
const upload = multer({ dest: uploadsRoot, limits: { fileSize: 8 * 1024 * 1024 } });
app.locals.upload = upload;
app.locals.icon = icon;
app.locals.renderPipeHtml = renderPipeHtml;
app.locals.CATEGORIES = CATEGORIES;
app.locals.formatCategories = formatCategories;
app.locals.STUDY_TABS = STUDY_TABS;
app.locals.studyTabHref = studyTabHref;
app.locals.studyTabNeighbours = studyTabNeighbours;
app.locals.mediaUrl = (filePath) => {
  try { return getMediaUrl(filePath); } catch (e) { return null; }
};

app.get("/", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  const role = req.session.user.role;
  if (role === "superadmin" || role === "admin" || role === "research") return res.redirect("/admin");
  if (role === "interviewer") return res.redirect("/interviewer");
  if (role === "client") return res.redirect("/client");
  return res.redirect("/login");
});

app.use("/", require("./routes/auth"));

// A temporary password grants access to exactly one screen: the one that
// replaces it. Checked on every request rather than only at sign-in, because
// redirecting once at login leaves the admin-known password fully usable to
// anyone who then types a URL directly.
app.use((req, res, next) => {
  if (!req.session.mustChangePassword) return next();
  if (req.path === "/change-password" || req.path === "/logout") return next();
  if (req.path.startsWith("/public")) return next();
  return res.redirect("/change-password");
});
// These exact invitation-sharing endpoints are mounted before the older staff
// routers so first-time links and QR codes always enter /invite/:token.
// NOTE: no `requireLogin` on the mount itself. `app.use("/", mw, router)` runs
// `mw` for every request under "/", which is every request in the app -- it
// would push /join, /invite, /r, /me and /mobile behind the staff login page.
// These four endpoints guard themselves individually inside the router.
app.use("/", require("./routes/invitationLinks"));
// Superadmin routes are mounted before the general Admin router so their
// platform-only endpoints are resolved directly and never confused with a
// normal Admin route.
app.use("/admin", requireLogin, require("./routes/superadmin"));
app.use("/admin", requireLogin, require("./routes/admin"));
app.use("/interviewer", requireLogin, require("./routes/interviewer"));
app.use("/client", requireLogin, require("./routes/client"));

app.get("/help", requireLogin, (req, res) => {
  const helpContent = require("./lib/helpContent");
  const content = helpContent[req.session.user.role] || helpContent.admin;
  res.render("help", { content, user: req.session.user, currentPath: "/help" });
});

// Public study-code links enter the full remote-onboarding journey:
//   welcome/brief -> consent -> profile -> [OTP] -> tutorial -> activate
//
// The OTP step is skipped while RESPONDENT_OTP_BYPASS is on (its default) --
// see lib/respondentOtpMode.js. The verification code is written and tested;
// it is only bypassed because outbound messaging is not configured yet. Set
// RESPONDENT_OTP_BYPASS=false in Azure once Twilio is live.
app.use("/join", require("./routes/join"));
// joinEntryBridge sent /join/:code straight to /invite/:token/presurvey,
// skipping the study brief, the consent step and contact verification. It is
// left mounted AFTER routes/join so its behaviour is preserved for anything
// that reaches it, but routes/join now answers /join/:code first.
app.use("/join", require("./routes/joinEntryBridge"));
// The first invitation step is isolated from the full diary questionnaire so
// unrelated diary configuration cannot take down public onboarding.
app.use("/invite", require("./routes/invitePresurvey"));
// Completed Mobile App invitations are intercepted here so a browser never
// renders the installed-app login page. Unfinished invitations fall through
// to the normal setup state machine below.
app.use("/invite", require("./routes/inviteAppHandoff"));
app.use("/invite", require("./routes/invite"));
// The mobile API is a stateless bearer-token API meant to be called by the
// installed app (and, for local web-preview testing, `expo start --web` on a
// different origin) -- unlike the session-cookie web admin routes, an open
// CORS policy here carries no CSRF-style risk, so this is safe unconditionally.
app.use("/mobile/api", (req, res, next) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use("/mobile", require("./routes/mobile"));
app.use("/me", require("./routes/me"));
// Product-level logging rules live in this small guard so legacy URLs cannot
// re-enable the retired standalone Audio mode. Audio remains available as a
// question type inside Standard and is transcribed by the respondent route.
app.use("/r", require("./routes/respondentLoggingModes"));
app.use("/r", require("./routes/respondent"));

function isPublicRespondentPath(req) {
  return /^\/(join|invite|mobile|r)(\/|$)/.test(req.path || "");
}

app.use((req, res) => {
  res.status(404).render("error", {
    message: "Page not found.",
    user: isPublicRespondentPath(req) ? null : (req.session.user || null),
  });
});

app.use((err, req, res, next) => {
  console.error("Unhandled request error:", err);
  if (res.headersSent) return next(err);
  res.status(500).render("error", {
    message: "Something went wrong on our end. Please try again — your progress up to the last save/submit is safe.",
    // Never leak the staff portal chrome into respondent onboarding just
    // because an Admin/Superadmin happens to preview the public link in the
    // same browser session.
    user: isPublicRespondentPath(req) ? null : ((req.session && req.session.user) || null),
  });
});

process.on("unhandledRejection", (reason) => console.error("UNHANDLED PROMISE REJECTION (did not crash the process):", reason));
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION — exiting so the process supervisor can restart cleanly:", err);
  process.exit(1);
});

store.connect().then(async () => {
  if (store.driverName === "local") {
    console.warn("WARNING: MONGODB_URI is not set, so this instance is running on the local JSON store. Set MONGODB_URI for any real deployment.");
  } else {
    console.log("Connected to MongoDB.");
  }

  // The known demo Superadmin credential is only created when the database
  // already contains the seeded demo Admin account. Real production databases
  // without admin@inicio.demo are left untouched.
  await ensureDemoSuperadmin();

  app.listen(PORT, () => {
    console.log(`Inicio Diary running on http://localhost:${PORT}`);
    require("./lib/scheduler").start();
  });
}).catch((e) => {
  console.error("Could not open the database, so the app did not start:", e.message);
  process.exit(1);
});
