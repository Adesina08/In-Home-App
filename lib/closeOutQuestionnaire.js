// The end-of-diary close-out questionnaire.
//
// Deliberately a small, fixed set of questions rather than another
// admin-configurable instrument. The spec's own example (section 6.2) is
// short by design -- it exists to reconcile the diary against the
// respondent's own memory, not to collect more diary data -- and giving it
// the full dynamic-questionnaire treatment would be a lot of surface area for
// a screen every respondent sees exactly once. If a study genuinely needs its
// own close-out wording, that is a real feature to build later; this is the
// honest first version.

const QUESTIONS = [
  {
    code: "missed_occasions",
    text: "Looking back over the study, do you think you missed logging any occasions?",
    type: "single",
    options: ["No, I logged everything", "Yes, a few", "Yes, quite a few", "Not sure"],
    required: true,
  },
  {
    code: "missed_occasions_why",
    text: "If you missed any, what usually got in the way?",
    type: "text",
    required: false,
  },
  {
    code: "behaviour_change",
    text: "Did taking part change what or how much you consumed, compared with normal?",
    type: "single",
    options: ["No, I consumed as normal", "Slightly less than normal", "Slightly more than normal", "Noticeably different from normal"],
    required: true,
  },
  {
    code: "overall_experience",
    text: "Overall, how was your experience taking part in this study?",
    type: "single",
    options: ["Very easy", "Easy", "Okay", "Difficult", "Very difficult"],
    required: true,
  },
  {
    code: "reminders_feedback",
    text: "Were the reminders helpful, or too frequent / not frequent enough?",
    type: "single",
    options: ["About right", "Too frequent", "Not frequent enough", "I didn't notice them"],
    required: false,
  },
  {
    code: "final_comments",
    text: "Anything else you'd like us to know before we close your diary?",
    type: "text",
    required: false,
  },
];

function validate(answers) {
  const errors = {};
  for (const q of QUESTIONS) {
    if (!q.required) continue;
    const v = answers[q.code];
    if (v === undefined || v === null || String(v).trim() === "") {
      errors[q.code] = "Please answer this question.";
    }
  }
  return errors;
}

module.exports = { QUESTIONS, validate };
