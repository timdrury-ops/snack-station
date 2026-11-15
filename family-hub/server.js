import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getSettings, saveSettings, readJSON, writeJSON } from './lib/store.js';
import * as calendar from './lib/calendar.js';
import * as media from './lib/media.js';
import * as dropbox from './lib/dropbox.js';
import * as ha from './lib/homeassistant.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(req.method, req.url, err.message);
    res.status(err.status || 500).json({ error: err.message });
  });

// Optional PIN gate for anything that changes settings or deletes content, so
// little fingers on the wall display can't wreck the setup.
function requirePin(req, res, next) {
  const { pin } = getSettings();
  if (!pin || req.get('X-Pin') === pin) return next();
  res.status(401).json({ error: 'PIN required' });
}

// ---------- settings & status ----------
const publicSettings = (s) => ({ ...s, pin: undefined, hasPin: !!s.pin });

app.get('/api/settings', (req, res) => res.json(publicSettings(getSettings())));

app.put('/api/settings', requirePin, wrap((req, res) => {
  const current = getSettings();
  const next = { ...current, ...req.body };
  if (req.body.pin === undefined) next.pin = current.pin; // keep PIN unless explicitly changed
  delete next.hasPin;
  next.calendars = (next.calendars || []).map((c) => ({
    id: c.id || crypto.randomUUID().slice(0, 8),
    name: String(c.name || 'Calendar'), url: String(c.url || '').trim(), color: c.color || '#5c5c5c',
  }));
  saveSettings(next);
  calendar.refreshFeeds();
  media.invalidate('board');
  media.invalidate('screensaver');
  res.json(publicSettings(next));
}));

app.post('/api/pin/check', (req, res) => {
  const { pin } = getSettings();
  res.json({ ok: !pin || req.body.pin === pin });
});

app.get('/api/status', (req, res) => res.json({
  dropbox: { appKeys: dropbox.hasAppKeys(), connected: dropbox.isConnected() },
  homeAssistant: ha.isConfigured(),
  time: new Date().toISOString(),
}));

// ---------- calendar ----------
app.get('/api/events', wrap(async (req, res) => {
  const from = new Date(req.query.from || Date.now() - 7 * 864e5);
  const to = new Date(req.query.to || Date.now() + 60 * 864e5);
  if (isNaN(from) || isNaN(to) || to - from > 400 * 864e5) return res.status(400).json({ error: 'bad range' });
  res.json(await calendar.getEvents(getSettings(), from, to));
}));

app.post('/api/events', wrap((req, res) => res.json(calendar.addLocalEvent(req.body))));
app.delete('/api/events/:id', requirePin, (req, res) => { calendar.deleteLocalEvent(req.params.id); res.json({ ok: true }); });
app.post('/api/events/refresh', (req, res) => { calendar.refreshFeeds(); res.json({ ok: true }); });

// Subscribe to this from phones (Google Calendar → "From URL", iPhone → Add Subscription)
// to see events that were added on the wall display.
app.get('/calendar.ics', (req, res) => {
  res.type('text/calendar').send(calendar.localEventsICS(getSettings()));
});

// ---------- bulletin board & screensaver pictures ----------
const kind = (req) => {
  const k = media.KINDS[req.params.kind];
  if (!k) throw Object.assign(new Error('unknown kind'), { status: 404 });
  return k;
};

app.get('/api/media/:kind', wrap(async (req, res) => {
  const { items, error } = await media.list(kind(req), getSettings(), { fresh: req.query.fresh === '1' });
  res.json({ items, error });
}));

app.get('/api/media/:kind/:id/:size', wrap(async (req, res) => {
  const { file } = await media.resolve(kind(req), req.params.id, req.params.size);
  res.set('Cache-Control', 'public, max-age=604800, immutable'); // URL carries the file revision
  res.sendFile(file);
}));

