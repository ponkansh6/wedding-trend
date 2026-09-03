export const READ_STATUS_STORAGE_KEY = "wedding-trend.feed-read-status";

type PersistedReadStatusV1 = {
  version: 1;
  readCardIds: string[];
};

export type ReadStatusStorageResult = {
  readCardIds: string[];
  /** A known V1 value was malformed and may safely be repaired. */
  shouldRepair: boolean;
};

function normalizeReadCardIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const ids = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string") continue;
    const normalized = id.trim();
    if (normalized.length > 0) ids.add(normalized);
  }
  return [...ids];
}

/**
 * Reads only the browser-local card ID list. Unknown versions are deliberately
 * left untouched so a newer client never loses its data to this client.
 */
export function readReadStatus(storage: Pick<Storage, "getItem">): ReadStatusStorageResult {
  let raw: string | null;
  try {
    raw = storage.getItem(READ_STATUS_STORAGE_KEY);
  } catch {
    return { readCardIds: [], shouldRepair: false };
  }

  if (raw === null) return { readCardIds: [], shouldRepair: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { readCardIds: [], shouldRepair: true };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { readCardIds: [], shouldRepair: true };
  }

  const record = parsed as { version?: unknown; readCardIds?: unknown };
  if (typeof record.version !== "number") {
    return { readCardIds: [], shouldRepair: true };
  }
  if (record.version !== 1) return { readCardIds: [], shouldRepair: false };

  const readCardIds = normalizeReadCardIds(record.readCardIds);
  const hasOnlyV1Keys = Object.keys(record).every(
    (key) => key === "version" || key === "readCardIds",
  );
  return {
    readCardIds,
    shouldRepair:
      !hasOnlyV1Keys ||
      !Array.isArray(record.readCardIds) ||
      record.readCardIds.length !== readCardIds.length ||
      record.readCardIds.some(
        (id) => typeof id !== "string" || id.trim() !== id || id.length === 0,
      ),
  };
}

/** Best-effort persistence. Callers keep their in-memory state if this fails. */
export function writeReadStatus(
  storage: Pick<Storage, "setItem">,
  readCardIds: Iterable<string>,
): boolean {
  const value: PersistedReadStatusV1 = {
    version: 1,
    readCardIds: normalizeReadCardIds([...readCardIds]),
  };
  try {
    storage.setItem(READ_STATUS_STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
