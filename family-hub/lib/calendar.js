// Calendar sync: pulls any number of iCal (.ics) feeds (Google, iCloud, Outlook,
// school/sports sites...) and merges them with events created on the display.
import ical from 'node-ical';
import crypto from 'node:crypto';
import { readJSON, writeJSON } from './store.js';

const FEED_TTL_MS = 10 * 60 * 1000;
const feedCache = new Map(); // url -> { at, data, error }

function text(v) {
  if (v == null) return '';
  if (typeof v === 'object' && 'val' in v) return String(v.val);
  return String(v);
}

const pad = (n) => String(n).padStart(2, '0');
// All-day events are local-midnight Dates; send them as plain YYYY-MM-DD so the
// display never shifts them by a timezone.
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

async function loadFeed(url) {
  const cached = feedCache.get(url);
  if (cached && Date.now() - cached.at < FEED_TTL_MS) return cached;
  try {
    // webcal:// is just https:// with a different hat on
    const res = await fetch(url.replace(/^webcal:\/\//i, 'https://'), {
      headers: { 'User-Agent': 'FamilyHub/1.0' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = ical.sync.parseICS(await res.text());
    const entry = { at: Date.now(), data, error: null };
    feedCache.set(url, entry);
    return entry;
  } catch (err) {
    // keep showing the last good copy if the internet blips
    const entry = { at: Date.now() - FEED_TTL_MS + 60000, data: cached?.data || {}, error: err.message };
    feedCache.set(url, entry);
    return entry;
  }
}

function expand(data, from, to, cal) {
  const out = [];
  for (const ev of Object.values(data)) {
    if (!ev || ev.type !== 'VEVENT' || !ev.start) continue;
    if (ev.recurrenceid && !ev.rrule) continue; // overrides are applied by the expander
    if (text(ev.status).toUpperCase() === 'CANCELLED') continue;
    let instances;
    try {
      instances = ical.expandRecurringEvent(ev, { from, to, expandOngoing: true });
    } catch {
      continue;
    }
    for (const inst of instances) {
      if (text(inst.event?.status).toUpperCase() === 'CANCELLED') continue;
      const start = inst.start;
      const end = inst.end || inst.start;
      out.push({
        id: `${cal.id}:${ev.uid}:${start.toISOString()}`,
        calendarId: cal.id,
        calendar: cal.name,
        color: cal.color,
        title: text(inst.summary || ev.summary) || '(No title)',
        location: text(inst.event?.location || ev.location),
        notes: text(inst.event?.description || ev.description).slice(0, 2000),
        allDay: !!inst.isFullDay,
        start: inst.isFullDay ? ymd(start) : start.toISOString(),
        end: inst.isFullDay ? ymd(end) : end.toISOString(), // all-day end is exclusive
        editable: false,
      });
    }
  }
  return out;
}

// ---- events created on the display itself ----
export const getLocalEvents = () => readJSON('events.json', []);

export function addLocalEvent({ title, start, end, allDay, notes, location }) {
  if (!title || !start) throw new Error('title and start are required');
  const norm = (v) => {
    if (allDay) { if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('all-day dates must be YYYY-MM-DD'); return v; }
    const d = new Date(v);
    if (isNaN(d)) throw new Error('invalid date');
    return d.toISOString();
  };
  start = norm(start);
  end = end ? norm(end) : start;
  const events = getLocalEvents();
  const ev = {
    id: crypto.randomUUID(),
    title: String(title).slice(0, 200),
    start, end, allDay: !!allDay,
    notes: String(notes || '').slice(0, 2000),
    location: String(location || '').slice(0, 200),
    created: new Date().toISOString(),
  };
  events.push(ev);
  writeJSON('events.json', events);
  return ev;
}

export function deleteLocalEvent(id) {
  writeJSON('events.json', getLocalEvents().filter((e) => e.id !== id));
}

function localInRange(settings, from, to) {
  const cal = settings.localCalendar;
  return getLocalEvents()
    .filter((e) => {
      const s = new Date(e.allDay ? e.start + 'T00:00' : e.start);
      const en = new Date(e.allDay ? e.end + 'T00:00' : e.end);
      return en >= from && s <= to;
    })
    .map((e) => ({ ...e, calendarId: 'local', calendar: cal.name, color: cal.color, editable: true }));
}

export async function getEvents(settings, from, to) {
  const feeds = await Promise.all(
    settings.calendars.filter((c) => c.url).map(async (cal) => {
      const feed = await loadFeed(cal.url);
      return { cal, events: expand(feed.data, from, to, cal), error: feed.error };
    })
  );
  const events = [...localInRange(settings, from, to), ...feeds.flatMap((f) => f.events)];
  events.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const errors = feeds.filter((f) => f.error).map((f) => ({ calendar: f.cal.name, error: f.error }));
  return { events, errors };
}

export function refreshFeeds() {
  feedCache.clear();
}

// ---- publish the display's own events as a feed phones can subscribe to ----
const icsDate = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (m) => '\\' + m);

export function localEventsICS(settings) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FamilyHub//EN',
    `X-WR-CALNAME:${icsEscape(settings.localCalendar.name)}`];
  for (const e of getLocalEvents()) {
    lines.push('BEGIN:VEVENT', `UID:${e.id}@familyhub`, `DTSTAMP:${icsDate(e.created || Date.now())}`);
    if (e.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${e.start.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${e.end.replace(/-/g, '')}`);
    } else {
      lines.push(`DTSTART:${icsDate(e.start)}`, `DTEND:${icsDate(e.end)}`);
    }
    lines.push(`SUMMARY:${icsEscape(e.title)}`);
    if (e.location) lines.push(`LOCATION:${icsEscape(e.location)}`);
    if (e.notes) lines.push(`DESCRIPTION:${icsEscape(e.notes)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
