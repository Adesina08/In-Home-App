// Server-side validation of a submitted diary entry.
//
// The diary form has always marked required questions with a red asterisk and
// set the browser's `required` attribute -- and that was the whole of the
// enforcement. Anything that bypassed the browser's own check (a hidden
// control the browser can't validate, a script-disabled field, a request that
// never came from the form at all) stored an incomplete or out-of-range answer
// with nothing to stop it. The asterisk was a promise the server didn't keep.
//
// Two rules that shape everything here:
//
//   * A DRAFT is never validated. Saving a half-finished entry is the point of
//     a draft, and a respondent whose signal drops mid-entry must be able to
//     keep what they have typed.
//
//   * Only questions the respondent was actually SHOWN can be required. Skip
//     logic hides questions; demanding an answer to one that was never on
//     screen is indistinguishable, from the respondent's side, from a broken
//     app. Visibility is computed with the same rules the form uses -- see
//     visibleQuestionIds() in lib/skipLogic.js.

const { visibleQuestionIds } = require("./skipLogic");

const MEDIA_TYPES = new Set(["photo", "video", "audio"]);

/** The field name a question's answer arrives under. */
function fieldNameFor(q) {
  if (q.type === "photo") return `photo_q_${q.id}`;
  if (q.type === "video") return `video_q_${q.id}`;
  if (q.type === "audio") return `audio_q_${q.id}`;
  return `q_${q.id}`;
}

/** Collect submitted answers keyed by question id, as they'd be stored. */
function answersFrom(questions, body) {
  const answers = {};
  questions.forEach((q) => {
    if (MEDIA_TYPES.has(q.type)) return;
    const field = `q_${q.id}`;
    if (q.type === "multi") {
      const vals = body[field];
      if (vals) answers[q.id] = (Array.isArray(vals) ? vals : [vals]).join("|");
    } else if (body[field] !== undefined && String(body[field]).trim() !== "") {
      answers[q.id] = String(body[field]).trim();
    }
  });
  return answers;
}

/**
 * Returns [] when the entry may be stored, or a list of
 * { questionId, code, text, message } describing what has to be fixed.
 */
function validateSubmission({ questions, rules, body }) {
  const errors = [];
  const answers = answersFrom(questions, body);
  const visible = visibleQuestionIds(questions, rules || [], answers);

  questions.forEach((q) => {
    if (!visible.has(q.id)) return;

    const push = (message) =>
      errors.push({ questionId: q.id, code: q.code || null, text: q.text, message });

    // Media is deliberately NOT blocked, even when the question is marked
    // required. Two reasons:
    //
    //   * it matches the QC engine, which excludes photo/video/audio from its
    //     own required-answer rule (see lib/qc.js) -- evidence gaps are
    //     flagged for review, never used to reject data; and
    //   * a camera that won't open, a denied permission or a failed upload
    //     would otherwise leave a respondent standing in their kitchen unable
    //     to save the entry at all. Losing the whole occasion is far worse
    //     than logging it with the photo missing and reviewing it later.
    if (MEDIA_TYPES.has(q.type)) return;

    const raw = answers[q.id];
    const answered = raw !== undefined && raw !== "";

    if (q.required && !answered) {
      push("Please answer this question.");
      return;
    }
    if (!answered) return;

    if (q.type === "numeric") {
      // Number inputs arrive as strings and an empty-ish or malformed value
      // would otherwise be stored verbatim and only surface as a broken
      // average months later, during analysis.
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        push("Please enter a number.");
        return;
      }
      const min = q.min_value;
      const max = q.max_value;
      if (min !== null && min !== undefined && n < min) {
        push(max !== null && max !== undefined
          ? `Please enter a number between ${min} and ${max}.`
          : `Please enter ${min} or more.`);
        return;
      }
      if (max !== null && max !== undefined && n > max) {
        push(min !== null && min !== undefined
          ? `Please enter a number between ${min} and ${max}.`
          : `Please enter ${max} or less.`);
      }
      return;
    }

    if (q.type === "single" || q.type === "multi") {
      // An option that isn't on the list means the questionnaire changed under
      // the respondent, or the value was tampered with. Either way it would
      // pollute every count and cross-tab that groups by this question.
      let options = [];
      try {
        options = JSON.parse(q.options_json || "[]");
      } catch (e) {
        return; // malformed config is not the respondent's problem
      }
      if (!options.length) return;
      const chosen = q.type === "multi" ? String(raw).split("|").filter(Boolean) : [String(raw)];
      const unknown = chosen.filter((c) => !options.includes(c));
      if (unknown.length) push("Please choose one of the listed options.");
    }
  });

  return errors;
}

module.exports = { validateSubmission, answersFrom, fieldNameFor };
