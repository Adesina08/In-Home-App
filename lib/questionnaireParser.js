// Parses an uploaded questionnaire file into staged question rows.
//
// Preferred path: a spreadsheet (CSV/XLSX) with columns for code, question text,
// type, options, required, min, max — parses reliably every time.
//
// Fallback path: a Word (.docx) or PDF questionnaire, best-effort parsed from
// prose using a "Q: ... / Type: ... / Options: ..." style heuristic. This is
// inherently unreliable — every row is flagged for review and nothing is
// committed to the study until a human confirms it on the Preview screen.

const XLSX = require("xlsx");
const mammoth = require("mammoth");
const { CADENCES } = require("./questionnaire");

const VALID_TYPES = ["single", "multi", "numeric", "text", "date", "photo", "video", "audio"];

const TYPE_SYNONYMS = {
  single: "single", "single select": "single", "single-select": "single",
  radio: "single", select: "single", "single choice": "single", choice: "single",
  single_choice: "single",
  multi: "multi", "multi select": "multi", "multi-select": "multi", multiple: "multi",
  checkbox: "multi", "multiple choice": "multi", "multiple select": "multi",
  multiple_choice: "multi",
  numeric: "numeric", number: "numeric", num: "numeric", integer: "numeric", quantity: "numeric",
  text: "text", "short text": "text", "long text": "text", "short answer": "text",
  "open text": "text", paragraph: "text", string: "text",
  date: "date", datetime: "date", "date/time": "date", time: "date",
  photo: "photo", image: "photo", picture: "photo", "photo upload": "photo",
  video: "video", "video upload": "video", "video evidence": "video",
  audio: "audio", voice: "audio", "voice note": "audio", "voice_note": "audio",
  "audio upload": "audio", "audio evidence": "audio", "voice recording": "audio",
  "audio/voice": "audio", "spoken answer": "audio", recording: "audio",
};

// Type tokens this template's Type column is known to use, matched as a whole word
// while scanning raw table text -- includes "matrix", which isn't a supported
// question type in this app (no rating-grid UI yet) but still needs to be recognized
// so the row/section/condition split doesn't break on it.
const TEMPLATE_TYPE_TOKENS = [
  "single_choice", "multiple_choice", "single choice", "multiple choice",
  "single-choice", "multi-select", "numeric", "number", "text", "date", "matrix", "photo", "video",
  "audio", "voice", "voice note",
];
const TEMPLATE_TYPE_RE = new RegExp(`\\b(${TEMPLATE_TYPE_TOKENS.map((t) => t.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")).join("|")})\\b`, "i");

function normalizeType(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  return TYPE_SYNONYMS[key] || (VALID_TYPES.includes(key) ? key : null);
}

function truthy(v) {
  if (v === undefined || v === null || String(v).trim() === "") return true; // default required = yes
  const s = String(v).trim().toLowerCase();
  return ["yes", "y", "true", "1", "required"].includes(s);
}

function splitOptions(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[;|,]/)
    .map((o) => o.trim())
    .filter(Boolean);
}

// Pipe-only split for the tabular import template, where "|" is the one true
// option delimiter and a comma is often legitimately part of an option's text
// (e.g. "Other, specify", "Flavoured variant, specify") -- splitOptions()
// above also breaks on comma/semicolon, which is right for a manual comma-
// separated form field but would wrongly fracture values like those.
function splitOptionsPipeOnly(raw) {
  if (!raw) return [];
  return String(raw)
    .split("|")
    .map((o) => o.trim())
    .filter(Boolean);
}

