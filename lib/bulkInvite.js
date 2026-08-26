// Bulk respondent invitations: download a template, fill it in, upload it,
// check what the app made of each row, then send.
//
// The review step is the point of this module. Sending an SMS is irreversible
// and costs money per message, so every row is classified BEFORE anything is
// sent -- a number that can't be dialled, a duplicate inside the file, someone
// already on the study. Discovering those one failed message at a time, after
// the fact, is how a recruitment batch turns into an afternoon of manual
// cleanup.
//
// Phone normalisation earns its place here too. Nigerian numbers are written
// "08012345678" in every spreadsheet a field team will ever hand you, and
// Twilio requires "+2348012345678". Rejecting the entire file over that would
// be technically correct and practically useless, so the app converts what it
// can and SHOWS what it changed, rather than either failing or silently
// rewriting someone's data.

const XLSX = require("xlsx");

const TEMPLATE_COLUMNS = ["name", "phone"];

// Only the markets this pilot actually recruits in. A wrong guess here would
// silently produce a valid-looking number for the wrong country, so unknown
// markets fall back to asking rather than assuming.
const COUNTRY_CODES = {
  nigeria: "+234",
  ghana: "+233",
  kenya: "+254",
  "south africa": "+27",
  "united kingdom": "+44",
  uk: "+44",
  "united states": "+1",
  usa: "+1",
};

function defaultCountryCodeFor(market) {
  if (!market) return "";
  return COUNTRY_CODES[String(market).trim().toLowerCase()] || "";
}

/** The CSV handed to a field team. CSV, not XLSX: it opens anywhere. */
function templateCsv() {
  return [
    TEMPLATE_COLUMNS.join(","),
    "Ada Okafor,08012345678",
    "Emeka Nwosu,+2348098765432",
    "",
  ].join("\n");
}

/**
 * Turn a raw phone number into E.164, or explain why it can't be.
 *
 * Returns { value, changed, problem }. `changed` is true when the app altered
 * what was typed -- shown in the review so nobody is surprised by a number
 * they didn't write.
 */
function normalisePhone(raw, countryCode) {
  const stripped = String(raw || "").replace(/[\s\-().]/g, "");
  if (!stripped) return { value: "", changed: false, problem: "No phone number." };

  // Already international.
  if (stripped.startsWith("+")) {
    if (/^\+[1-9]\d{6,14}$/.test(stripped)) return { value: stripped, changed: false, problem: null };
    return { value: stripped, changed: false, problem: "Not a valid international number." };
  }

  // 00 is the other way of writing +.
  if (stripped.startsWith("00")) {
    const candidate = `+${stripped.slice(2)}`;
    if (/^\+[1-9]\d{6,14}$/.test(candidate)) return { value: candidate, changed: true, problem: null };
    return { value: stripped, changed: false, problem: "Not a valid international number." };
  }

  if (!/^\d+$/.test(stripped)) {
    return { value: stripped, changed: false, problem: "Contains characters that aren't digits." };
  }

  if (!countryCode) {
    return {
      value: stripped,
      changed: false,
      problem: "Needs a country code — set one above, or write the number as +234…",
    };
  }

  // National format with a trunk zero: 0801… -> +234801…
  const national = stripped.startsWith("0") ? stripped.slice(1) : stripped;
  const candidate = `${countryCode}${national}`;
  if (/^\+[1-9]\d{6,14}$/.test(candidate)) return { value: candidate, changed: true, problem: null };
  return { value: stripped, changed: false, problem: "Doesn't look like a valid number for that country." };
}

/** Read an uploaded CSV or spreadsheet into { name, phone } rows. */
function parseRoster(buffer, filename) {
  const wb = XLSX.read(buffer, { type: "buffer", raw: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { rows: [], error: "That file has no readable sheet." };

  const raw = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  if (!raw.length) return { rows: [], error: "That file has no rows below the header." };

  // Header names are matched loosely -- a field team will write "Phone
  // Number", "phone", or "Mobile", and failing the whole upload over the
  // wording of a column heading helps nobody.
  const keyFor = (obj, wanted) => {
    const keys = Object.keys(obj);
    const exact = keys.find((k) => k.trim().toLowerCase() === wanted);
    if (exact) return exact;
    return keys.find((k) => k.trim().toLowerCase().includes(wanted));
  };

  const first = raw[0];
  const nameKey = keyFor(first, "name");
  const phoneKey = keyFor(first, "phone") || keyFor(first, "mobile") || keyFor(first, "number");
  if (!phoneKey) {
    return { rows: [], error: 'No phone column found. The template\'s columns are "name" and "phone".' };
  }

  const rows = raw.map((r, i) => ({
    rowNumber: i + 2, // +2: one for the header, one for 1-based counting, so it matches what the spreadsheet shows
    name: String(nameKey ? r[nameKey] : "").trim(),
    phone: String(r[phoneKey] || "").trim(),
  }));
  return { rows, error: null };
}

/**
 * Classify every row against the study as it stands.
 *
 * `existingContacts` is the set of normalised contacts already on this study,
 * passed in rather than queried here so this module stays free of database
 * access and can be tested on its own.
 */
function reviewRoster({ rows, countryCode, existingContacts }) {
  const seen = new Map();
  const existing = new Set(existingContacts || []);

  return rows.map((row) => {
    const out = { ...row, contact: "", status: "ok", note: "", changed: false };

    if (!row.name && !row.phone) {
      out.status = "skipped";
      out.note = "Empty row.";
      return out;
    }
    if (!row.name) {
      out.status = "invalid";
      out.note = "No name.";
      return out;
    }

    const phone = normalisePhone(row.phone, countryCode);
    out.contact = phone.value;
    out.changed = phone.changed;
    if (phone.problem) {
      out.status = "invalid";
      out.note = phone.problem;
      return out;
    }

    if (seen.has(phone.value)) {
      out.status = "duplicate";
      out.note = `Same number as row ${seen.get(phone.value)}.`;
      return out;
    }
    seen.set(phone.value, row.rowNumber);

    if (existing.has(phone.value)) {
      out.status = "already";
      out.note = "Already on this study.";
      return out;
    }

    if (phone.changed) out.note = `Read as ${phone.value}`;
    return out;
  });
}

/** Rows that will actually be invited. */
function invitableRows(reviewed) {
  return reviewed.filter((r) => r.status === "ok");
}

function summarise(reviewed) {
  const count = (s) => reviewed.filter((r) => r.status === s).length;
  return {
    total: reviewed.length,
    ok: count("ok"),
    invalid: count("invalid"),
    duplicate: count("duplicate"),
    already: count("already"),
    skipped: count("skipped"),
    reformatted: reviewed.filter((r) => r.changed && r.status === "ok").length,
  };
}

module.exports = {
  TEMPLATE_COLUMNS,
  COUNTRY_CODES,
  defaultCountryCodeFor,
  templateCsv,
  normalisePhone,
  parseRoster,
  reviewRoster,
  invitableRows,
  summarise,
};
