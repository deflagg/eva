export function formatIsoTimestamp(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

export function makeRunId(nowMs: number, pid: number): string {
  const iso = formatIsoTimestamp(nowMs);
  const base = iso.slice(0, 19).replace('T', '_').replaceAll(':', '-');
  return `${base}_pid${pid}`;
}
