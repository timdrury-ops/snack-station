/* Turns raw iCal (.ics) text into display events for a date range, entirely on
   the device. Uses ical.js for parsing, time zones, RRULE/EXDATE expansion and
   moved/cancelled instances (RECURRENCE-ID overrides).
   Works in the WebView (window.HubICS) and in Node for tests (module.exports). */
(function (root) {
  'use strict';
  const ICAL = root.ICAL || (typeof require === 'function' ? require('./vendor/ical.min.js') : null);
  const pad = (n) => String(n).padStart(2, '0');
  const ymdOf = (t) => `${t.year}-${pad(t.month)}-${pad(t.day)}`;
  const MAX_STEPS = 20000; // safety cap per recurring event

  // parse once per feed revision; parsing a big Google calendar is the slow part
  const cache = new Map(); // key -> { events: ICAL.Event[] }

  function load(key, text) {
    const hit = cache.get(key);
    if (hit) return hit;
    const comp = new ICAL.Component(ICAL.parse(text));
    comp.getAllSubcomponents('vtimezone').forEach((tz) => {
      try { ICAL.TimezoneService.register(tz); } catch (e) { /* duplicate or malformed zone: ignore */ }
    });
    const all = comp.getAllSubcomponents('vevent').map((v) => new ICAL.Event(v));
    const masters = new Map();
    all.forEach((ev) => { if (!ev.isRecurrenceException()) masters.set(ev.uid, ev); });
    all.forEach((ev) => {
      if (!ev.isRecurrenceException()) return;
      const m = masters.get(ev.uid);
      if (m) { try { m.relateException(ev); } catch (e) { /* mismatched override */ } }
      else masters.set(ev.uid + '#' + ev.recurrenceId, ev); // orphan override: show it on its own
    });
    const entry = { events: Array.from(masters.values()) };
    cache.set(key, entry);
    if (cache.size > 20) cache.delete(cache.keys().next().value);
    return entry;
  }

  const cancelled = (item) => String(item.component.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED';

  function toEvent(item, start, end, cal) {
    const allDay = start.isDate;
    const s = allDay ? ymdOf(start) : start.toJSDate().toISOString();
    let e;
    if (allDay) {
      e = end ? ymdOf(end) : s;
      if (e <= s) { const t = start.clone(); t.adjust(1, 0, 0, 0); e = ymdOf(t); } // all-day end is exclusive
    } else e = (end || start).toJSDate().toISOString();
    return {
      id: `${cal.id}:${item.uid}:${s}`,
      calendarId: cal.id, calendar: cal.name, color: cal.color,
      title: item.summary || '(No title)',
      location: item.location || '',
      notes: String(item.description || '').slice(0, 2000),
      allDay, start: s, end: e, editable: false,
    };
  }

  // [from, to] are JS Dates
  function expand(key, text, cal, from, to) {
    const { events } = load(key, text);
    const out = [];
    const fromMs = +from, toMs = +to;
    for (const ev of events) {
      try {
        if (!ev.startDate) continue;
        if (!ev.isRecurring()) {
          if (cancelled(ev)) continue;
          const sMs = +ev.startDate.toJSDate(), eMs = +(ev.endDate || ev.startDate).toJSDate();
          if (sMs <= toMs && (eMs >= fromMs || sMs >= fromMs)) out.push(toEvent(ev, ev.startDate, ev.endDate, cal));
          continue;
        }
        const it = ev.iterator();
        let next, steps = 0;
        while ((next = it.next()) && steps++ < MAX_STEPS) {
          if (+next.toJSDate() > toMs) break;
          const d = ev.getOccurrenceDetails(next);
          if (cancelled(d.item)) continue;
          if (+d.endDate.toJSDate() < fromMs) continue;
          out.push(toEvent(d.item, d.startDate, d.endDate, cal));
        }
      } catch (e) { /* one bad event shouldn't hide the rest of the calendar */ }
    }
    return out;
  }

  const api = { expand, clear: () => cache.clear() };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HubICS = api;
})(typeof window !== 'undefined' ? window : globalThis);
