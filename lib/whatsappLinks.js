function configuredNumber() {
  return (process.env.WHATSAPP_BOT_NUMBER || process.env.TWILIO_WHATSAPP_FROM_NUMBER || "").trim() || null;
}

function chatUrl(inviteToken) {
  const configured = configuredNumber();
  if (!configured) return null;
  const digits = configured.replace(/^whatsapp:/i, "").replace(/\D/g, "");
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(`JOIN ${inviteToken}`)}`;
}

module.exports = { configuredNumber, chatUrl };
