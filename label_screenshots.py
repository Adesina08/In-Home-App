#!/usr/bin/env python3
"""Combine all screenshots into one labeled PDF for stakeholder review."""
from PIL import Image, ImageDraw, ImageFont, JpegImagePlugin  # noqa: F401 (ensures JPEG save handler is registered)
import os

SRC = "/home/claude/inhome-app/screenshots"
OUT = "/home/claude/inhome-app/INICIO_MVP_UI_Screenshots.pdf"

titles = {
    "01-admin-ops-dashboard.png": "Admin — Operations Dashboard",
    "02-admin-studies-list.png": "Admin — Studies List",
    "03-dev-console-settings-thresholds.png": "Developer Console — Settings & QC Thresholds",
    "04-dev-console-questionnaire-builder.png": "Developer Console — Questionnaire Builder",
    "04b-dev-console-questionnaire-upload.png": "Developer Console — Upload Questionnaire",
    "04c-dev-console-questionnaire-review-import.png": "Developer Console — Review Import (editable + live preview)",
    "05-dev-console-skip-logic.png": "Developer Console — Skip Logic",
    "06-dev-console-brand-sku-list.png": "Developer Console — Brand / SKU List",
    "07-dev-console-consent-wording.png": "Developer Console — Consent Wording",
    "08-dev-console-client-kpis.png": "Developer Console — Client KPIs",
    "09-admin-respondents-list.png": "Admin — Respondents List",
    "09b-admin-media-review.png": "Admin — Media Review (brand detection)",
    "10-admin-qc-worklist.png": "Admin — QC Worklist",
    "11-admin-whatsapp-outbox.png": "Admin — WhatsApp Outbox (mock provider)",
    "12-admin-users.png": "Admin — Users",
    "13-interviewer-dashboard.png": "Interviewer — Dashboard",
    "14-interviewer-f2f-onboarding.png": "Interviewer — F2F Respondent Onboarding",
    "15-client-dashboard.png": "Client — Dashboard",
    "16-respondent-diary-home.png": "Respondent — Diary Home (desktop)",
    "17-respondent-diary-mode-picker.png": "Respondent — Log Entry: Choose a Method (desktop)",
    "17b-respondent-diary-entry-form.png": "Respondent — Diary Entry Form, Standard Mode (desktop)",
    "17c-respondent-diary-video-capture.png": "Respondent — Diary Entry, Video Mode: Record Screen (desktop)",
    "17d-respondent-diary-video-analyzed-form.png": "Respondent — Diary Entry, Video Mode: After AI Review (desktop)",
    "17e-respondent-diary-audio-mode-form.png": "Respondent — Diary Entry Form, Voice Note Mode (desktop)",
    "18-mobile-respondent-diary-home.png": "Respondent — Diary Home (mobile PWA)",
    "18b-mobile-respondent-diary-mode-picker.png": "Respondent — Log Entry: Choose a Method (mobile)",
    "19-mobile-respondent-diary-entry-form.png": "Respondent — Diary Entry Form (mobile, sticky action bar)",
    "19b-mobile-respondent-diary-entry-form-full.png": "Respondent — Diary Entry Form (mobile, full scroll)",
}

order = list(titles.keys())

try:
    font_title = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 28)
    font_sub = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 16)
except Exception:
    font_title = ImageFont.load_default()
    font_sub = ImageFont.load_default()

pages = []
BAND_H = 70
MAX_W = 1600

for i, fname in enumerate(order, 1):
    path = os.path.join(SRC, fname)
    if not os.path.exists(path):
        print("MISSING:", fname)
        continue
    img = Image.open(path).convert("RGB")
    if img.width > MAX_W:
        ratio = MAX_W / img.width
        img = img.resize((MAX_W, int(img.height * ratio)))

    canvas = Image.new("RGB", (img.width, img.height + BAND_H), "#1F3864")
    draw = ImageDraw.Draw(canvas)
    label = f"{i:02d}. {titles[fname]}"
    draw.text((24, 14), label, fill="white", font=font_title)
    draw.text((24, 46), fname, fill="#B9C6E0", font=font_sub)
    canvas.paste(img, (0, BAND_H))
    pages.append(canvas)

print(f"Assembled {len(pages)} pages")
pages[0].save(OUT, save_all=True, append_images=pages[1:])
print("Wrote", OUT)
