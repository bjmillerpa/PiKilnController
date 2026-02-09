export const c2f = (c) => c * 9 / 5 + 32;

export function fmtTemp(c) {
  if (c == null || c === -999) return '--';
  return Math.round(c2f(c)) + '\u00B0F';
}

export function fmtTempC(c) {
  if (c == null || c === -999) return '--';
  return Math.round(c) + '\u00B0C';
}

export function fmtDuration(seconds) {
  if (!seconds || seconds < 0) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

export function fmtHours(hrs) {
  if (!hrs || hrs <= 0) return '--';
  const h = Math.floor(hrs);
  const m = Math.round((hrs - h) * 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

export function fmtPower(kwh, costPerKWH) {
  const cost = kwh * (costPerKWH || 0.12);
  return `${kwh.toFixed(1)} kWh  $${cost.toFixed(2)}`;
}
