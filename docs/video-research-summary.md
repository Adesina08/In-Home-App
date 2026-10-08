# Research summary and highlight video

The admin Video Summary page processes every eligible video in the selected study and date range, then produces a written overview, findings grouped by study question, and a highlight reel. Existing report eligibility rules still exclude practice, withdrawn, excluded and unresolved QC entries.

## Configuration

- Video understanding uses `GEMINI_API_KEY`. `VIDEO_RESEARCH_MODEL` optionally overrides `GEMINI_MODEL`; otherwise the existing Gemini client default is used. OpenAI summary configuration does not provide video understanding.
- Written synthesis supports `AI_SUMMARY_PROVIDER=openai` (default) or `gemini`. Set `OPENAI_API_KEY` on the server and optionally `OPENAI_SUMMARY_MODEL` (default `gpt-5.4-mini`). OpenAI uses the [Responses API](https://developers.openai.com/api/docs/guides/text) with `store: false`; an absent key disables generation rather than silently falling back to Gemini. Restart the server after changing environment configuration.
- OpenAI handles the findings, grouping and written overview. Video evidence extraction still uses Gemini and its own credentials. A summary-provider change does not remove video-provider outages.
- Local files and Azure Blob media use the existing media storage adapter. No new dependencies are required. OpenAI summarisation needs its own API key even when Gemini video analysis is configured.
- Video analysis uses Gemini's multimodal inline-video interface, documented in [Google's video understanding guide](https://ai.google.dev/gemini-api/docs/generate-content/video-understanding).

## Evidence and coverage

Videos are decoded in 45-second windows overlapping by three seconds, through the complete source duration. Gemini extracts timestamped speech and separately labelled visual observations. The prepared video is resized to a maximum width of 640 pixels; subtle packaging details can be missed. Timestamp bounds, question keys and response structure are checked; malformed or interrupted model output becomes a failed window. AI speech and observations are still proposals that require researcher verification.

There is no 60-video selection and no 1,200-character transcript cut-off. Research synthesis receives bounded batches of evidence, links findings to evidence IDs, and merges findings without dropping source finding IDs. Counts are calculated from distinct supporting people and recordings, not supplied by the model. The base for a question is the number of distinct people with extracted evidence assigned to that question, not everyone in the study. Semantic support and question assignments remain subject to review.

The saved coverage report distinguishes fully processed, partially processed, failed and unavailable videos, plus videos and respondents with relevant evidence. Failed ranges remain visible. Missing analysis is never a negative response. Approval with partial coverage requires explicit acknowledgement, and clients see that coverage too. Videos with no relevant evidence do not produce invented findings.

Completed per-video analysis is cached in `media.research_video_json` using the file reference, model, questions and analysis version. Upload references are assumed immutable. Failed or partial videos are retried on regeneration. No source media is modified.

## Review and publication

1. Generate the summary. The HTTP request returns immediately; the saved page shows progress while processing continues.
2. Inspect the findings, exact supporting moments and coverage. The source player links include the proposed time range.
3. Edit the overview and findings, choose their order, remove findings, and select supporting clips. Start/end edits must keep the complete supporting moment and stay within source duration.
4. Save the review. This revokes prior approval and rebuilds the reel. Clips seek to their selected start time; complete speech moments within each clip supply captions. An unreadable selected source fails the build rather than silently disappearing.
5. Watch the finished reel and confirm the evidence review before approval. Clients only see the approved version. Quotes and reel access also require the client's media permission and current respondent consent.

Evidence or consent changes block approval/rebuilding of an outdated summary. Review revisions prevent stale browser forms overwriting newer edits. Legacy summaries remain readable; regenerate them to obtain editable timestamped evidence.

## Operations and limits

Generation and FFmpeg rendering currently run as background tasks in the application process, not a durable distributed worker queue. After a restart, interrupted generation can be started again; completed video analysis is retained. Keep this worker on a single application instance until a shared job queue is introduced. Large studies take multiple provider calls and may incur corresponding usage charges. Video requests have a 90-second timeout with two attempts. Research text requests also use a 90-second timeout; the existing text-provider retry policy still applies. Provider failures remain visible instead of becoming fabricated results.

The AI-proposed timecodes, transcript accuracy, interpretation and clip context require human review. A synthetic provider test does not establish accuracy on real respondent recordings, languages or recording conditions.

## Validation

`node --test tests/*.test.js` covers evidence collection beyond 60 videos, untruncated transcripts, full-duration windows, invalid timecodes/citations, distinct counts across batches, real FFmpeg seeking/captions, background generation, review/approval, incomplete coverage and client consent/grants. Provider responses in automated tests are fixtures; FFmpeg processes actual synthetic video files.

Live synthetic validation on 2026-09-28: the configured Gemini model extracted timecoded visual observations from a three-second colour-change video. The subsequent research synthesis returned HTTP 503 (high demand), so end-to-end live generation remains unverified. No respondent media was used in this check.
