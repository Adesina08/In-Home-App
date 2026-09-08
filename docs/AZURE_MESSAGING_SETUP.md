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

## Controlled verification order

1. Confirm `/health/ready` returns HTTP 200.
2. Send one invitation or OTP to the verified Resend sender/recipient and confirm receipt plus a `resend_email` Message Log row.
3. After Twilio error 63038's rolling limit resets, send one SMS to a verified trial recipient and inspect its Message Log row.
4. Send a message from the joined WhatsApp phone to open the 24-hour window, then request one WhatsApp OTP and inspect its Message Log row.
5. Only then set `RESPONDENT_OTP_BYPASS=false`.

Trial delivery is not production readiness. Upgrade Twilio, register an approved WhatsApp Business sender and templates, authenticate the email domain, and repeat the tests before inviting real participants.