function normalizeRow(raw, idx) {
  const get = (...keys) => {
    for (const k of keys) {
      const hit = Object.keys(raw).find((rk) => rk.trim().toLowerCase() === k);
      if (hit && raw[hit] !== undefined && raw[hit] !== "") return raw[hit];
    }
    return "";
  };
  const warnings = [];
  const text = String(get("question", "question text", "text", "prompt") || "").trim();
  const typeRaw = get("type", "question type", "answer type");
  let type = normalizeType(typeRaw);
  if (!text) warnings.push("Missing question text — this row will be skipped unless you fill it in.");
  if (!type) {
    warnings.push(`Unrecognized type "${typeRaw || "(blank)"}" — defaulted to "text", please check.`);
    type = "text";
  }
  const options = splitOptions(get("options", "choices", "answers"));
  if ((type === "single" || type === "multi") && options.length === 0) {
    warnings.push(`Type "${type}" normally needs options — none found.`);
  }
  const minRaw = get("min", "min value", "minimum");
  const maxRaw = get("max", "max value", "maximum");
  const conditionRaw = String(get("condition", "skip logic", "skip condition") || "").trim();
  // Optional "cadence" / "diary mode" column: which diary_mode(s) this question
  // applies to (realtime, daily, weekly, monthly, hybrid), pipe- or
  // comma-separated. Blank means every cadence, same default as a question
  // created in the Builder -- an import that doesn't mention cadence at all
  // must not silently narrow every question to nothing.
  const cadenceRaw = String(get("cadence", "cadences", "diary mode", "diary_mode") || "").trim();
  const applicable_cadences = cadenceRaw
    ? cadenceRaw.split(/[|,]/).map((c) => c.trim().toLowerCase()).filter(Boolean)
    : [];
  if (applicable_cadences.length) {
    const unknown = applicable_cadences.filter((c) => !CADENCES.includes(c));
    if (unknown.length) {
      warnings.push(`Unrecognized cadence "${unknown.join(", ")}" — expected realtime, daily, weekly, monthly or hybrid. Ignored; this question will show for every cadence.`);
    }
  }
  return {
    row: idx + 1,
    code: String(get("code", "id", "key") || "").trim(),
    text,
    type,
    options,
    required: truthy(get("required")),
    min_value: minRaw !== "" ? Number(minRaw) : null,
    max_value: maxRaw !== "" ? Number(maxRaw) : null,
    section: String(get("section") || "").trim(),
    condition_raw: conditionRaw,
    applicable_cadences: applicable_cadences.filter((c) => CADENCES.includes(c)),
    warnings,
  };
}

