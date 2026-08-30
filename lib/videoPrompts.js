// Builds the teleprompter script for Video mode from the study's own
// questionnaire -- no per-study configuration, nothing for an admin to set up.
//
// The rule that matters: only prompt for questions the extractor can actually
// fill. lib/videoFieldExtraction.js matches signals against a question's own
// configured options, and skips numeric and free-text entirely (guessing a
// count from generic image tags would be fabricating data). Prompting someone
// to say something that will always be discarded wastes their recording and
// teaches them the feature does not work.
//
// So: single and multi-select only, in questionnaire order, preceded by one
// fixed instruction to show the product -- because the vision half of the
// extractor has nothing to read unless the pack is held up to the camera.

const MAX_VIDEO_SECONDS = 90;

// Below this, prompts get too little time to answer properly and the
// respondent is better served by the standard form.
const MIN_SECONDS_PER_PROMPT = 5;

function isFillable(q) {
  if (!q) return false;
  if (q.type !== "single" && q.type !== "multi") return false;
  const options = Array.isArray(q.options) ? q.options : [];
  // A select with no options configured can never match anything.
  return options.length > 0;
}

/**
 * @returns {{ prompts: Array, secondsEach: number, truncated: boolean, totalFillable: number }}
 *
 * `truncated` is true when the questionnaire has more auto-fillable questions
 * than fit in the recording at a usable pace. The extra questions are not
 * dropped from the entry -- the respondent still answers them on the review
 * form afterwards. They are only left off the teleprompter.
 */
function buildVideoPrompts(questions, { maxSeconds = MAX_VIDEO_SECONDS } = {}) {
  const fillable = (questions || []).filter(isFillable);

  // The opening instruction is not a question. Vision only ever reads what is
  // physically in frame, so this earns its place ahead of anything spoken.
  const prompts = [
    {
      id: "show-product",
      text: "Hold the product or pack up to the camera",
      hint: "Show the label clearly for a few seconds.",
      kind: "show",
    },
  ];

  const budget = Math.max(1, Math.floor(maxSeconds / MIN_SECONDS_PER_PROMPT) - 1);
  const shown = fillable.slice(0, budget);

  for (const q of shown) {
    prompts.push({
      id: String(q.id),
      text: q.text,
      hint: q.type === "multi" ? "You can mention more than one." : "Say your answer out loud.",
      kind: "say",
    });
  }

  return {
    prompts,
    secondsEach: Math.max(MIN_SECONDS_PER_PROMPT, Math.floor(maxSeconds / prompts.length)),
    truncated: fillable.length > shown.length,
    totalFillable: fillable.length,
  };
}

module.exports = { buildVideoPrompts, isFillable, MAX_VIDEO_SECONDS };