app.post('/api/media/:kind', express.raw({ type: '*/*', limit: '60mb' }), wrap(async (req, res) => {
  const name = decodeURIComponent(req.get('X-Filename') || '');
  if (!req.body?.length) return res.status(400).json({ error: 'empty upload' });
  await media.add(kind(req), getSettings(), name, req.body);
  res.json({ ok: true });
}));

app.delete('/api/media/:kind/:id', requirePin, wrap(async (req, res) => {
  await media.removeItem(kind(req), req.params.id);
  res.json({ ok: true });
}));

// Sticky notes pinned next to the photos on the cork board
app.get('/api/notes', (req, res) => res.json(readJSON('notes.json', [])));
app.post('/api/notes', (req, res) => {
  const notes = readJSON('notes.json', []);
  const note = { id: crypto.randomUUID(), text: String(req.body.text || '').slice(0, 500), color: req.body.color || 'yellow', created: new Date().toISOString() };
  if (!note.text.trim()) return res.status(400).json({ error: 'empty note' });
  notes.unshift(note);
  writeJSON('notes.json', notes);
  res.json(note);
});
app.delete('/api/notes/:id', (req, res) => {
  writeJSON('notes.json', readJSON('notes.json', []).filter((n) => n.id !== req.params.id));
  res.json({ ok: true });
});

// ---------- Dropbox connection ----------
app.get('/api/dropbox/auth-url', requirePin, (req, res) => {
  if (!dropbox.hasAppKeys()) return res.status(400).json({ error: 'Set DROPBOX_APP_KEY and DROPBOX_APP_SECRET first' });
  res.json({ url: dropbox.authUrl() });
});
app.post('/api/dropbox/code', requirePin, wrap(async (req, res) => {
  await dropbox.exchangeCode(String(req.body.code || ''));
  media.invalidate('board'); media.invalidate('screensaver');
  res.json({ ok: true });
}));
app.post('/api/dropbox/disconnect', requirePin, (req, res) => { dropbox.disconnect(); res.json({ ok: true }); });

// ---------- cameras ----------
// Snapshots are proxied so the display only ever talks to this server.
app.get('/api/cameras/:i/snapshot', wrap(async (req, res) => {
  const cam = getSettings().cameras[Number(req.params.i)];
  if (!cam?.snapshot) return res.status(404).end();
  const r = await fetch(cam.snapshot, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) return res.status(502).end();
  res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg').set('Cache-Control', 'no-store');
  res.send(Buffer.from(await r.arrayBuffer()));
}));

// ---------- Home Assistant / Alexa ----------
const needHA = (req, res, next) => (ha.isConfigured() ? next() : res.status(400).json({ error: 'Home Assistant is not configured (HA_URL / HA_TOKEN)' }));

app.get('/api/home/states', needHA, wrap(async (req, res) => {
  const s = getSettings().home;
  const ids = [...new Set([...(s.entities || []), ...(s.alexaDevices || [])])];
  res.json(await ha.states(ids.length ? ids : null));
}));
app.get('/api/home/all', needHA, wrap(async (req, res) => res.json(await ha.states(null))));
app.post('/api/home/call', needHA, wrap(async (req, res) => {
  const { domain, service, data } = req.body;
  await ha.call(domain, service, data);
  res.json({ ok: true });
}));
app.post('/api/alexa/command', needHA, wrap(async (req, res) => {
  const { device, text, announce } = req.body;
  if (!device || !text) return res.status(400).json({ error: 'device and text required' });
  await (announce ? ha.alexaAnnounce(device, text) : ha.alexaCommand(device, text));
  res.json({ ok: true });
}));

// ---------- static ----------
// The existing Snack Station page from this repo, shown as an optional tab.
app.get('/snacks', (req, res) => res.sendFile(path.join(__dirname, '..', 'index.html')));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, '0.0.0.0', () => console.log(`Family Hub running on http://0.0.0.0:${PORT}`));
