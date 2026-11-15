// Minimal Dropbox API client (no SDK needed). Uses the "offline" OAuth flow so a
// long-lived refresh token is stored once and access tokens renew themselves.
import { readJSON, writeJSON } from './store.js';

const KEY = process.env.DROPBOX_APP_KEY || '';
const SECRET = process.env.DROPBOX_APP_SECRET || '';
let access = { token: '', expires: 0 };

const refreshToken = () => process.env.DROPBOX_REFRESH_TOKEN || readJSON('secrets.json', {}).dropboxRefreshToken || '';
export const hasAppKeys = () => !!(KEY && SECRET);
export const isConnected = () => hasAppKeys() && !!refreshToken();

// No redirect URI: Dropbox shows a code the user pastes back in. This works on a
// LAN address, which Dropbox would otherwise reject (it wants https redirects).
export const authUrl = () =>
  `https://www.dropbox.com/oauth2/authorize?client_id=${encodeURIComponent(KEY)}&response_type=code&token_access_type=offline`;

async function tokenRequest(params) {
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, client_id: KEY, client_secret: SECRET }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error_description || json.error || `Dropbox auth failed (${res.status})`);
  return json;
}

export async function exchangeCode(code) {
  const json = await tokenRequest({ grant_type: 'authorization_code', code: code.trim() });
  writeJSON('secrets.json', { ...readJSON('secrets.json', {}), dropboxRefreshToken: json.refresh_token });
  access = { token: json.access_token, expires: Date.now() + (json.expires_in - 120) * 1000 };
}

export function disconnect() {
  const s = readJSON('secrets.json', {});
  delete s.dropboxRefreshToken;
  writeJSON('secrets.json', s);
  access = { token: '', expires: 0 };
}

async function token() {
  if (access.token && Date.now() < access.expires) return access.token;
  const json = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken() });
  access = { token: json.access_token, expires: Date.now() + (json.expires_in - 120) * 1000 };
  return access.token;
}

// Dropbox-API-Arg is an HTTP header, so non-ASCII (emoji, accents) must be \u-escaped.
const headerArg = (obj) => JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

async function rpc(endpoint, body) {
  const res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error_summary || `Dropbox ${endpoint} failed (${res.status})`);
    err.summary = json.error_summary || '';
    throw err;
  }
  return json;
}

const normFolder = (p) => {
  p = String(p || '').trim().replace(/\/+$/, '');
  return p && !p.startsWith('/') ? '/' + p : p;
};

export async function listFolder(folder) {
  const path = normFolder(folder);
  let json;
  try {
    json = await rpc('files/list_folder', { path, include_media_info: false });
  } catch (err) {
    if (err.summary.startsWith('path/not_found') && path) {
      await rpc('files/create_folder_v2', { path, autorename: false }).catch(() => {});
      return [];
    }
    throw err;
  }
  const entries = [...json.entries];
  while (json.has_more) {
    json = await rpc('files/list_folder/continue', { cursor: json.cursor });
    entries.push(...json.entries);
  }
  return entries.filter((e) => e['.tag'] === 'file');
}

// Dropbox resizes on its side, so a 12-megapixel phone photo arrives as a
// display-sized JPEG — important for the Skylight's modest hardware.
export async function thumbnail(path, size) {
  const res = await fetch('https://content.dropboxapi.com/2/files/get_thumbnail_v2', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await token()}`,
      'Dropbox-API-Arg': headerArg({ resource: { '.tag': 'path', path }, format: 'jpeg', size, mode: 'fitone_bestfit' }),
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Dropbox thumbnail failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export async function upload(folder, filename, buffer) {
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await token()}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': headerArg({ path: `${normFolder(folder)}/${filename}`, mode: 'add', autorename: true }),
    },
    body: buffer,
  });
  if (!res.ok) throw new Error(`Dropbox upload failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export const remove = (path) => rpc('files/delete_v2', { path });
