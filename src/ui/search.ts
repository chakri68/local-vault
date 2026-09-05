import type { Collection, VaultItem } from "../vault/types.ts";

/**
 * §13. Built in memory after unlock, dropped on lock.
 *
 * There is no persisted index by design: a searchable index of filenames and
 * tags sitting on disk would undo §10. Rebuilding it costs one pass over the
 * manifest, which is nothing at the scale a personal document vault reaches.
 */
export interface IndexEntry {
  item: VaultItem;
  haystack: string;
  name: string;
}

export function buildIndex(items: VaultItem[], collections: Collection[]): IndexEntry[] {
  const byId = new Map(collections.map((c) => [c.id, c.name]));
  return items.map((item) => {
    const parts = [
      item.displayName,
      item.originalName ?? "",
      item.tags.join(" "),
      item.notes ?? "",
      item.collectionId ? (byId.get(item.collectionId) ?? "") : "",
      item.documentDate ?? "",
      item.expiresAt ?? "",
      item.importedAt.slice(0, 10),
    ];
    return {
      item,
      name: item.displayName.toLowerCase(),
      haystack: parts.join(" ").toLowerCase(),
    };
  });
}

/** Every term must appear somewhere. Name hits rank above metadata hits. */
export function search(index: IndexEntry[], query: string): VaultItem[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return index.map((e) => e.item);

  const hits: { entry: IndexEntry; score: number }[] = [];
  for (const entry of index) {
    let score = 0;
    let all = true;
    for (const term of terms) {
      if (entry.name.includes(term)) score += 3;
      else if (entry.haystack.includes(term)) score += 1;
      else {
        all = false;
        break;
      }
    }
    if (all) hits.push({ entry, score });
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      b.entry.item.importedAt.localeCompare(a.entry.item.importedAt),
  );
  return hits.map((h) => h.entry.item);
}
