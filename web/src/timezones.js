// Zones the clients use most, shown first in the timezone picker.
export const COMMON_ZONES = [
  "Asia/Damascus", "Europe/Istanbul", "Asia/Riyadh", "Asia/Dubai", "Asia/Amman", "Asia/Beirut",
  "Asia/Baghdad", "Asia/Kuwait", "Asia/Qatar", "Asia/Bahrain", "Asia/Muscat", "Africa/Cairo",
  "Europe/Berlin", "Europe/London",
];

/** Every IANA zone the browser knows (falls back to the common ones). */
export function allZones() {
  try { return Intl.supportedValuesOf("timeZone"); } catch { return COMMON_ZONES; }
}

/** "Asia/Damascus (UTC+03:00)" — the offset is today's, so it follows summer time. */
export function zoneLabel(zone, at = new Date()) {
  let offset = "";
  try {
    const part = new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";
    offset = part === "GMT" ? "+00:00" : part.replace("GMT", "");
  } catch { /* unknown zone: name only */ }
  return offset ? `${zone.replace(/_/g, " ")} (UTC${offset})` : zone.replace(/_/g, " ");
}
