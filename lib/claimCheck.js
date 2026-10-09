// Claim checker (framework section 15, "AI narrative": no numeric claim should
// appear unless linked to a calculated output).
//
// Every number written in a summary is matched against the metric snapshot
// the summary was generated from. A number is supported when some figure in
// the snapshot rounds to it at the precision it was written with ("40%" and "40.3%" are
// supported by 40.25; "40.4%" is not). Anything else -- a
// number the model calculated, estimated or misremembered -- is listed, so a
// researcher fixes the text before a client can see it.
//
// Deliberately literal: it checks digits, not words ("half", "doubled"), and
// it cannot tell whether a supported number is attached to the right measure.
// It catches invented and recalculated figures, which is the failure the
// framework is worried about; it does not replace reading the summary.

// 1,234.5 / 40% / -3 / 0.75 -- not part of a word, a date or a code.
const NUMBER = /(?<![\w.\-\/:])(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)(\s?%)?(?![\w\/:]|\.\d|-\d)/g;
const DATE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}\b/g;

function parse(raw) {
  return Number(String(raw).replace(/,/g, ""));
}

function decimals(raw) {
  const dot = String(raw).indexOf(".");
  return dot === -1 ? 0 : String(raw).length - dot - 1;
}

/** Every number in a piece of text, with where it sits. Dates and clock times are skipped. */
function numbersIn(text) {
  const source = String(text || "");
  const masked = source.replace(DATE, (m) => " ".repeat(m.length));
  const out = [];
  for (const match of masked.matchAll(NUMBER)) {
    const raw = match[1];
    const value = parse(raw);
    // A bare year reads as a date, not a figure.
    if (!match[2] && !raw.includes(".") && value >= 1900 && value <= 2100) continue;
    const start = Math.max(0, match.index - 40), end = Math.min(source.length, match.index + match[0].length + 40);
    out.push({ text: match[0].trim(), value, decimals: decimals(raw), percent: !!match[2], context: source.slice(start, end).replace(/\s+/g, " ").trim() });
  }
  return out;
}

/** All figures in a metric snapshot: numeric values, plus numbers inside its strings ("Golden Penny · 40%"). */
function figuresIn(metrics) {
  const figures = [];
  const walk = (value) => {
    if (value === null || value === undefined) return;
    if (typeof value === "number") { if (Number.isFinite(value)) figures.push(value); return; }
    if (typeof value === "string") { for (const n of numbersIn(value)) figures.push(n.value); return; }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(metrics);
  return figures;
}

const roundTo = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;

function supported(number, figures) {
  return figures.some((figure) => {
    if (roundTo(figure, number.decimals) === number.value) return true;
    // A 0–1 share written as a percentage (0.83 -> 83%).
    return number.percent && Math.abs(figure) <= 1 && roundTo(figure * 100, number.decimals) === number.value;
  });
}

/**
 * Check a narrative against the metrics it was written from.
 * Returns { checked, supported, unsupported: [{ text, context }] }.
 */
function checkNarrative(text, metrics) {
  const figures = figuresIn(metrics);
  const numbers = numbersIn(text);
  const unsupported = numbers.filter((n) => !supported(n, figures)).map(({ text: t, context }) => ({ text: t, context }));
  return { checked: numbers.length, supported: numbers.length - unsupported.length, unsupported };
}

module.exports = { checkNarrative, numbersIn, figuresIn };
