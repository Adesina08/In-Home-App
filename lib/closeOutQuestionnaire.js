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

function questionsFor(study={}) { return Array.isArray(study.close_out_questions) && study.close_out_questions.length ? study.close_out_questions : QUESTIONS; }
function validate(answers,study) {
  const errors = {};
  for (const q of questionsFor(study)) {
    if(q.type==="single"&&answers[q.code]&&!q.options.includes(answers[q.code])){errors[q.code]="Choose a listed option.";continue;}
    if (!q.required) continue;
    const v = answers[q.code];
    if (v === undefined || v === null || String(v).trim() === "") {
      errors[q.code] = "Please answer this question.";
    }
  }
  return errors;
}

module.exports = { QUESTIONS, questionsFor, validate };