// ---------- Condition parsing (shared by the spreadsheet Condition column and
// the tabular PDF/DOCX template parser below) ----------
//
// Grammar this recognizes, based on the Soren-style import template:
//   ""                                                   -> no condition
//   "Show if Q<n> equals <v1>[ or <v2> ...]"              -> per-question rule
//   "Show if Q<n> does not equal <v1>[ or <v2> ...]"      -> per-question rule, negated
//   "Show if Q<n> includes <v>"                           -> per-question rule, multi-select contains
//   "Same section as Q<n> (inherits section condition)"   -> no extra rule; covered by Q<n>'s section rule
//   "Same section as Q<n>; show if Q<m> ..."              -> inherits the section rule AND adds its own rule
// A trailing ", and <free text>" clause (e.g. "...or It was provided/free, and
// the respondent knows the price paid") isn't tied to any question, so it's kept
// as a note for manual review rather than guessed into a rule.
function splitConditionValues(str) {
  return String(str || "")
    .split(/\s+or\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseShowIfBody(body) {
  const m = String(body || "").trim().match(/^Q(\d+)\s+(equals|does not equal|includes)\s+(.*)$/i);
  if (!m) return null;
  const conditionRow = parseInt(m[1], 10);
  const opPhrase = m[2].toLowerCase();
  let rest = m[3].trim();
  let note = null;
  const noteMatch = rest.match(/^(.*?),\s+and\s+(.+)$/i);
  if (noteMatch) {
    rest = noteMatch[1].trim();
    note = noteMatch[2].trim();
  }
  const values = splitConditionValues(rest);
  if (!values.length) return null;
  let operator;
  if (opPhrase === "includes") operator = "includes";
  else if (opPhrase === "equals") operator = values.length > 1 ? "in" : "equals";
  else operator = values.length > 1 ? "not_in" : "not_equals"; // "does not equal"
  return { conditionRow, operator, values, note };
}

function parseConditionText(raw) {
  const text = String(raw || "").trim();
  if (!text) return { empty: true };
  let m = text.match(/^Show if\s+(.*)$/i);
  if (m) {
    const own = parseShowIfBody(m[1]);
    if (!own) return { empty: false, unparsed: text };
    return { empty: false, own };
  }
  m = text.match(/^Same section as\s+Q(\d+)\s*(?:\(inherits section condition\))?\s*(?:;\s*(.*))?$/i);
  if (m) {
    const sectionAnchorRow = parseInt(m[1], 10);
    let own = null;
    if (m[2] && m[2].trim()) {
      own = parseShowIfBody(m[2].trim().replace(/^show if\s+/i, ""));
    }
    return { empty: false, sectionAnchorRow, own };
  }
  return { empty: false, unparsed: text };
}

// After a full document is parsed, mark which rows are "section anchors" -- rows
// that OTHER rows reference via "Same section as Q<n>". An anchor row's own
// condition becomes a single section-level skip rule (see the commit handler in
// routes/admin.js) instead of a one-off per-question rule, and rows that merely
// say "(inherits section condition)" need no rule of their own at all.
function annotateSectionAnchors(rows) {
  const parsedByRow = new Map(rows.map((r) => [r.row, parseConditionText(r.condition_raw)]));
  const byRowNumber = new Map(rows.map((r) => [r.row, r]));
  rows.forEach((r) => { r.is_section_anchor = false; });
  parsedByRow.forEach((parsed, rowNum) => {
    if (parsed.sectionAnchorRow && byRowNumber.has(parsed.sectionAnchorRow)) {
      byRowNumber.get(parsed.sectionAnchorRow).is_section_anchor = true;
    }
  });
  rows.forEach((r) => {
    const parsed = parsedByRow.get(r.row);
    if (parsed.unparsed) {
      r.warnings.push(`Condition "${parsed.unparsed}" wasn't recognized — set up this rule manually on the Skip Logic tab after committing.`);
    } else if (parsed.own && parsed.own.note) {
      r.warnings.push(`Condition also said "...${parsed.own.note}" — that part isn't tied to a question, so it wasn't included in the auto-created rule. Review on the Skip Logic tab.`);
    }
  });
  return rows;
}

function parseSpreadsheet(buffer, filename) {
  const isCsv = /\.csv$/i.test(filename);
  const wb = isCsv ? XLSX.read(buffer.toString("utf8"), { type: "string" }) : XLSX.read(buffer, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  if (!rows.length) {
    return { rows: [], warnings: ["No rows found in the uploaded spreadsheet."] };
  }
  const parsed = annotateSectionAnchors(rows.map(normalizeRow).filter((r) => r.text || r.row));
  return { rows: parsed, warnings: [] };
}

// Best-effort prose parsing for Word/PDF questionnaires. Document text extractors
// (mammoth, pdf-parse) don't reliably preserve blank-line grouping between
// paragraphs, so this walks line by line with a small state machine instead of
// assuming "blank line separates questions": a line starting a fresh question
// closes out whatever question was being built, and Type:/Options:/Required:/
// bullet lines attach to the question currently being built.
const TYPE_LINE = /^type[:.]\s*/i;
const OPTIONS_LINE = /^(options?|choices?)[:.]\s*/i;
const REQUIRED_LINE = /^required[:.]\s*/i;
const CODE_LINE = /^code[:.]\s*/i;
const SECTION_LINE = /^section[:.]\s*/i;
const CONDITION_LINE = /^(condition|skip\s*logic|skip\s*condition)[:.]\s*/i;
const QUESTION_PREFIX = /^(q\d*[:.)]|question\s*\d*[:.)])\s*/i;
const BULLET_LINE = /^([-*•]|\(?[a-zA-Z0-9]\)|\d+[.)])\s+/;

