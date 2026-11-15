// One list of pictures per "kind" (bulletin board, screensaver), drawn from a
// Dropbox folder when connected and always from a local folder as well.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './store.js';
import * as dropbox from './dropbox.js';

export const KINDS = { board: 'board', screensaver: 'screensaver' };
const IMAGE_RE = /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?)$/i;
const LOCAL_DISPLAYABLE = /\.(jpe?g|png|gif|webp|bmp|svg)$/i; // no server-side converter for HEIC/TIFF
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const SIZES = { thumb: 'w640h480', full: 'w2048h1536' };
fs.mkdirSync(CACHE_DIR, { recursive: true });

const localDir = (kind) => {
  const dir = path.join(DATA_DIR, kind);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const encodeId = (s) => Buffer.from(s).toString('base64url');
export const decodeId = (id) => Buffer.from(id, 'base64url').toString();

const listCache = new Map(); // kind -> { at, items }

export async function list(kind, settings, { fresh = false } = {}) {
  const cached = listCache.get(kind);
  if (!fresh && cached && Date.now() - cached.at < 60000) return cached;
  const items = [];
  let error = null;

  for (const name of fs.readdirSync(localDir(kind))) {
    if (!LOCAL_DISPLAYABLE.test(name)) continue;
    const stat = fs.statSync(path.join(localDir(kind), name));
    items.push({ id: encodeId(`local:${name}`), name, source: 'local', modified: stat.mtime.toISOString(), rev: String(stat.mtimeMs) });
  }

  if (dropbox.isConnected()) {
    const folder = kind === 'board' ? settings.board.dropboxFolder : settings.screensaver.dropboxFolder;
    try {
      for (const e of await dropbox.listFolder(folder)) {
        if (!IMAGE_RE.test(e.name)) continue;
        items.push({ id: encodeId(`dropbox:${e.path_lower}`), name: e.name, source: 'dropbox', modified: e.server_modified, rev: e.rev });
      }
    } catch (err) {
      error = err.message;
      if (cached) items.push(...cached.items.filter((i) => i.source === 'dropbox'));
    }
  }

  items.sort((a, b) => b.modified.localeCompare(a.modified)); // newest first
  for (const it of items) {
    const v = encodeURIComponent(it.rev);
    it.thumb = `/api/media/${kind}/${it.id}/thumb?v=${v}`;
    it.full = `/api/media/${kind}/${it.id}/full?v=${v}`;
    it.title = it.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
  }
  const entry = { at: Date.now(), items, error };
  listCache.set(kind, entry);
  return entry;
}

export const invalidate = (kind) => listCache.delete(kind);

// Returns { file } for something to stream from disk.
export async function resolve(kind, id, size) {
  const ref = decodeId(id);
  const [source, ...rest] = ref.split(':');
  const name = rest.join(':');
  if (source === 'local') {
    const file = path.join(localDir(kind), path.basename(name)); // basename blocks ../ tricks
    if (!fs.existsSync(file)) throw Object.assign(new Error('Not found'), { status: 404 });
    return { file };
  }
  if (source === 'dropbox') {
    const key = crypto.createHash('sha1').update(`${ref}|${size}`).digest('hex');
    const file = path.join(CACHE_DIR, key + '.jpg');
    if (!fs.existsSync(file)) {
      const buf = await dropbox.thumbnail(name, SIZES[size] || SIZES.thumb);
      fs.writeFileSync(file, buf);
    }
    return { file };
  }
  throw Object.assign(new Error('Bad id'), { status: 400 });
}

export async function add(kind, settings, filename, buffer) {
  const clean = path.basename(filename).replace(/[^\w.\- ()]/g, '_').slice(0, 120) || `upload-${Date.now()}.jpg`;
  if (!IMAGE_RE.test(clean)) throw Object.assign(new Error('Only image files can be uploaded'), { status: 400 });
  if (dropbox.isConnected()) {
    const folder = kind === 'board' ? settings.board.dropboxFolder : settings.screensaver.dropboxFolder;
    await dropbox.upload(folder, clean, buffer);
  } else {
    if (!LOCAL_DISPLAYABLE.test(clean)) {
      throw Object.assign(new Error('HEIC/TIFF photos need Dropbox connected (it converts them). Use JPG or PNG.'), { status: 400 });
    }
    let target = path.join(localDir(kind), clean);
    if (fs.existsSync(target)) target = path.join(localDir(kind), `${Date.now()}-${clean}`);
    fs.writeFileSync(target, buffer);
  }
  invalidate(kind);
}

export async function removeItem(kind, id) {
  const [source, ...rest] = decodeId(id).split(':');
  const name = rest.join(':');
  if (source === 'local') fs.rmSync(path.join(localDir(kind), path.basename(name)), { force: true });
  else if (source === 'dropbox') await dropbox.remove(name);
  invalidate(kind);
}
