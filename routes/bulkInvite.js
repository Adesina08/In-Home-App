// Bulk respondent invitations, mounted for both admins and interviewers.
//
// Three steps, deliberately separated: download a template, upload and REVIEW,
// then send. The review step exists because sending is irreversible and costs
// money per message -- every problem the app can see (a number it can't dial,
// a duplicate inside the file, someone already on the study) is surfaced
// before a single SMS goes out, not discovered one bounce at a time.

const express = require("express");
const multer = require("multer");
const db = require("../lib/db");
const { logAudit } = require("../lib/audit");
const bulk = require("../lib/bulkInvite");
const { enrol, existingContactsFor } = require("../lib/enrolment");
const messaging = require("../lib/whatsapp");
const { appBaseUrl } = require("../lib/urls");

// mergeParams, because this router is mounted UNDER `/studies/:id/...` in two
// places -- without it `req.params.id` is undefined here and every study looks
// like it doesn't exist.
const router = express.Router({ mergeParams: true });
// Memory storage: a roster is a few kilobytes of text and is consumed
// immediately, so there is nothing to gain from writing it to disk -- and a
// file of respondent phone numbers is exactly what shouldn't be left lying
// around in a temp directory.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// An interviewer may only invite onto a study; an admin may do the same. Both
// mount this router, so the study is resolved and checked here.
function loadStudy(req, res) {
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(req.params.id);
  if (!study) {
    res.status(404).render("error", { message: "Study not found.", user: req.session.user });
    return null;
  }
  return study;
}

function basePath(req) {
  return req.session.user.role === "admin" ? `/admin/studies/${req.params.id}` : `/interviewer/studies/${req.params.id}`;
}

router.get("/template.csv", (req, res) => {
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", 'attachment; filename="inicio-invite-template.csv"');
  res.send(bulk.templateCsv());
});

router.get("/", (req, res) => {
  const study = loadStudy(req, res);
  if (!study) return;
  res.render("bulk_invite/upload", {
    study,
    basePath: basePath(req),
    defaultCountryCode: bulk.defaultCountryCodeFor(study.market),
    messagingLive: messaging.isRealMessagingConfigured(),
    error: req.query.error || null,
    sent: req.query.sent || null,
  });
});

// Step 2: parse and classify. Nothing is written and nothing is sent.
router.post("/review", upload.single("roster"), (req, res) => {
  const study = loadStudy(req, res);
  if (!study) return;
  const back = (msg) => res.redirect(`${basePath(req)}/bulk-invite?error=${encodeURIComponent(msg)}`);

  if (!req.file) return back("Choose a filled-in template to upload.");
  const countryCode = (req.body.country_code || "").trim();

  const parsed = bulk.parseRoster(req.file.buffer, req.file.originalname);
  if (parsed.error) return back(parsed.error);
  if (!parsed.rows.length) return back("That file has no rows below the header.");

  const reviewed = bulk.reviewRoster({
    rows: parsed.rows,
    countryCode,
    existingContacts: existingContactsFor(study.id),
  });

  res.render("bulk_invite/review", {
    study,
    basePath: basePath(req),
    rows: reviewed,
    summary: bulk.summarise(reviewed),
    countryCode,
    filename: req.file.originalname,
    messagingLive: messaging.isRealMessagingConfigured(),
    messagingError: messaging.messagingConfigError(),
  });
});

// Step 3: enrol and send. Only rows the review marked "ok" are acted on --
// the reviewed list is re-derived from the posted rows rather than trusted
// from the form, so a tampered or stale page can't smuggle in a row the
// review rejected.
router.post("/send", async (req, res) => {
  const study = loadStudy(req, res);
  if (!study) return;

  const names = [].concat(req.body.name || []);
  const contacts = [].concat(req.body.contact || []);
  const rows = contacts
    .map((contact, i) => ({ rowNumber: i + 2, name: (names[i] || "").trim(), phone: String(contact || "").trim() }))
    .filter((r) => r.phone);

  const reviewed = bulk.reviewRoster({
    rows,
    countryCode: (req.body.country_code || "").trim(),
    existingContacts: existingContactsFor(study.id),
  });
  const toInvite = bulk.invitableRows(reviewed);

  const outcome = { invited: 0, failed: 0, skipped: reviewed.length - toInvite.length, errors: [] };
  const provider = messaging.getProvider();

  for (const row of toInvite) {
    let respondent;
    try {
      const result = enrol({
        studyId: study.id,
        contact: row.contact,
        name: row.name,
        interviewerId: req.session.user.role === "interviewer" ? req.session.user.id : null,
      });
      respondent = result.respondent;
      if (!result.created) {
        outcome.skipped++;
        continue;
      }
    } catch (e) {
      outcome.failed++;
      outcome.errors.push(`${row.name || row.contact}: ${e.message}`);
      continue;
    }

    const sendResult = await provider.send({
      respondentId: respondent.id,
      to: row.contact,
      template: "survey_invite",
      variables: {
        name: row.name,
        study: study.name,
        link: `${appBaseUrl(req)}/invite/${respondent.unique_token}`,
      },
    });

    if (sendResult.ok && !sendResult.simulated) {
      db.prepare("UPDATE respondents SET invite_sent_at = datetime('now') WHERE id = ?").run(respondent.id);
      outcome.invited++;
    } else if (sendResult.simulated) {
      // The respondent exists and can still be reached by their link; the
      // message just wasn't delivered. Counted separately so nobody reads
      // "invited" as "contacted".
      outcome.failed++;
      outcome.errors.push(`${row.name || row.contact}: messaging isn't connected, so no text was sent.`);
    } else {
      outcome.failed++;
      outcome.errors.push(`${row.name || row.contact}: ${sendResult.error || "could not be texted."}`);
    }
  }

  logAudit(req.session.user.email, "bulk_invite", "studies", study.id, outcome);
  const summary = `${outcome.invited} invited${outcome.failed ? `, ${outcome.failed} not sent` : ""}${outcome.skipped ? `, ${outcome.skipped} skipped` : ""}.`;
  res.render("bulk_invite/done", {
    study,
    basePath: basePath(req),
    outcome,
    summary,
  });
});

module.exports = router;