function parseProse(text) {
  const warnings = ["Parsed from a document, not a spreadsheet — every row is a best-effort guess. Please review each one carefully before committing."];
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^--\s*\d+\s*of\s*\d+\s*--$/i.test(l)); // strip pdf-parse page separator markers
  const rows = [];
  let current = null;
  let currentSection = ""; // "Section: ..." lines act as a running heading, applied to every question until it changes

  function flush() {
    if (!current) return;
    const typeGuess = current.typeRaw ? normalizeType(current.typeRaw) : current.options.length ? "single" : null;
    const type = typeGuess || "text";
    const rowWarnings = [...current.warnings];
    if (!typeGuess) rowWarnings.push(`No explicit type found — guessed "${type}" from context.`);
    rows.push({
      row: rows.length + 1,
      code: current.code,
      text: current.text,
      type,
      options: current.options,
      required: current.requiredRaw !== null ? truthy(current.requiredRaw) : true,
      min_value: null,
      max_value: null,
      section: current.section,
      condition_raw: current.conditionRaw,
      warnings: rowWarnings,
    });
    current = null;
  }

  for (const line of lines) {
    if (TYPE_LINE.test(line)) {
      if (current) current.typeRaw = line.replace(TYPE_LINE, "").trim();
      continue;
    }
    if (OPTIONS_LINE.test(line)) {
      if (current) current.options = splitOptions(line.replace(OPTIONS_LINE, ""));
      continue;
    }
    if (REQUIRED_LINE.test(line)) {
      if (current) current.requiredRaw = line.replace(REQUIRED_LINE, "").trim();
      continue;
    }
    if (CODE_LINE.test(line)) {
      if (current) current.code = line.replace(CODE_LINE, "").trim();
      continue;
    }
    if (CONDITION_LINE.test(line)) {
      if (current) current.conditionRaw = line.replace(CONDITION_LINE, "").trim();
      continue;
    }
    if (SECTION_LINE.test(line)) {
      currentSection = line.replace(SECTION_LINE, "").trim();
      if (current) current.section = currentSection;
      continue;
    }
    if (BULLET_LINE.test(line) && current && !current.optionsExplicit) {
      current.options.push(line.replace(BULLET_LINE, "").trim());
      continue;
    }
    // Anything else starts a new question — close out the previous one.
    flush();
    current = {
      code: "",
      text: line.replace(QUESTION_PREFIX, "").trim(),
      typeRaw: null,
      options: [],
      optionsExplicit: false,
      requiredRaw: null,
      section: currentSection,
      conditionRaw: "",
      warnings: [],
    };
  }
  flush();

  if (!rows.length) {
    warnings.push("No structured questions detected — falling back to one text question per non-empty line.");
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .forEach((line, i) => {
        rows.push({
          row: i + 1,
          code: "",
          text: line,
          type: "text",
          options: [],
          required: true,
          min_value: null,
          max_value: null,
          section: "",
          condition_raw: "",
          warnings: ["No structure detected for this line — defaulted to a free-text question."],
        });
      });
  }

  return { rows: annotateSectionAnchors(rows), warnings };
}

// ---------- Tabular template parser (the "# | Question | Type | Options | Section
// | Condition" import template) ----------
//
// pdf-parse/mammoth extraction turns a table into a flat stream of lines in reading
// order -- no column boundaries survive. This walks that stream using three anchors
// that turned out to hold up across a real filled-in template:
//   1. Row start: a line beginning "<n> " where n is exactly the previous row
//      number + 1 (strict sequencing rules out any other line that happens to
//      start with digits, e.g. a wrapped time-of-day option like "10pm").
//   2. Type cell: the first later line containing one of the known type tokens as
//      a whole word (single_choice, multiple_choice, numeric, text, date, matrix,
//      photo, video) -- may share a line with the tail of the question text.
//   3. Options/Section split: Options is a "|"-delimited list that always spans
//      to the LAST line (scanning forward from the type cell) containing a "|" --
//      Section reliably starts fresh on the line after that, or immediately after
//      the type token on its own line when Options is empty. "matrix" rows break
//      this rule (their rating-scale text is semicolon-separated with only one
//      incidental "|"), so they're special-cased: not a supported question type
//      here, so the whole tail is kept for manual review instead of being split.
const TEMPLATE_HEADER_RE = /^#\s*Question\s*Type\s*Options\s*Section\s*Condition\s*$/i;
const TEMPLATE_ROW_START_RE = /^(\d+)\s+(.*)$/;
const CONDITION_MARKER_RE = /\b(Show if|Same section as)\b/i;

function detectTemplate(text) {
  return text.split("\n").some((l) => TEMPLATE_HEADER_RE.test(l.trim()));
}

function stripTemplateBoilerplate(text) {
  const PAGE_LINE = /^Page\s+\d+\s*$/i;
  const COLUMNS_LINE = /^Columns:\s*#/i;
  const PAGE_SEP = /^--\s*\d+\s*of\s*\d+\s*--$/i;
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !PAGE_LINE.test(l) && !COLUMNS_LINE.test(l) && !PAGE_SEP.test(l) && !TEMPLATE_HEADER_RE.test(l));
}

