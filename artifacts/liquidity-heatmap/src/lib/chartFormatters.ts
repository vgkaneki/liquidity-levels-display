export function formatDate(ts: number): string {
  const d = new Date(ts);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

export function formatPrice(price: number, precision?: string): string {
  if (precision && precision !== "default") {
    const n = parseInt(precision, 10);
    if (Number.isFinite(n)) return price.toFixed(n);
  }
  if (price >= 10000) return price.toFixed(2);
  if (price >= 100) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(5);
  return price.toFixed(8);
}

export function calculateGridStep(range: number): number {
  const rawStep = range / 8;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  let step: number;
  if (normalized < 1.5) step = 1;
  else if (normalized < 3.5) step = 2;
  else if (normalized < 7.5) step = 5;
  else step = 10;
  return step * magnitude;
}
