/**
 * The accumulating half of the wall.
 *
 * Live topics rotate — yesterday's memes are gone tomorrow. Archive topics
 * do the opposite: every build merges what it found into a growing collection
 * and nothing is ever dropped. A classic format found in March is still there
 * in December.
 *
 * Persisted as data/archive.json on the `state` branch, exactly like the
 * glossary, so it survives builds without cluttering main's history.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ARCHIVE_MAX } from './sources.mjs';

const log = (...a) => console.log('  arc ·', ...a);

export const EMPTY_ARCHIVE = { version: 1, updatedAt: null, seq: 0, items: [] };

export async function loadArchive(path) {
  try {
    const a = JSON.parse(await readFile(path, 'utf8'));
    const items = Array.isArray(a.items) ? a.items : [];
    log(`loaded ${items.length} archived items`);
    return { ...EMPTY_ARCHIVE, ...a, items };
  } catch {
    log('no archive yet — starting one');
    return structuredClone(EMPTY_ARCHIVE);
  }
}

export async function saveArchive(path, archive) {
  archive.updatedAt = new Date().toISOString();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(archive));
  const kb = (Buffer.byteLength(JSON.stringify(archive)) / 1024).toFixed(1);
  log(`saved ${archive.items.length} items, ${kb} KB`);
}

/**
 * Merge freshly-fetched items into the archive.
 * - Existing entries keep their original `addedAt` so "newest first" is stable.
 * - Nothing is removed unless the collection exceeds ARCHIVE_MAX, and then
 *   only the oldest additions go.
 * Returns the number of genuinely new items.
 */
export function mergeArchive(archive, fresh) {
  const byId = new Map(archive.items.map((i) => [i.id, i]));
  const now = Math.floor(Date.now() / 1000);
  // addedAt only has second resolution, so several items added in one build
  // would tie. A monotonic counter makes the ordering deterministic.
  let seq = archive.seq || archive.items.reduce((m, i) => Math.max(m, i.seq || 0), 0);
  let added = 0;

  for (const it of fresh) {
    const existing = byId.get(it.id);
    if (existing) {
      // Refresh volatile fields, keep the original position in the collection.
      existing.score = it.score ?? existing.score;
      existing.comments = it.comments ?? existing.comments;
      if (it.blurb && !existing.blurb) existing.blurb = it.blurb;
      continue;
    }
    byId.set(it.id, { ...it, addedAt: now, seq: ++seq });
    added++;
  }
  archive.seq = seq;

  // Newest additions first, so the tab always opens on what just arrived.
  const newestFirst = (a, b) => (b.seq || 0) - (a.seq || 0) || (b.addedAt || 0) - (a.addedAt || 0);

  let items = [...byId.values()].sort(newestFirst);
  if (items.length > ARCHIVE_MAX) {
    const dropped = items.length - ARCHIVE_MAX;
    items = items.slice(0, ARCHIVE_MAX);
    log(`over cap — dropped ${dropped} oldest`);
  }
  archive.items = items;

  log(`+${added} new, ${archive.items.length} total`);
  return added;
}
