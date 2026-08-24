// Single source of truth for the in-app Help pages (views/help.ejs and
// views/respondent/help.ejs) AND the downloadable Word guide generated
// alongside it -- writing the copy once here means the in-app page and the
// document handed out to a study team can never drift out of sync with each
// other. Plain, simple language on purpose: this is written for a staff
// member or respondent who has never used the app before, not a developer.
//
// Shape: { title, intro, sections: [ { heading, path, body: [paragraphs], tips: [short strings] } ] }
// `path` is optional -- shown as a small "where to find it" label under the heading.

const admin = {
  title: "Admin & Research Guide",
  intro:
    "Admin and Research accounts see exactly the same screens and can do exactly the same things in this pilot build — there's no separate \"read-only research\" mode yet. Everything below applies to both roles.",
  sections: [
    {
      heading: "Dashboard",
      path: "Dashboard (top of the menu)",
      body: [
        "This is your daily snapshot of how a study is running. Use the dropdown at the top to switch which study you're looking at.",
        "The cards at the top show Respondents, Diary Records, Completed entries, Draft/Incomplete entries, and Screened Out entries (ended early by a \"Terminate\" skip rule — see Skip Logic below).",
        "Recruitment Funnel shows how many respondents are at each stage, from first invited through fully completed.",
        "Respondent Risk Classification is a simple bar chart of how many respondents are currently Green (fine), Amber (some concern), or Red (needs attention) based on automated data-quality checks.",
        "Interviewer Monitoring shows how many respondents each face-to-face interviewer has recruited and how many of those are activated.",
        "Recent QC Flags shows the newest automated quality flags, with a link through to the full QC Worklist.",
      ],
      tips: [
        "\"Get the App\" opens a page with a QR code and link for opening the staff login screen on a phone.",
        "\"Run Reminder Engine\" sends any diary reminders that are due right now. This also happens automatically in the background every 15 minutes, so you don't have to click it — it's there for testing or an on-the-spot nudge.",
      ],
    },
    {
      heading: "Studies",
      path: "Studies (menu)",
      body: [
        "A list of every study on the platform. Click any one to open its configuration.",
        "The panel on the right creates a new study — just give it a name, market, and category. It starts in \"draft\" status; everything else (diary rules, questions, thresholds) is configured afterward inside that study.",
      ],
      tips: [],
    },
    {
      heading: "Study Config → Settings & Thresholds",
      path: "Studies → (pick a study) → Settings & Thresholds tab",
      body: [
        "This is the control panel for the whole study — nothing about how the diary behaves is hardcoded in the app, it all comes from these settings.",
        "Study Identity: the study's name, status (draft / live / closed), market and category.",
        "Diary Frequency & Recruitment: how often respondents log (real-time, daily, weekly, monthly), the recruitment mode, the recall window, how many hours back an entry can be backdated, and whether a photo is mandatory.",
        "Data-Quality Thresholds: how similar two entries need to be before they're flagged as a possible duplicate, and how many entries in how short a window count as a suspicious \"burst.\"",
        "Reminder Schedule: how many hours without an entry counts as \"due,\" how many hours counts as \"missed,\" and which channel reminders go out on by default — WhatsApp or In-app/Push (a real phone notification).",
      ],
      tips: ["Changing the diary mode or thresholds here takes effect immediately for every respondent in this study."],
    },
    {
      heading: "Study Config → Questionnaire, Skip Logic & Brands",
      path: "Studies → (pick a study) → Questionnaire, Skip Logic & Brands tab",
      body: [
        "Three related things live on this one page.",
        "Questionnaire: build the actual diary questions. Organize them into sections, add single-choice, multi-choice, numeric, text, date, or photo questions, and reorder them by dragging. You can also import questions from a spreadsheet or document instead of typing every one by hand — the app parses it, shows you a preview to check before anything is saved, and only commits once you approve it.",
        "Skip Logic: rules that act on a later question (or a whole section) depending on how an earlier question was answered — e.g. only ask a follow-up if someone answered \"Yes\" to a previous question. Three actions are available: Show or Hide a target question/section, or Terminate the survey — which ends the diary entry the moment a disqualifying answer is given (e.g. \"Do you live in this household?\" → \"No\"). A Terminate rule has a Scope: \"This diary entry only\" ends just that occasion (the respondent can still log future entries normally), while \"End the respondent's whole study participation\" disqualifies them outright, the same as an interviewer marking someone ineligible at registration — no further diary entries are possible after that. A terminated entry is saved with a \"Screened out\" status rather than being treated as a completed submission, so it doesn't count toward QC review or client reporting, but the answers already given up to that point are kept.",
        "Brands / SKU List: the list of brand and product names this study is trying to detect in photos and videos. This list is what brand-detection matches against.",
        "There's also a \"live preview\" that shows the questionnaire exactly as a respondent will see it on their phone, so you can check it before publishing.",
      ],
      tips: [],
    },
    {
      heading: "Study Config → Consent Wording",
      path: "Studies → (pick a study) → Consent Wording tab",
      body: [
        "Draft the legal/ethics consent text a respondent must agree to before their very first diary entry.",
        "Type new wording in the box on the right and save it as a draft — it appears as a new numbered version on the left.",
        "A version must be marked \"Approved\" before respondents ever see it. Respondents are always shown the latest approved version, never a draft.",
      ],
      tips: [],
    },
    {
      heading: "Study Config → Client KPIs",
      path: "Studies → (pick a study) → Client KPIs tab",
      body: [
        "Choose which metrics show up on the Client Dashboard for this study by turning them on or off.",
        "Add a custom KPI on the right if the standard set doesn't cover something the client specifically wants tracked.",
      ],
      tips: [],
    },
    {
      heading: "Study Config → Respondents",
      path: "Studies → (pick a study) → Respondents tab",
      body: [
        "Every respondent registered in this study: their code, name, recruitment mode, preferred channel, consent status, activation status, and an automated risk badge (Green/Amber/Red).",
        "The Lock column shows whether that respondent has set up their fingerprint/Face ID/PIN device lock (\"Locked\"), was let through without one because their device can't support it (\"Exempt\"), or hasn't opened their link yet (\"Pending\").",
        "Each row has a link that opens that respondent's diary directly, and a QR button that shows a scannable code for their personal link.",
      ],
      tips: [],
    },
    {
      heading: "Study Config → Media Review",
      path: "Studies → (pick a study) → Media Review tab",
      body: [
        "Every photo, video, and voice note a respondent has uploaded, with its brand-detection result or transcript and a link to view the actual file.",
        "The two banners at the top tell you honestly whether brand detection and voice-note transcription are actually running (calling a real Azure service) or still in demo/mock mode, where results always show as \"unavailable.\"",
      ],
      tips: [],
    },
    {
      heading: "QC Worklist",
      path: "QC Worklist (menu)",
      body: [
        "All automated data-quality flags for a study in one place — things like likely duplicate entries or a suspicious burst of entries in a short window.",
        "Filter by status: open, reviewed, resolved, or all.",
        "Mark a flag \"Review\" once you've looked at it, or \"Resolve\" once it's dealt with — you can add a short note either way.",
      ],
      tips: [],
    },
    {
      heading: "WhatsApp Outbox",
      path: "WhatsApp (menu)",
      body: [
        "A running log of every WhatsApp message the app has sent — reminders and confirmations. In demo/mock mode (no real WhatsApp account connected yet) these are simulated and shown here instead of actually being delivered.",
      ],
      tips: [],
    },
    {
      heading: "Users & Access",
      path: "Users (menu)",
      body: [
        "Every staff account on the platform — admin, research, interviewer, or client — and which study they're scoped to (blank means they can see every study).",
        "Create a new staff account on the right: name, email, password, role, and optionally the one study they should be limited to.",
      ],
      tips: [],
    },
  ],
};