function parseTemplateTable(text) {
  const warnings = [
    "Parsed from a table in a document, not a spreadsheet — every row is a best-effort match on the row number, type, and pipe-delimited options. Please review each one, especially Options/Section, before committing.",
  ];
  const lines = stripTemplateBoilerplate(text);

  // Group lines into per-row blocks using the strict-sequencing row anchor.
  const blocks = [];
  let expectedNext = 1;
  let current = null;
  for (const line of lines) {
    const m = line.match(TEMPLATE_ROW_START_RE);
    if (m && parseInt(m[1], 10) === expectedNext) {
      if (current) blocks.push(current);
      current = { row: expectedNext, lines: [m[2]] };
      expectedNext += 1;
    } else if (current) {
      current.lines.push(line);
    } // else: preamble before the first row (title/subtitle) -- discarded
  }
  if (current) blocks.push(current);

  if (!blocks.length) {
    return { rows: [], warnings: ["This looked like the import template (matching header found) but no numbered rows (\"1 ...\", \"2 ...\") could be located."] };
  }

  const rows = blocks.map(({ row, lines: blockLines }) => {
    const rowWarnings = [];

    // Find the type token, which may share a line with the tail of the question text.
    let typeLineIdx = -1;
    let typeMatch = null;
    for (let i = 0; i < blockLines.length; i++) {
      const m = blockLines[i].match(TEMPLATE_TYPE_RE);
      if (m) { typeLineIdx = i; typeMatch = m; break; }
    }
    if (typeLineIdx === -1) {
      return {
        row, code: "", text: blockLines.join(" ").trim(), type: "text", options: [],
        required: true, min_value: null, max_value: null, section: "", condition_raw: "",
        warnings: [`Row ${row}: couldn't find a recognized Type value (single_choice, number, text, ...) — please fill in Type/Options/Section manually.`],
      };
    }

    const beforeType = blockLines.slice(0, typeLineIdx).join(" ");
    const typeLine = blockLines[typeLineIdx];
    const questionText = `${beforeType} ${typeLine.slice(0, typeMatch.index)}`.replace(/\s+/g, " ").trim();
    const typeRaw = typeMatch[1];
    const afterTypeOnLine = typeLine.slice(typeMatch.index + typeMatch[0].length).trim();

    const type = normalizeType(typeRaw);
    let finalType = type;
    if (typeRaw.toLowerCase() === "matrix") {
      rowWarnings.push(`Row ${row}: "matrix" (rating-grid) questions aren't supported yet — imported as free text. Consider splitting this into separate rating questions, or set the type manually.`);
      finalType = "text";
    } else if (!type) {
      rowWarnings.push(`Row ${row}: unrecognized type "${typeRaw}" — defaulted to "text", please check.`);
      finalType = "text";
    }

    // Remaining lines after the type line, plus any leftover text on the type
    // line itself, form the "options + section + condition" tail. Join into one
    // string -- PDF line wraps don't reliably mark cell boundaries (Section
    // sometimes starts a fresh line, sometimes is glued right onto the same
    // line as the last option), so the real split has to happen at the word
    // level, not the line level.
    const tailBlob = [afterTypeOnLine, ...blockLines.slice(typeLineIdx + 1)].join(" ").replace(/\s+/g, " ").trim();

    let optionsRaw = "";
    let sectionConditionBlob = tailBlob;
    if (typeRaw.toLowerCase() !== "matrix") {
      // Find the last "|"-containing word, then keep absorbing further words
      // into Options as long as they look like a wrapped continuation of that
      // last option (starting lowercase, or a digit as in "10pm") -- the first
      // word after that which starts uppercase is where Section begins. This
      // also correctly handles Section being glued onto the very same line as
      // the last option, with only a space between them.
      const tokens = tailBlob.split(" ").filter(Boolean);
      let lastPipeTokenIdx = -1;
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].includes("|")) lastPipeTokenIdx = i;
      }
      if (lastPipeTokenIdx >= 0) {
        let sectionStartIdx = lastPipeTokenIdx + 1;
        while (sectionStartIdx < tokens.length && /^[a-z0-9]/.test(tokens[sectionStartIdx])) {
          sectionStartIdx++;
        }
        optionsRaw = tokens.slice(0, sectionStartIdx).join(" ");
        sectionConditionBlob = tokens.slice(sectionStartIdx).join(" ");
      } else {
        optionsRaw = "";
        sectionConditionBlob = tailBlob;
      }
    } else {
      // matrix: don't guess at the options/section boundary -- keep the whole
      // tail together and flag it; Section is recovered (if possible) in the
      // known-section-name pass right after this map().
      optionsRaw = tailBlob;
      sectionConditionBlob = "";
    }

    const options = splitOptionsPipeOnly(optionsRaw);
    const condMatch = sectionConditionBlob.match(CONDITION_MARKER_RE);
    const section = (condMatch ? sectionConditionBlob.slice(0, condMatch.index) : sectionConditionBlob).trim();
    const conditionRaw = condMatch ? sectionConditionBlob.slice(condMatch.index).trim() : "";

    if ((finalType === "single" || finalType === "multi") && options.length === 0 && typeRaw.toLowerCase() !== "matrix") {
      rowWarnings.push(`Row ${row}: type "${finalType}" normally needs options — none found.`);
    }
    if (!questionText) rowWarnings.push(`Row ${row}: missing question text — this row will be skipped unless you fill it in.`);

    return {
      row, code: "", text: questionText, type: finalType, options,
      required: true, min_value: null, max_value: null,
      section, condition_raw: conditionRaw,
      _matrixRaw: typeRaw.toLowerCase() === "matrix" ? optionsRaw : null,
      warnings: rowWarnings,
    };
  });

  // matrix rows didn't get a clean Section split above -- fall back to searching
  // for a section name already confirmed by another (non-matrix) row in the doc.
  const knownSections = [...new Set(rows.map((r) => r.section).filter(Boolean))];
  rows.forEach((r) => {
    if (r._matrixRaw === null || r._matrixRaw === undefined) return;
    const hit = knownSections.find((s) => r._matrixRaw.includes(s));
    if (hit) {
      const idx = r._matrixRaw.indexOf(hit);
      r.options = splitOptionsPipeOnly(r._matrixRaw.slice(0, idx));
      const rest = r._matrixRaw.slice(idx);
      const condMatch = rest.match(CONDITION_MARKER_RE);
      r.section = (condMatch ? rest.slice(0, condMatch.index) : rest).trim();
      r.condition_raw = condMatch ? rest.slice(condMatch.index).trim() : "";
    } else {
      r.warnings.push(`Row ${r.row}: couldn't confidently separate Options/Section/Condition for this matrix row — please fill them in manually.`);
    }
    delete r._matrixRaw;
  });

  return { rows: annotateSectionAnchors(rows), warnings };
}

