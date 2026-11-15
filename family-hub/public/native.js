/* On-device backend used when the page runs inside the Android app.
   It answers the same /api/... requests the optional home server does, but
   everything lives in the app's private storage via the HubNative bridge:
   settings, calendar URLs, events, notes, pictures and the Home Assistant token.
   Calendars are downloaded by native (Kotlin) code, so CORS never applies. */
(function () {
  'use strict';
  const N = window.HubNative;
  if (!N) return; // normal browser: app.js talks to the home server instead

  const DEFAULTS = {
    title: 'Family Hub', pin: '', use24h: false, weekStartsOn: 0, calendars: [],
    theme: 'light', accent: '#2563eb', calendarSyncMinutes: 20,
    localCalendar: { name: 'Family', color: '#ef4444' },
    board: { dropboxFolder: '' },
    screensaver: { enabled: true, idleMinutes: 5, intervalSeconds: 20, showClock: true, showDate: true, showNextEvent: true, clockPosition: 'bottom-left', kenBurns: true, dropboxFolder: '' },
    cameras: [], home: { entities: [], alexaDevices: [] }, tabs: { cameras: true, home: true, snacks: false },
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const read = (key, fallback) => { try { const v = N.getItem(key); return v ? JSON.parse(v) : clone(fallback); } catch (e) { return clone(fallback); } };
  const write = (key, value) => N.setItem(key, JSON.stringify(value));
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2));

  function settings() {
    const s = read('settings', DEFAULTS), out = Object.assign(clone(DEFAULTS), s);
    ['localCalendar', 'board', 'screensaver', 'home', 'tabs'].forEach((k) => { out[k] = Object.assign(clone(DEFAULTS[k]), s[k] || {}); });
    return out;
  }
  const publicSettings = (s) => Object.assign({}, s, { pin: undefined, hasPin: !!s.pin });
  const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };
  const requirePin = (h) => { const { pin } = settings(); if (pin && h['X-Pin'] !== pin) fail(401, 'PIN required'); };

  // ---- async native calls (Home Assistant) resolve through this table ----
  const pending = new Map();
  let seq = 0;
  window.HubNativeEvents = window.HubNativeEvents || {};
  window.HubNativeEvents.resolve = (id, status, body) => {
    const p = pending.get(id); if (!p) return;
    pending.delete(id);
    if (status >= 200 && status < 300) { try { p.ok(body ? JSON.parse(body) : null); } catch (e) { p.ok(body); } }
    else p.err(Object.assign(new Error(status ? `Home Assistant → HTTP ${status}` : (body || 'Home Assistant unreachable')), { status: 502 }));
  };
  const ha = (method, path, body) => new Promise((ok, err) => {
    const id = ++seq; pending.set(id, { ok, err });
    N.haRequest(id, method, path, body ? JSON.stringify(body) : '');
    setTimeout(() => { if (pending.has(id)) window.HubNativeEvents.resolve(id, 0, 'Home Assistant timed out'); }, 20000);
  });

  // ---- calendar ----
  function feedEvents(s, from, to) {
    let feeds = [];
    try { feeds = JSON.parse(N.getCalendarFeeds() || '[]'); } catch (e) { feeds = []; }
    const byId = new Map(feeds.map((f) => [f.id, f]));
    const events = [], errors = [];
    s.calendars.filter((c) => c.url).forEach((cal) => {
      const f = byId.get(cal.id);
      if (!f || !f.ics) { errors.push({ calendar: cal.name, error: f && f.error ? f.error : 'Not downloaded yet' }); return; }
      if (f.error) errors.push({ calendar: cal.name, error: f.error + ' (showing last good copy)' });
      try { events.push.apply(events, window.HubICS.expand(cal.id + ':' + f.fetchedAt, f.ics, cal, from, to)); }
      catch (e) { errors.push({ calendar: cal.name, error: 'Could not read this calendar file' }); }
    });
    return { events, errors };
  }
  function localEvents(s, from, to) {
    const cal = s.localCalendar;
    return read('events', []).filter((e) => {
      const st = new Date(e.allDay ? e.start + 'T00:00' : e.start), en = new Date(e.allDay ? e.end + 'T00:00' : e.end);
      return en >= from && st <= to;
    }).map((e) => Object.assign({}, e, { calendarId: 'local', calendar: cal.name, color: cal.color, editable: true }));
  }

  // ---- pictures: shrink on the device before saving, so the frame stays fast ----
  function toJpegBase64(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob), img = new Image();
      img.onload = () => {
        const max = 2048, k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.88).split(',')[1]);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(Object.assign(new Error('That file isn\'t a picture this device can open'), { status: 400 })); };
      img.src = url;
    });
  }
  function mediaList(kind) {
    const items = JSON.parse(N.listMedia(kind) || '[]').map((f) => {
      const id = encodeURIComponent(f.name), v = f.modified;
      return {
        id, name: f.name, source: 'local', modified: new Date(f.modified).toISOString(), rev: String(v),
        thumb: `/media/${kind}/${id}?v=${v}`, full: `/media/${kind}/${id}?v=${v}`,
        title: f.name.replace(/\.[^.]+$/, '').replace(/^\d{13}-/, '').replace(/[_-]+/g, ' '),
      };
    });
    items.sort((a, b) => b.modified.localeCompare(a.modified));
    return { items, error: null };
  }

  // ---- Home Assistant (same allow-list as the server) ----
  const CONTROLLABLE = ['light', 'switch', 'fan', 'scene', 'script', 'input_boolean', 'lock', 'cover', 'media_player', 'climate'];
  const ALLOWED = {
    light: ['toggle', 'turn_on', 'turn_off'], switch: ['toggle', 'turn_on', 'turn_off'], fan: ['toggle', 'turn_on', 'turn_off'],
    input_boolean: ['toggle', 'turn_on', 'turn_off'], scene: ['turn_on'], script: ['turn_on'], lock: ['lock', 'unlock'],
    cover: ['open_cover', 'close_cover', 'stop_cover'], climate: ['set_temperature'],
    media_player: ['media_play_pause', 'media_next_track', 'volume_up', 'volume_down', 'volume_set', 'play_media'],
  };
  const pick = (s) => ({
    entity_id: s.entity_id, domain: s.entity_id.split('.')[0], name: s.attributes.friendly_name || s.entity_id, state: s.state,
    attributes: { brightness: s.attributes.brightness, current_temperature: s.attributes.current_temperature, temperature: s.attributes.temperature,
      unit: s.attributes.unit_of_measurement, media_title: s.attributes.media_title, media_artist: s.attributes.media_artist, volume_level: s.attributes.volume_level },
  });
  const haConfigured = () => { try { return JSON.parse(N.getHomeAssistant()).configured; } catch (e) { return false; } };
  const needHA = () => { if (!haConfigured()) fail(400, 'Home Assistant is not set up — add its address and token in Settings'); };

  // ---- router ----
  async function request(path, opts) {
    opts = opts || {};
    const method = (opts.method || 'GET').toUpperCase(), h = opts.headers || {};
    const url = new URL(path, location.href), p = url.pathname, q = url.searchParams;
    let body = opts.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* raw */ } }
    let m;

    if (p === '/api/settings' && method === 'GET') return publicSettings(settings());
    if (p === '/api/settings' && method === 'PUT') {
      requirePin(h);
      const cur = settings(), next = Object.assign({}, cur, body);
      if (body.pin === undefined) next.pin = cur.pin;
      delete next.hasPin;
      next.calendars = (next.calendars || []).map((c) => ({ id: c.id || uuid().slice(0, 8), name: String(c.name || 'Calendar'), url: String(c.url || '').trim(), color: c.color || '#3b82f6' }));
      next.calendarSyncMinutes = Math.min(30, Math.max(15, Number(next.calendarSyncMinutes) || 20));
      write('settings', next);
      N.refreshCalendars(); // pick up added/removed calendars right away
      return publicSettings(next);
    }
    if (p === '/api/pin/check') { const { pin } = settings(); return { ok: !pin || body.pin === pin }; }
    if (p === '/api/status') {
      return { native: true, dropbox: { appKeys: false, connected: false }, homeAssistant: haConfigured(), ha: JSON.parse(N.getHomeAssistant()),
        app: JSON.parse(N.getAppInfo()), sync: JSON.parse(N.getSyncStatus()), time: new Date().toISOString() };
    }

    if (p === '/api/events' && method === 'GET') {
      const from = new Date(q.get('from') || Date.now() - 7 * 864e5), to = new Date(q.get('to') || Date.now() + 60 * 864e5);
      const s = settings(), feeds = feedEvents(s, from, to);
      const events = localEvents(s, from, to).concat(feeds.events);
      events.sort((a, b) => String(a.start).localeCompare(String(b.start)));
      return { events, errors: feeds.errors };
    }
    if (p === '/api/events' && method === 'POST') {
      if (!body.title || !body.start) fail(400, 'title and start are required');
      const norm = (v) => (body.allDay ? v : new Date(v).toISOString());
      const ev = { id: uuid(), title: String(body.title).slice(0, 200), start: norm(body.start), end: norm(body.end || body.start), allDay: !!body.allDay,
        notes: String(body.notes || '').slice(0, 2000), location: String(body.location || '').slice(0, 200), created: new Date().toISOString() };
      const all = read('events', []); all.push(ev); write('events', all);
      return ev;
    }
    if ((m = p.match(/^\/api\/events\/(.+)$/)) && method === 'DELETE') {
      requirePin(h);
      const id = decodeURIComponent(m[1]);
      write('events', read('events', []).filter((e) => e.id !== id));
      return { ok: true };
    }
    if (p === '/api/events/refresh') { N.refreshCalendars(); return { ok: true }; }

    if ((m = p.match(/^\/api\/media\/(board|screensaver)$/))) {
      if (method === 'GET') return mediaList(m[1]);
      if (method === 'POST') {
        const name = decodeURIComponent(h['X-Filename'] || 'picture.jpg').replace(/\.[^.]+$/, '').replace(/[^\w\- ()]/g, '_').slice(0, 80) || 'picture';
        N.saveMedia(m[1], `${Date.now()}-${name}.jpg`, await toJpegBase64(opts.body));
        return { ok: true };
      }
    }
    if ((m = p.match(/^\/api\/media\/(board|screensaver)\/([^/]+)$/)) && method === 'DELETE') {
      requirePin(h);
      N.deleteMedia(m[1], decodeURIComponent(m[2]));
      return { ok: true };
    }

    if (p === '/api/notes' && method === 'GET') return read('notes', []);
    if (p === '/api/notes' && method === 'POST') {
      const text = String(body.text || '').slice(0, 500);
      if (!text.trim()) fail(400, 'empty note');
      const note = { id: uuid(), text, color: body.color || 'white', created: new Date().toISOString() };
      const notes = read('notes', []); notes.unshift(note); write('notes', notes);
      return note;
    }
    if ((m = p.match(/^\/api\/notes\/(.+)$/)) && method === 'DELETE') {
      const id = decodeURIComponent(m[1]);
      write('notes', read('notes', []).filter((n) => n.id !== id));
      return { ok: true };
    }

    if (p === '/api/home/states' || p === '/api/home/all') {
      needHA();
      const all = await ha('GET', '/api/states');
      if (p === '/api/home/all') return all.filter((s) => CONTROLLABLE.includes(s.entity_id.split('.')[0])).map(pick);
      const hs = settings().home, ids = Array.from(new Set((hs.entities || []).concat(hs.alexaDevices || [])));
      if (!ids.length) return all.filter((s) => CONTROLLABLE.includes(s.entity_id.split('.')[0])).map(pick);
      const byId = new Map(all.map((s) => [s.entity_id, s]));
      return ids.map((id) => byId.get(id)).filter(Boolean).map(pick);
    }
    if (p === '/api/home/call') {
      needHA();
      if (!(ALLOWED[body.domain] || []).includes(body.service)) fail(400, `${body.domain}.${body.service} is not allowed`);
      await ha('POST', `/api/services/${body.domain}/${body.service}`, body.data);
      return { ok: true };
    }
    if (p === '/api/alexa/command') {
      needHA();
      if (!body.device || !body.text) fail(400, 'device and text required');
      if (body.announce) await ha('POST', '/api/services/notify/alexa_media', { message: body.text, target: [body.device], data: { type: 'announce' } });
      else await ha('POST', '/api/services/media_player/play_media', { entity_id: body.device, media_content_id: body.text, media_content_type: 'custom' });
      return { ok: true };
    }

    if (p.startsWith('/api/dropbox')) fail(400, 'Dropbox isn\'t used in the app — pictures are stored on this device');
    fail(404, 'Not found: ' + p);
  }

  window.HubLocalApi = { request };
})();