const interviewer = {
  title: "Interviewer Guide",
  intro: "This is what you'll use in the field to register respondents face-to-face and hand them their diary link.",
  sections: [
    {
      heading: "My Respondents",
      path: "My Respondents (top of the menu)",
      body: ["Your own personal list of everyone you've registered face-to-face so far, and which study each one belongs to."],
      tips: [],
    },
    {
      heading: "Register",
      path: "Register (menu)",
      body: [
        "This is the face-to-face onboarding flow, done as one simple form: pick the study, screen the person for eligibility, confirm you've read them the consent wording and they've agreed verbally, then enter their name, contact, and preferred channel.",
        "If they're screened as not eligible, recruitment stops right there and nothing further happens.",
        "If they're eligible and consent, they're registered and activated immediately — no waiting for anyone else to approve it.",
      ],
      tips: [],
    },
    {
      heading: "Respondent Activated",
      path: "Shown automatically right after you register someone",
      body: [
        "A confirmation screen showing the respondent's unique code, a QR code, and their personal diary link.",
        "Hand your phone to the respondent so they can scan the QR code with their own phone's camera, or share the link with them directly — either way, this opens their diary for the first time.",
      ],
      tips: ["This link is personal to that one respondent — it shouldn't be shared with or used by anyone else."],
    },
  ],
};

