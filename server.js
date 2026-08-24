require("dotenv").config();
const express = require("express");
// Express 4 does NOT forward a rejected promise from an async route handler
// to the error-handling middleware -- an uncaught throw inside `async (req,
// res) => {...}` becomes an unhandled promise rejection, which crashes the
// ENTIRE Node process (Node's default behavior since v15), taking the app
// down for every concurrent user over one bad request. This one-line patch
// (must load before any routes are registered) makes every async handler's
// rejection flow into the error middleware below like a normal thrown error,
// which is what actually happens in Express 5 natively. See PRODUCTION_READINESS.md.
require("express-async-errors");
const session = require("express-session");
const path = require("path");
const multer = require("multer");
const fs = require("fs");

const db = require("./lib/db");
const { requireLogin } = require("./lib/auth");
const { icon } = require("./lib/icons");
const { getMediaUrl } = require("./lib/mediaStorage");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// UPLOAD_DIR lets a deployment point local-disk media storage at a durable
// path (e.g. Azure App Service's persisted /home mount) instead of the app's
// own ephemeral local disk -- irrelevant if STORAGE_PROVIDER=azure_blob is
// used instead (the recommended production setting, see the Azure
// Deployment Runbook), but a zero-new-dependency fallback if not.
const uploadsRoot = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
app.use("/uploads", express.static(uploadsRoot));
app.use("/public", express.static(path.join(__dirname, "public")));
// Served at the root so the default service worker scope covers the whole
// origin (SW scope defaults to the directory the script is served from).
app.get("/sw.js", (req, res) => res.sendFile(path.join(__dirname, "public", "sw.js")));

// Azure App Service (and most PaaS hosts) always terminate HTTPS at the
// platform edge and forward plain HTTP internally to the app -- Express
// can't see the original "https" scheme unless it trusts the proxy's
// X-Forwarded-Proto header, and the session cookie can't safely require
// "secure" until that's true (otherwise no cookie would ever get set, since
// Express would think every request arrived over plain HTTP). Set
// NODE_ENV=production in App Settings once deployed for real (see the Azure
// Deployment Runbook / PRODUCTION_READINESS.md B2/B5) to turn both on;
// local/dev runs are unaffected and keep working over plain HTTP.
const isProduction = process.env.NODE_ENV === "production";
if (isProduction) app.set("trust proxy", 1);
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-only-insecure-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 8 * 60 * 60 * 1000,
      secure: isProduction,
    },
  })
);

// make current user + flash-ish query messages available to all views
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.currentPath = req.path;
  next();
});

if (!fs.existsSync(uploadsRoot)) fs.mkdirSync(uploadsRoot, { recursive: true });
const upload = multer({ dest: uploadsRoot, limits: { fileSize: 8 * 1024 * 1024 } });
app.locals.upload = upload;
app.locals.icon = icon;
// Resolves a stored media file_path ("/uploads/..." or "azureblob://...") to
// a URL a browser can actually load right now — a short-lived signed URL in
// Blob-storage mode. Wrapped so one misconfigured/expired storage credential
// can't 500 an entire Media Review page full of rows; views should treat a
// null return as "link unavailable" rather than render a broken <a href>.
app.locals.mediaUrl = (filePath) => {
  try {
    return getMediaUrl(filePath);
  } catch (e) {
    return null;
  }
};

app.get("/", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  const role = req.session.user.role;
  if (role === "admin" || role === "research") return res.redirect("/admin");
  if (role === "interviewer") return res.redirect("/interviewer");
  if (role === "client") return res.redirect("/client");
  return res.redirect("/login");
});

app.use("/", require("./routes/auth"));
app.use("/admin", requireLogin, require("./routes/admin"));
app.use("/interviewer", requireLogin, require("./routes/interviewer"));
app.use("/client", requireLogin, require("./routes/client"));

// Plain-language "how do I use this page" guide, one per staff role -- same
// content that's compiled into public/docs/INICIO-User-Guide.docx (see
// lib/helpContent.js, the single source both are built from).
app.get("/help", requireLogin, (req, res) => {
  const helpContent = require("./lib/helpContent");
  const content = helpContent[req.session.user.role] || helpContent.admin;
  res.render("help", { content, user: req.session.user, currentPath: "/help" });
});

app.use("/r", require("./routes/respondent")); // token-based, no session login

app.use((req, res) => {
  res.status(404).render("error", { message: "Page not found.", user: req.session.user || null });
});

// Final safety net: catches anything that reaches Express's error path --
// a synchronous throw in a plain handler, an explicit next(err) call, or
// (thanks to express-async-errors above) a rejected promise from an async
// handler. Renders the same error.ejs used everywhere else instead of
// leaking a stack trace or crashing. Must be defined LAST and take exactly
// 4 arguments -- that's how Express recognizes an error-handling middleware.
app.use((err, req, res, next) => {
  console.error("Unhandled request error:", err);
  if (res.headersSent) return next(err);
  res.status(500).render("error", {
    message: "Something went wrong on our end. Please try again — your progress up to the last save/submit is safe.",
    user: (req.session && req.session.user) || null,
  });
});

// Last-resort process-level nets. With express-async-errors in place, a
// route-level failure should already have been caught above and turned into
// a normal 500 response -- these exist for anything outside the request
// cycle (a stray timer, a truly unawaited background promise). Log loudly so
// it shows up in Azure's log stream / Application Insights, and exit on a
// genuine uncaughtException so the platform's process supervisor restarts a
// clean instance rather than the app limping along in a possibly-corrupt state.
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED PROMISE REJECTION (did not crash the process):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION — exiting so the process supervisor can restart cleanly:", err);
  process.exit(1);
});

app.listen(PORT, () => {
  console.log(`INICIO In-Home Consumption MVP running on http://localhost:${PORT}`);
  require("./lib/scheduler").start();
});
