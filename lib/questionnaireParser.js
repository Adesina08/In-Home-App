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

const VALID_TYPES = ["single", "multi", "numeric", "text", "date", "photo", "video"];

const TYPE_SYNONYMS = {
  single: "single", "single select": "single", "single-select": "single",
  radio: "single", select: "single", "single choice": "single", choice: "single",
  multi: "multi", "multi select": "multi", "multi-select": "multi", multiple: "multi",
  checkbox: "multi", "multiple choice": "multi", "multiple select": "multi",
  numeric: "numeric", number: "numeric", num: "numeric", integer: "numeric", quantity: "numeric",
  text: "text", "short text": "text", "long text": "text", "short answer": "text",
  "open text": "text", paragraph: "text", string: "text",
  date: "date", datetime: "date", "date/time": "date", time: "date",
  photo: "photo", image: "photo", picture: "photo", "photo upload": "photo",
  video: "video", "video upload": "video", "video evidence": "video",
};

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
  return {
    row: idx + 1,
    code: String(get("code", "id", "key") || "").trim(),
    text,
    type,
    options,
    required: truthy(get("required")),
    min_value: minRaw !== "" ? Number(minRaw) : null,
    max_value: maxRaw !== "" ? Number(maxRaw) : null,
    warnings,
  };
}

function parseSpreadsheet(buffer, filename) {
  const isCsv = /\.csv$/i.test(filename);
  const wb = isCsv ? XLSX.read(buffer.toString("utf8"), { type: "string" }) : XLSX.read(buffer, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  if (!rows.length) {
    return { rows: [], warnings: ["No rows found in the uploaded spreadsheet."] };
  }
  const parsed = rows.map(normalizeRow).filter((r) => r.text || r.row);
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
          warnings: ["No structure detected for this line — defaulted to a free-text question."],
        });
      });
  }

  return { rows, warnings };
}

async function parseUpload(buffer, filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (["csv", "xlsx", "xls"].includes(ext)) {
    const result = parseSpreadsheet(buffer, filename);
    return { ...result, sourceType: "spreadsheet" };
  }
  if (ext === "docx") {
    const { value: text } = await mammoth.extractRawText({ buffer });
    const result = parseProse(text);
    return { ...result, sourceType: "document" };
  }
  if (ext === "pdf") {
    const { PDFParse } = require("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    const data = await parser.getText();
    const result = parseProse(data.text);
    return { ...result, sourceType: "document" };
  }
  if (ext === "txt") {
    const result = parseProse(buffer.toString("utf8"));
    return { ...result, sourceType: "document" };
  }
  return { rows: [], warnings: [`Unsupported file type ".${ext}". Upload a .csv, .xlsx, .docx, .pdf, or .txt file.`], sourceType: "unknown" };
}

module.exports = { parseUpload, VALID_TYPES, normalizeType };
