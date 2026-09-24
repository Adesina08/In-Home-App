# Azure messaging setup

This deployment routes respondent messages as follows:

- Email contact: Resend email
- Phone contact with `preferred_channel=whatsapp`: Twilio WhatsApp
- Other phone contact: Twilio SMS
- Explicit study reminder channel: that channel, provided the respondent has a compatible contact

Never commit an Auth Token or API key. Enter secrets directly in Azure Portal.

## Azure App Service settings

Open Azure Portal → App Services → the INICIO app → Settings → Environment variables. Add or update:

```text
APP_BASE_URL=https://in-home-app-e8dkcnc7eefjgycv.francecentral-01.azurewebsites.net

RESEND_API_KEY=<a newly generated Resend API key>
RESEND_FROM=tech team <iniciomis@inicio-insights.com>

MESSAGING_PROVIDER=twilio
TWILIO_ACCOUNT_SID=<the AC value from Twilio Account Dashboard>
TWILIO_AUTH_TOKEN=<the secret Auth Token from Twilio Account Dashboard>
TWILIO_SMS_FROM_NUMBER=<the assigned SMS-capable Twilio number in E.164 format>
TWILIO_WHATSAPP_FROM_NUMBER=+14155238886
TWILIO_WHATSAPP_OTP_CONTENT_SID=<approved authentication HX SID>
TWILIO_WHATSAPP_SURVEY_INVITE_CONTENT_SID=<approved utility HX SID>
TWILIO_WHATSAPP_DIARY_INVITE_CONTENT_SID=<approved utility HX SID>
TWILIO_WHATSAPP_DIARY_DUE_CONTENT_SID=<approved utility HX SID>
TWILIO_WHATSAPP_DIARY_MISSED_CONTENT_SID=<approved utility HX SID>
TWILIO_CHANNEL=sms

WHATSAPP_BOT_NUMBER=+14155238886
VERIFY_TWILIO_WEBHOOKS=true
WHATSAPP_MEDIA_MAX_BYTES=16777216
```

`RESEND_FROM` is the preferred sender setting. The older split form,
`RESEND_FROM_EMAIL` plus `RESEND_FROM_NAME`, and the `SENDER_EMAIL` alias are
also accepted. Do not configure both forms unless they represent the same
address; `RESEND_FROM` takes precedence.

If a Resend API key has appeared in chat, logs, screenshots, source code, or a
committed environment file, revoke it and generate a new one before adding it
to Azure.

Leave `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, and the Messaging Service SID settings empty during the trial unless those resources have deliberately been created. The Auth Token is required for Twilio webhook signature verification and inbound media download.

Keep this setting enabled until both email and phone delivery tests pass:

```text
RESPONDENT_OTP_BYPASS=true
```

Click Apply and allow the App Service to restart. After successful controlled OTP tests on every enabled channel, change it to:

```text
RESPONDENT_OTP_BYPASS=false
```

Turning the bypass off before delivery works can lock respondents out.

## Twilio WhatsApp Sandbox webhook

Configure the Sandbox's incoming-message webhook as HTTP POST:

```text
https://in-home-app-e8dkcnc7eefjgycv.francecentral-01.azurewebsites.net/webhooks/twilio/whatsapp
```

The Sandbox is for testing only. Each test phone must join it. Free-form WhatsApp messages are limited to the 24-hour customer-service window after that person messages the Sandbox; business-initiated messages outside that window require an approved template.

The four utility templates use the same numbered variables:

```text
{{1}} respondent name
{{2}} study name
{{3}} personal invitation or WhatsApp JOIN link
```

Create and approve each template in Twilio's Content Template Builder, then put
its `HX...` SID in the matching setting above. Diary reminders receive a
`wa.me` link prefilled with the respondent's personal `JOIN` token, so tapping
the reminder selects the correct study before `DIARY` begins. List Picker SIDs
remain separate and work only after the respondent has opened the 24-hour
conversation window.

## Native WhatsApp Flow diary forms

`lib/whatsappFlow.js` compiles the supported part of a published questionnaire
to WhatsApp Flow JSON. Publish that JSON as a versioned Flow in Twilio/Meta and
configure the resulting Content SID using either:

```text
TWILIO_WHATSAPP_FLOW_CONTENT_SID=HX...  # one-study/default pilot
TWILIO_WHATSAPP_FLOW_CONTENT_SIDS={"12:3":"HX...","default":"HX..."}
WHATSAPP_FLOW_TOKEN_SECRET=<long-random-secret>
```

Generate and publish each immutable questionnaire version in this order:

```bash
npm run whatsapp:flow:export -- 12 ./inicio-study-12-v3-flow.json
# Upload and publish that JSON as a Flow in Meta, then copy its Flow ID.
npm run whatsapp:flow:template -- 12 <META_FLOW_ID>
```

The second command creates the Twilio `whatsapp/flows` Content object and prints
the exact `TWILIO_WHATSAPP_FLOW_CONTENT_SIDS` mapping to add to the deployment.
It does not submit approval automatically; review the content and request
WhatsApp approval in Twilio before relying on it for cold reminder sends.
Respondent-initiated `DIARY` messages and due/missed WhatsApp reminders open the
same native form. Signed tokens bind each submission to its respondent, study
and questionnaire version.
The preferred map key is `studyId:questionnaireVersion`; this prevents an old
immutable Flow from collecting answers against a newly published questionnaire.
Text, single choice, multi choice, numeric, scale, date and time questions can
appear in the form. Media, rotating/scheduled questions and skip logic that
cannot be represented exactly stay in the WhatsApp chat. If no Flow SID is
configured or sending fails, the respondent automatically continues through
the normal chat questionnaire.

## Controlled verification order

1. Confirm `/health/ready` returns HTTP 200.
2. Send one invitation or OTP to the verified Resend sender/recipient and confirm receipt plus a `resend_email` Message Log row.
3. After Twilio error 63038's rolling limit resets, send one SMS to a verified trial recipient and inspect its Message Log row.
4. Send a message from the joined WhatsApp phone to open the 24-hour window, then request one WhatsApp OTP and inspect its Message Log row.
5. Send one due reminder after closing the test window (or through an approved-template test) and confirm the configured Content SID is accepted.
6. If native Flows are enabled, open the configured Flow on the test phone, submit it, and confirm its structured answers plus any chat-collected media are stored in one diary record.
7. Complete one full `JOIN` → `DIARY` → media/answer → submission interaction on the test phone, including pause/back/withdrawal cancellation and close-out.
8. Only then set `RESPONDENT_OTP_BYPASS=false`.

Trial delivery is not production readiness. Upgrade Twilio, register an approved WhatsApp Business sender and templates, authenticate the email domain, and repeat the tests before inviting real participants.
