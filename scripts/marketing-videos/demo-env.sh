# Demo-only environment: a throwaway local JSON database inside .work/, and
# every external service mocked or blanked. Source this before seeding or
# starting the demo server; it must never point at a real database.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export MONGODB_URI= MONGODB_DB=
export LOCAL_DB_PATH="$HERE/.work/demo.localdb.json" UPLOAD_DIR="$HERE/.work/uploads" STORAGE_PROVIDER=local
export PORT=3100 NODE_ENV=development APP_BASE_URL=http://localhost:3100 SESSION_SECRET=demo-marketing-secret
export MESSAGING_PROVIDER=mock BRAND_DETECTION_PROVIDER=mock AUDIO_TRANSCRIPTION_PROVIDER=mock VIDEO_FIELD_EXTRACTION_PROVIDER=mock
export GEMINI_API_KEY= OPENAI_API_KEY=
export TWILIO_ACCOUNT_SID= TWILIO_AUTH_TOKEN= TWILIO_API_KEY_SID= TWILIO_API_KEY_SECRET= RESEND_API_KEY= SENDGRID_API_KEY= APPLICATIONINSIGHTS_CONNECTION_STRING=
export AZURE_STORAGE_CONNECTION_STRING= AZURE_STORAGE_ACCOUNT_KEY= REMINDER_ENGINE_AUTORUN=false
mkdir -p "$HERE/.work/uploads"
