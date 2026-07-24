// Light display mask for identifiers in the UI (EMP-52190 -> EMP-***90). The
// reviewer can still see the full id in the detail panel; this just avoids
// splashing raw ids across the list view.
export function maskEmployeeId(id: string): string {
  const hyphen = id.indexOf('-');
  if (hyphen < 0) return id;
  const prefix = id.slice(0, hyphen + 1);
  const body = id.slice(hyphen + 1);
  if (body.length <= 2) return prefix + '*'.repeat(body.length);
  return prefix + '*'.repeat(body.length - 2) + body.slice(-2);
}
