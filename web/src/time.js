export function serverOffset(serverTime) {
  return serverTime - Date.now() / 1000;
}
export function nowWithOffset(offset) {
  return Date.now() / 1000 + offset;
}
export function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `${h}:${pad(m)}:${pad(ss)}`;
}
export function formatHours(sec) {
  return (Math.max(0, sec) / 3600).toFixed(2);
}
export function formatClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const pad = (n) => String(n).padStart(2, "0");
  return { h: Math.floor(s / 3600), mm: pad(Math.floor((s % 3600) / 60)), ss: pad(s % 60) };
}
