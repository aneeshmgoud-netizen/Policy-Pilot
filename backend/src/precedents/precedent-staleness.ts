export interface PolicyVersionEntry {
  documentName: string;
  version: string;
}

/**
 * A precedent is stale if ANY document in its stored snapshot no longer
 * matches the current corpus, including a document that was renamed or
 * removed. Snapshot data was captured unscoped, so this deliberately compares
 * the whole snapshot and fails closed on malformed data.
 */
export function isPrecedentStale(
  policyVersionSnapshot: unknown,
  currentVersions: PolicyVersionEntry[],
): boolean {
  if (!Array.isArray(policyVersionSnapshot)) {
    return true;
  }

  const currentByName = new Map(
    currentVersions.map((document) => [document.documentName, document.version]),
  );
  for (const entry of policyVersionSnapshot) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof (entry as Record<string, unknown>).documentName !== 'string' ||
      typeof (entry as Record<string, unknown>).version !== 'string'
    ) {
      return true;
    }

    const { documentName, version } = entry as PolicyVersionEntry;
    if (currentByName.get(documentName) !== version) {
      return true;
    }
  }

  return false;
}