const client = {
  title: "Client Guide",
  intro: "A read-only reporting view of how a study is progressing and what the data is showing so far.",
  sections: [
    {
      heading: "Client Dashboard",
      path: "Client Dashboard (menu)",
      body: [
        "If you're scoped to a single study you'll land straight on it; if you have access to more than one, use the dropdown to switch.",
        "You'll see the KPIs the research team has turned on for this study, respondent counts, diary completion rate, the automated QC flag rate, average occasions logged per respondent per week, and a Green/Amber/Red risk breakdown.",
        "Further down: which brands are being mentioned most in submitted entries, the mix of occasions respondents are logging, and a chart of submissions over time.",
      ],
      tips: ["Everything here reflects only submitted, non-practice entries — practice entries respondents use to try the diary out don't count toward any of these numbers."],
    },
  ],
};

const respondent = {
  title: "Respondent Guide — Using Your Diary",
  intro: "A quick guide to your personal diary link — what each step is for and how to use it.",
  sections: [
    {
      heading: "Your link",
      body: [
        "You were given a personal link — either shown as a QR code by an interviewer in person, or sent to you by WhatsApp/email. It's yours alone; please don't share it with anyone else.",
        "Add it to your phone's home screen (your browser's \"Add to Home Screen\" or \"Install\" option) so it opens like a regular app.",
      ],
      tips: [],
    },
    {
      heading: "Setting up your lock",
      body: [
        "The first time you open your link on a phone, you'll be asked to set up your fingerprint, Face ID, or screen lock so that only you can open your diary on that device.",
        "If your phone doesn't have fingerprint or Face ID support, you'll be let straight through — nothing further to do.",
        "Every time you come back after being away for a while, you'll be asked to unlock the same way again before you can see your diary.",
      ],
      tips: [],
    },
    {
      heading: "Giving consent",
      body: ["Before your very first entry, you'll be shown the study's consent wording and asked to agree before you can continue."],
      tips: [],
    },
    {
      heading: "Logging an entry",
      body: [
        "Tap \"Log Consumption\" and choose one of three ways to log:",
        "Standard Form — answer the questions one at a time. Most studies also ask for a photo, taken live with your camera at that moment (you can't choose an old photo from your gallery).",
        "Video (AI-assisted) — record one short video first. The app tries to automatically fill in some of the answers from what it sees in the video, and you finish anything it couldn't confidently work out.",
        "Voice Note — answer the questions as a normal form, then record a short spoken summary at the end by pressing and holding the microphone button, just like a WhatsApp voice message.",
      ],
      tips: [],
    },
    {
      heading: "Your diary history",
      body: [
        "Your home screen lists every entry you've submitted, its status, and which of the three ways you used to log it.",
        "Occasionally, based on one of your answers, an entry ends early and is marked \"screened out\" — that's expected for that occasion, not an error, and there's nothing more to do for it.",
      ],
      tips: [],
    },
    {
      heading: "Reminders",
      body: [
        "You may see a card asking to \"Enable reminders.\" Turning this on lets the study send you a notification on this device when it's time (or overdue) to log an entry.",
        "If you say \"Not now\" or your phone declines the permission, you won't be asked again — no pressure.",
      ],
      tips: [],
    },
  ],
};

module.exports = { admin, research: admin, interviewer, client, respondent };