// Document text (docx/pdf/txt) is routed to the tabular template parser when it
// matches the "# | Question | Type | Options | Section | Condition" header --
// that parser is far more reliable for THIS layout than the generic prose
// fallback, which doesn't understand table columns at all. Anything else still
// falls back to the best-effort prose parser.
function parseDocumentText(text) {
  return detectTemplate(text) ? parseTemplateTable(text) : parseProse(text);
}

async function parseUpload(buffer, filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (["csv", "xlsx", "xls"].includes(ext)) {
    const result = parseSpreadsheet(buffer, filename);
    return { ...result, sourceType: "spreadsheet" };
  }
  if (ext === "docx") {
    const { value: text } = await mammoth.extractRawText({ buffer });
    const result = parseDocumentText(text);
    return { ...result, sourceType: "document" };
  }
  if (ext === "pdf") {
    const { PDFParse } = require("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    const data = await parser.getText();
    const result = parseDocumentText(data.text);
    return { ...result, sourceType: "document" };
  }
  if (ext === "txt") {
    const result = parseDocumentText(buffer.toString("utf8"));
    return { ...result, sourceType: "document" };
  }
  return { rows: [], warnings: [`Unsupported file type ".${ext}". Upload a .csv, .xlsx, .docx, .pdf, or .txt file.`], sourceType: "unknown" };
}

module.exports = { parseUpload, VALID_TYPES, normalizeType, parseConditionText };
