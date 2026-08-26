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
  title: "Admin Guide",
  intro:
    "This covers every screen an Admin account can reach. Staff roles are Admin (full configuration and monitoring), Interviewer (face-to-face recruitment only) and Client (read-only reporting for their own study).",
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
      heading: "Closing a study",
      path: "Studies → (pick a study) → Settings & Thresholds tab → Status",
      body: [
        "Setting a study's status to \"closed\" freezes its dataset for delivery, so the app checks first: if any critical or high QC flags are still unreviewed, the close is refused and the blocking flags are listed for you, with a link straight to the QC Worklist.",
        "Nothing else on the settings form is saved when a close is refused — fix the flags, then set the status again.",
      ],
      tips: ["Marking a flag \"Reviewed\" is enough to unblock closing; it doesn't have to be \"Resolved\"."],
    },
    {
      heading: "Study Config → Settings & Thresholds",
      path: "Studies → (pick a study) → Settings & Thresholds tab",
      body: [
        "This is the control panel for the whole study — nothing about how the diary behaves is fixed in the code, it all comes from here.",
        "Study Identity: the study's name, status (draft / live / closed), market, and the categories it covers. Categories are a tick-list and a study can sit in several at once, since a household diary often spans more than one.",
        "How often people log, and how they're recruited: real-time occasion, daily, weekly or monthly; and whether respondents are recruited face-to-face, remotely through the sign-up link, or both.",
        "Evidence: whether every entry must include a photo. An entry without one is still saved — it's flagged for review, never rejected.",
        "Automatic quality checks: three checks that run on every entry as it's submitted. Each is a plain sentence with the numbers in it, and each has a tick-box — untick one and that check stops running entirely for this study. The checks are: flag an entry logged more than X hours after it happened; flag an entry when X% or more of its answers match that person's previous entry; and flag when someone logs more than X entries within X hours.",
        "None of these checks ever rejects or deletes anything. They add the entry to the QC Worklist for a person to look at, which is why switching one off is sometimes the right answer — a study where people genuinely eat the same thing every day will trip the repeat check constantly, and dismissing the same flag daily helps nobody.",
        "Reminders: how many hours without an entry before a reminder goes out, how many before it counts as missed, and how reminders are sent by default. Leave the hours blank and the app works them out from how often people are asked to log.",
      ],
      tips: ["Changes here take effect immediately for every respondent in this study."],
    },
    {
      heading: "Study Config → Questionnaire, Skip Logic & Brands",
      path: "Studies → (pick a study) → Questionnaire, Skip Logic & Brands tab",
      body: [
        "Three related things live on this one page.",
        "Questionnaire: build the actual diary questions. Organize them into sections, add single-choice, multi-choice, numeric, text, date, photo, video or audio questions, and reorder them by dragging. A photo or video question asks for evidence captured live on the camera; an audio question asks the respondent to answer that question out loud, press-and-hold like a WhatsApp voice message, and the recording is transcribed automatically. (That's separate from the end-of-entry Voice Note, which attaches one spoken summary to the whole entry rather than to a particular question.) You can also import questions from a spreadsheet or document instead of typing every one by hand — the app parses it, shows you a preview to check before anything is saved, and only commits once you approve it.",
        "Skip Logic: rules that act on a later question (or a whole section) depending on how an earlier question was answered — e.g. only ask a follow-up if someone answered \"Yes\" to a previous question. Three actions are available: Show or Hide a target question/section, or Terminate the survey — which ends the diary entry the moment a disqualifying answer is given (e.g. \"Do you live in this household?\" → \"No\"). A Terminate rule has a Scope: \"This diary entry only\" ends just that occasion (the respondent can still log future entries normally), while \"End the respondent's whole study participation\" disqualifies them outright, the same as an interviewer marking someone ineligible at registration — no further diary entries are possible after that. A terminated entry is saved with a \"Screened out\" status rather than being treated as a completed submission, so it doesn't count toward QC review or client reporting, but the answers already given up to that point are kept.",
        "Piping (personalising question wording): type a token in curly braces into a question and it's replaced with a real value when the respondent sees it. Use {respondent_name}, {respondent_code}, {study_name}, {study_market} or {study_category} for details you already hold, or {q:CODE} to repeat back what they answered to an earlier question — for example \"Which pack size of {q:BRAND} did you buy?\" fills in whatever brand they just picked, updating live as they answer. Add a fallback after a vertical bar for wording that still reads properly before they've answered: {q:BRAND|that brand}. A token that's misspelled is shown as-is rather than silently deleted, so you can spot it in the live preview.",
        "Versions: the questionnaire carries a version number, shown next to the Preview button. Editing any question, section or skip rule marks it as having unpublished changes; clicking Publish stamps every diary entry saved from then on with the new version. Entries already collected keep the version they were actually answered against, so the data stays honest about which wording produced which answers.",
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
        "Invite someone to this study: enter a phone number or email and they are added straight away. If that person already has an account — from this or any other study — the invite attaches to it, so someone on their third study isn't re-registered from scratch and all their enrolments stay under one identity. They appear as \"invited\" with consent pending until they open the study and agree to take part, because consent is recorded per study against that study's approved wording and never carries over from another one.",
        "If the contact is already on this study as an existing respondent, the invite is refused rather than creating a second enrolment — two enrolments would split one person's diary and read as a duplicate in every report. Open that respondent instead and use the Sign-in account panel to link them.",
        "Sign-in account (on a respondent's own page): shows whether that person can sign in at /me to see all their studies in one place, and which other studies sit on the same account. A respondent recruited face-to-face has no account by default; the button there gives them one, or links them to an account that already exists for their number. That is deliberately a decision you make rather than something the app assumes: contacts collected in the field were never verified, and a household sharing one phone is a legitimate case that must stay as two separate respondents.",
        "Remote sign-up link: the panel at the top of this screen holds a shareable link and QR code for recruiting people remotely — they read the consent wording, enter their name and contact, verify it with a code sent to them, watch a short walkthrough, and their diary activates automatically. The link only works while the study is \"live\" and its recruitment mode is \"remote\" or \"hybrid\"; otherwise anyone opening it sees a polite \"not accepting sign-ups\" message, and the panel tells you so.",
        "A respondent showing as \"registered\" has been held by a recruitment check — either their phone/contact already matches someone else in this study, or they were registered without consent recorded. They keep their diary link but can't submit anything until someone reviews the flag on the QC Worklist and clicks Activate on this screen. Releasing the hold deliberately leaves the flag open so the decision stays visible and auditable; resolve it separately on the worklist once you're satisfied.",
        "The Lock column shows whether that respondent has set up their fingerprint/Face ID/PIN device lock (\"Locked\"), was let through without one because their device can't support it (\"Exempt\"), or hasn't opened their link yet (\"Pending\").",
        "Click any respondent's code or name to open their record: their profile and device-lock status, every QC flag raised against them, and every diary entry they have logged with how they logged it, whether photo/video/audio is attached, and how many flags each entry carries.",
        "From there, clicking an entry shows exactly what that respondent answered, question by question, in questionnaire order. Photos and video appear inline with the brand-detection result; audio can be played with its transcript underneath. It also shows the occurrence, entry and submit times, the back-entry gap those QC rules act on, and which questionnaire version the answers were given against. Where an entry has many unanswered questions, they are collapsed behind a tick-box — most of those are questions the skip logic never showed, and listing them all would bury the real answers.",
        "These pages are deliberately read-only. Flags are reviewed and dispositioned on the QC Worklist, which keeps the original record intact and the decision audited — nothing here edits a respondent's answers.",
        "You can export one respondent's full answer history, their media log, or a single entry, as well as the study-level exports. Answers export one row per answer rather than one wide row per entry, so a questionnaire that changes between versions doesn't silently misalign columns.",
        "Each row also has a link that opens that respondent's diary directly, and a QR button that shows a scannable code for their personal link.",
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
        "Each flag links straight through to the diary entry that caused it, so you can see what the respondent actually answered before deciding what to do about it.",
      ],
      tips: [],
    },
    {
      heading: "AI Summary",
      path: "AI Summary (menu)",
      body: [
        "Produces a short written summary of what the diary data is showing, for a period you choose. Leave both dates blank to cover everything collected so far.",
        "Only submitted, non-practice entries are counted, and every figure in the write-up is calculated by the app itself — the wording is generated from those finished numbers, never from the raw data — so a summary can't quote a statistic that isn't real. Up to 25 open-text answers from the same period are included for context and stored with the summary.",
        "Each summary shows the period it covers and the base it was built on (how many entries, from how many respondents), and \"Show the exact figures this was written from\" opens the full set of numbers and verbatims behind it. That means any sentence can be checked against its source.",
        "The banner at the top tells you honestly whether a real AI model is connected. Until one is, summaries are written from a fixed template using the same validated figures and are clearly labelled \"Rules-based draft — not AI\" rather than being passed off as AI-written.",
        "The most recent summary for a study also appears on that study's Client Dashboard. Clients can read it but cannot generate one, so nothing reaches them that the research team hasn't produced first.",
      ],
      tips: [
        "Re-run the summary after clearing QC flags — the write-up will tell you when unresolved flags mean the figures shouldn't be treated as final.",
      ],
    },
    {
      heading: "Message Log",
      path: "WhatsApp (menu)",
      body: [
        "Every text message the app has sent, or would have sent: diary links, diary reminders and the one-time codes people use to sign in. Each row shows the exact words that went out, the number it went to, and — for anything that failed — the reason.",
        "The banner at the top tells you which of two states you're in. Live means messages really are being delivered. Mock means nothing is leaving the server and every message is only being written here, which is useful for checking the wording before you go live but means no respondent is actually being contacted.",
        "Connecting a real provider is a configuration step, not a code change — see PRODUCTION_READINESS.md section B1. Until it's done, respondents can't sign in with a one-time code either, since the code has nowhere to go; hand out diary links by QR code instead.",
      ],
      tips: ["Numbers must be stored in international format (+234...) for messages to send."],
    },
    {
      heading: "Users & Access",
      path: "Users (menu)",
      body: [
        "Every staff account on the platform — admin, interviewer, or client — and which study they're scoped to (blank means they can see every study).",
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
        "Hold your phone up so the respondent can scan the QR code with their own phone's camera. That opens their diary on their device for the first time.",
      ],
      tips: ["This link is personal to that one respondent — it shouldn't be shared with or used by anyone else."],
    },
    {
      heading: "Handing someone their link later",
      path: "My Respondents → Show link",
      body: [
        "Every respondent on your roster has a Show link button. It opens a page with their QR code, their link to copy, and a button to text the link to the number they gave you when they registered.",
        "Use it when someone loses their link, changes phone, or would rather receive it as a text and open it later.",
        "If texting isn't connected on your deployment yet, the button will tell you so rather than pretending the message went — use the QR code in that case.",
      ],
      tips: [
        "Never open a respondent's diary on your own phone. The diary locks itself to the first phone that opens it, using that phone's fingerprint or Face ID — so opening it on yours can leave the respondent unable to get into their own diary. Always hand the link over instead.",
      ],
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
        "If the research team has produced a written summary of the data, it appears here too, with the period and base size it was built from. It is labelled to show whether it was written by an AI model or generated from a fixed template — read it alongside the numbers rather than in place of them.",
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
      heading: "Signing in",
      body: [
        "If you signed yourself up, you also have an account. Go to /me, enter the phone number or email you signed up with, and we'll text or email you a short code — there's no password to remember.",
        "Once you're in, \"My studies\" lists every study you're taking part in, with your progress on each, so you don't need to keep track of a separate link for each one.",
        "Each study asks for your consent separately. Agreeing to take part in one never signs you up to another.",
        "If a study team adds you to a new study, it simply appears in that list the next time you sign in.",
      ],
      tips: ["The code lasts 10 minutes. If it expires or doesn't arrive, ask for a new one."],
    },
    {
      heading: "Your link",
      body: [
        "You were given a personal link — either shown as a QR code by an interviewer in person, sent to you by WhatsApp/email, or created for you at the end of signing yourself up. It's yours alone; please don't share it with anyone else.",
        "Your link keeps working whether or not you have an account, so if you were recruited in person there's nothing extra to set up.",
        "If you signed up yourself through an invite link, you'll have read the consent wording, entered your name and contact, and typed in a short code we sent you to confirm we can reach you. That code lasts 10 minutes — if it expires or doesn't arrive, just ask for a new one.",
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
        "Some questions ask you to answer out loud instead of typing — press and hold the microphone button on that question and speak your answer, just like a WhatsApp voice message. Let go when you're done, and you can play it back or re-record before submitting.",
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

module.exports = { admin, interviewer, client, respondent };
