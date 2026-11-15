/* Family Hub — wall display client. Plain JS, no build step, so it runs in the
   Skylight's Android WebView / kiosk browser and is easy to tweak. */
(function () {
  'use strict';

  // ---------------------------------------------------------------- helpers
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const sameDay = (a, b) => ymd(a) === ymd(b);
  const hashNum = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };

  const state = {
    settings: null,
    status: {},
    pin: '',
    view: 'calendar',
    cal: { mode: localStorage.getItem('calMode') || 'month', anchor: startOfDay(new Date()), selected: startOfDay(new Date()), events: [], errors: [], hidden: new Set(JSON.parse(localStorage.getItem('calHidden') || '[]')) },
    board: { photos: [], notes: [] },
  };

  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({}, opts.headers || {});
    if (state.pin) headers['X-Pin'] = state.pin;
    let body = opts.body;
    if (body && !(body instanceof Blob) && typeof body === 'object') { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    const res = await fetch(path, { method: opts.method || (body ? 'POST' : 'GET'), headers, body });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { state.pin = ''; throw new Error('PIN required'); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
  }

  function openModal(html, onMount) {
    $('#sheet').innerHTML = html;
    $('#modal').classList.remove('hidden');
    if (onMount) onMount($('#sheet'));
  }
  const closeModal = () => $('#modal').classList.add('hidden');
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

  // ---------------------------------------------------------------- time
  const fmtTime = (d, opts) => d.toLocaleTimeString([], Object.assign({ hour: 'numeric', minute: '2-digit', hour12: !state.settings.use24h }, opts || {}));
  const fmtShortTime = (d) => {
    if (state.settings.use24h) return fmtTime(d);
    const h = d.getHours() % 12 || 12, m = d.getMinutes();
    return `${h}${m ? ':' + pad(m) : ''}${d.getHours() < 12 ? 'a' : 'p'}`;
  };

  function tickClock() {
    const now = new Date();
    $('#railTime').textContent = fmtTime(now).replace(/\s?[AP]M$/i, '');
    $('#railDate').textContent = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    if (!$('#saver').classList.contains('hidden')) renderSaverClock(now);
    // roll the calendar over at midnight
    if (!sameDay(now, tickClock.last || now)) { state.cal.anchor = startOfDay(now); state.cal.selected = startOfDay(now); loadCalendar(); }
    tickClock.last = now;
  }

  // ---------------------------------------------------------------- navigation
  function showView(name) {
    if (name === 'settings' && state.settings.hasPin && !state.pin) {
      return askPin(() => showView('settings'));
    }
    state.view = name;
    $$('.tab[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    if (name === 'calendar') renderCalendar();
    if (name === 'board') loadBoard();
    if (name === 'cameras') renderCameras();
    if (name === 'home') loadHome();
    if (name === 'snacks' && !$('#snackFrame').src) $('#snackFrame').src = '/snacks';
    if (name === 'settings') renderSettings();
  }
  $$('.tab[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  function applyTabs() {
    const t = state.settings.tabs || {};
    $('.tab[data-view=cameras]').classList.toggle('hidden', t.cameras === false);
    $('.tab[data-view=home]').classList.toggle('hidden', t.home === false);
    $('.tab[data-view=snacks]').classList.toggle('hidden', !t.snacks);
    document.title = state.settings.title || 'Family Hub';
  }

  function askPin(then) {
    let entry = '';
    const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9, '', 0, '⌫'];
    openModal(`<h2>Enter PIN</h2><div class="pindots" id="pindots"></div>
      <div class="pinpad">${keys.map((k) => k === '' ? '<span></span>' : `<button data-k="${k}">${k}</button>`).join('')}</div>
      <div class="actions"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="pinGo">OK</button></div>`, (el) => {
      const dots = $('#pindots', el);
      const go = async () => {
        const r = await api('/api/pin/check', { body: { pin: entry } });
        if (r.ok) { state.pin = entry; closeModal(); then(); } else { entry = ''; dots.textContent = ''; toast('Wrong PIN'); }
      };
      $$('[data-k]', el).forEach((b) => b.addEventListener('click', () => {
        entry = b.dataset.k === '⌫' ? entry.slice(0, -1) : (entry + b.dataset.k).slice(0, 8);
        dots.textContent = '•'.repeat(entry.length);
      }));
      $('#pinGo', el).addEventListener('click', go);
      $('[data-close]', el).addEventListener('click', closeModal);
    });
  }
  // run an action that needs the PIN, asking for it only if needed
  const withPin = (fn) => (state.settings.hasPin && !state.pin ? askPin(fn) : fn());

  // ================================================================ CALENDAR
  function calRange() {
    const c = state.cal, ws = state.settings.weekStartsOn || 0;
    const weekStart = (d) => addDays(d, -((d.getDay() - ws + 7) % 7));
    if (c.mode === 'month') {
      const first = new Date(c.anchor.getFullYear(), c.anchor.getMonth(), 1);
      const from = weekStart(first);
      return { from, to: addDays(from, 42) };
    }
    if (c.mode === 'week') { const from = weekStart(c.anchor); return { from, to: addDays(from, 7) }; }
    return { from: startOfDay(c.anchor), to: addDays(c.anchor, 45) };
  }

  let calReq = 0;
  async function loadCalendar() {
    const { from, to } = calRange();
    const id = ++calReq;
    try {
      const r = await api(`/api/events?from=${from.toISOString()}&to=${to.toISOString()}`);
      if (id !== calReq) return;
      state.cal.events = r.events; state.cal.errors = r.errors;
    } catch (e) { toast('Calendar: ' + e.message); }
    if (state.view === 'calendar') renderCalendar();
  }

  function visibleEvents() { return state.cal.events.filter((e) => !state.cal.hidden.has(e.calendarId)); }

  // which days an event covers (all-day end dates are exclusive in iCal)
  function eventOnDay(e, day) {
    const key = ymd(day);
    if (e.allDay) return e.start <= key && key < (e.end > e.start ? e.end : ymd(addDays(parseYmd(e.start), 1)));
    const s = new Date(e.start), en = new Date(e.end);
    const dayStart = startOfDay(day), dayEnd = addDays(dayStart, 1);
    return s < dayEnd && (en > dayStart || (+en === +s && s >= dayStart));
  }
  const eventsOn = (day) => visibleEvents().filter((e) => eventOnDay(e, day)).sort((a, b) => (b.allDay - a.allDay) || String(a.start).localeCompare(String(b.start)));
  const tint = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c + '26' : '#f3efe8');

  function evTimeLabel(e) {
    if (e.allDay) return 'All day';
    const s = new Date(e.start), en = new Date(e.end);
    return `${fmtTime(s)} – ${fmtTime(en)}`;
  }

  function renderCalendar() {
    if (!state.settings) return;
    const c = state.cal;
    $$('#calMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === c.mode));
    const { from, to } = calRange();
    if (c.mode === 'month') $('#calTitle').textContent = c.anchor.toLocaleDateString([], { month: 'long', year: 'numeric' });
    else if (c.mode === 'week') {
      const end = addDays(to, -1);
      const md = (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      $('#calTitle').textContent = `${md(from)} – ${from.getMonth() === end.getMonth() ? end.getDate() : md(end)}, ${end.getFullYear()}`;
    } else $('#calTitle').textContent = 'Coming up';

    const warn = $('#calWarn');
    warn.classList.toggle('hidden', !c.errors.length);
    warn.textContent = c.errors.length ? `⚠ ${c.errors.length} calendar${c.errors.length > 1 ? 's' : ''} offline` : '';
    warn.title = c.errors.map((e) => `${e.calendar}: ${e.error}`).join('\n');

    // legend / filters
    const cals = [{ id: 'local', name: state.settings.localCalendar.name, color: state.settings.localCalendar.color }].concat(state.settings.calendars);
    $('#calLegend').innerHTML = cals.map((k) => `<button class="chip ${c.hidden.has(k.id) ? 'off' : ''}" data-cal="${esc(k.id)}"><span class="dot" style="background:${esc(k.color)}"></span>${esc(k.name)}</button>`).join('');

    const grid = $('#calGrid');
    if (c.mode === 'month') grid.innerHTML = renderMonth(from);
    else if (c.mode === 'week') grid.innerHTML = renderWeek(from);
    else grid.innerHTML = renderAgenda(from, to);
    renderDayPanel();
  }

  function dowLabels(from) {
    return Array.from({ length: 7 }, (_, i) => addDays(from, i).toLocaleDateString([], { weekday: 'short' }));
  }

  function renderMonth(from) {
    const c = state.cal, today = new Date();
    const rowsTall = $('#calGrid').clientHeight / 6 || 100;
    const fit = Math.max(1, Math.floor((rowsTall - 34) / 19)); // how many chips fit per cell
    let html = `<div class="month-head">${dowLabels(from).map((d) => `<div class="dow">${d}</div>`).join('')}</div><div class="month">`;
    for (let i = 0; i < 42; i++) {
      const day = addDays(from, i), evs = eventsOn(day);
      const cls = ['cell', day.getMonth() !== c.anchor.getMonth() && 'other', sameDay(day, today) && 'today', sameDay(day, c.selected) && 'sel'].filter(Boolean).join(' ');
      const shown = evs.length > fit ? evs.slice(0, fit - 1) : evs;
      html += `<div class="${cls}" data-day="${ymd(day)}"><div class="num">${day.getDate()}</div>` +
        shown.map((e) => e.allDay
          ? `<div class="ev allday" style="background:${esc(e.color)}">${esc(e.title)}</div>`
          : `<div class="ev timed" style="--c:${esc(e.color)}">${fmtShortTime(new Date(e.start))} ${esc(e.title)}</div>`).join('') +
        (evs.length > shown.length ? `<div class="more">+${evs.length - shown.length} more</div>` : '') + '</div>';
    }
    return html + '</div>';
  }

  function cardEv(e) {
    return `<button class="card-ev panel-ev" data-ev="${esc(e.id)}" style="--c:${esc(e.color)};--cbg:${tint(e.color)}">
      <div class="t">${esc(e.title)}</div><div class="s">${esc(evTimeLabel(e))}${e.location ? ' · ' + esc(e.location) : ''}</div></button>`;
  }

  function renderWeek(from) {
    const today = new Date();
    let html = '<div class="week">';
    for (let i = 0; i < 7; i++) {
      const day = addDays(from, i), evs = eventsOn(day);
      html += `<div class="wcol ${sameDay(day, today) ? 'today' : ''}" data-day="${ymd(day)}">
        <h3>${day.toLocaleDateString([], { weekday: 'short' })}<b>${day.getDate()}</b></h3>
        ${evs.map(cardEv).join('') || '<div class="panel-empty">—</div>'}</div>`;
    }
    return html + '</div>';
  }

  function renderAgenda(from, to) {
    let html = '<div class="agenda">';
    for (let d = from; d < to; d = addDays(d, 1)) {
      const evs = eventsOn(d);
      if (!evs.length) continue;
      html += `<div class="agenda-day"><div class="d"><b>${d.getDate()}</b><span>${d.toLocaleDateString([], { weekday: 'long' })}<br>${d.toLocaleDateString([], { month: 'short' })}</span></div>
        <div class="list">${evs.map(cardEv).join('')}</div></div>`;
    }
    if (html === '<div class="agenda">') html += `<div class="empty"><div class="big">🌤</div>Nothing on the calendar for the next few weeks.</div>`;
    return html + '</div>';
  }

  function renderDayPanel() {
    const d = state.cal.selected, evs = eventsOn(d);
    const label = sameDay(d, new Date()) ? 'Today' : sameDay(d, addDays(new Date(), 1)) ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'long' });
    $('#dayPanel').innerHTML = `<div class="panel-date">${label}<div style="font-size:.85rem;color:var(--muted)">${d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })}</div></div>
      <div class="panel-list">${evs.map(cardEv).join('') || '<div class="panel-empty">Nothing planned.</div>'}</div>
      <button class="btn ghost" style="width:100%;margin-top:1rem" id="panelAdd">＋ Add to this day</button>`;
    $('#panelAdd').addEventListener('click', () => eventForm(d));
  }

  $('#calGrid').addEventListener('click', (e) => {
    const ev = e.target.closest('[data-ev]');
    if (ev) return eventDetail(ev.dataset.ev);
    const cell = e.target.closest('[data-day]');
    if (cell) { state.cal.selected = parseYmd(cell.dataset.day); renderCalendar(); }
  });
  $('#dayPanel').addEventListener('click', (e) => { const ev = e.target.closest('[data-ev]'); if (ev) eventDetail(ev.dataset.ev); });
  $('#calLegend').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cal]'); if (!b) return;
    const h = state.cal.hidden; h.has(b.dataset.cal) ? h.delete(b.dataset.cal) : h.add(b.dataset.cal);
    localStorage.setItem('calHidden', JSON.stringify(Array.from(h)));
    renderCalendar();
  });
  $$('#calMode button').forEach((b) => b.addEventListener('click', () => { state.cal.mode = b.dataset.mode; localStorage.setItem('calMode', b.dataset.mode); loadCalendar(); renderCalendar(); }));
  function shiftCal(dir) {
    const c = state.cal;
    if (c.mode === 'month') c.anchor = new Date(c.anchor.getFullYear(), c.anchor.getMonth() + dir, 1);
    else if (c.mode === 'week') c.anchor = addDays(c.anchor, 7 * dir);
    else c.anchor = addDays(c.anchor, 30 * dir);
    // keep "today" selected when navigating back to the period that contains it
    const { from, to } = calRange(), today = startOfDay(new Date());
    const inView = c.mode === 'month' ? today.getMonth() === c.anchor.getMonth() && today.getFullYear() === c.anchor.getFullYear() : today >= from && today < to;
    c.selected = inView ? today : (c.mode === 'month' ? new Date(c.anchor.getFullYear(), c.anchor.getMonth(), 1) : from);
    loadCalendar();
  }
  $('#calPrev').addEventListener('click', () => shiftCal(-1));
  $('#calNext').addEventListener('click', () => shiftCal(1));
  $('#calToday').addEventListener('click', () => { state.cal.anchor = startOfDay(new Date()); state.cal.selected = startOfDay(new Date()); loadCalendar(); });
  $('#addEventBtn').addEventListener('click', () => eventForm(state.cal.selected));

  // swipe left/right on the calendar to change month/week
  swipe($('#calGrid'), (dir) => shiftCal(dir));

  function eventDetail(id) {
    const e = state.cal.events.find((x) => x.id === id); if (!e) return;
    const when = e.allDay ? parseYmd(e.start).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
      : new Date(e.start).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) + ' · ' + evTimeLabel(e);
    openModal(`<h2 style="border-left:6px solid ${esc(e.color)};padding-left:.7rem">${esc(e.title)}</h2>
      <p><b>${esc(when)}</b></p>${e.location ? `<p>📍 ${esc(e.location)}</p>` : ''}
      ${e.notes ? `<p style="white-space:pre-wrap;color:var(--muted)">${esc(e.notes)}</p>` : ''}
      <p style="color:var(--muted);font-size:.85rem">Calendar: ${esc(e.calendar)}${e.editable ? '' : ' (synced — edit it in the original app)'}</p>
      <div class="actions">${e.editable ? '<button class="btn danger left" id="evDel">Delete</button>' : ''}<button class="btn primary" data-close>Close</button></div>`, (el) => {
      $('[data-close]', el).addEventListener('click', closeModal);
      if (e.editable) $('#evDel', el).addEventListener('click', () => withPin(async () => {
        try { await api('/api/events/' + encodeURIComponent(e.id), { method: 'DELETE' }); closeModal(); loadCalendar(); } catch (err) { toast(err.message); }
      }));
    });
  }

  function eventForm(day) {
    const now = new Date(), startH = Math.min(22, now.getHours() + 1);
    openModal(`<h2>New event</h2>
      <label class="field">What<input id="fTitle" placeholder="Soccer practice" autocomplete="off"></label>
      <label class="check"><input type="checkbox" id="fAllDay"> All day</label>
      <div class="row"><label class="field">Date<input type="date" id="fDate" value="${ymd(day)}"></label>
        <label class="field" id="fEndDateWrap" style="display:none">Until<input type="date" id="fEndDate" value="${ymd(day)}"></label></div>
      <div class="row" id="fTimes"><label class="field">Starts<input type="time" id="fStart" value="${pad(startH)}:00"></label>
        <label class="field">Ends<input type="time" id="fEnd" value="${pad(startH + 1)}:00"></label></div>
      <label class="field">Where (optional)<input id="fLoc" autocomplete="off"></label>
      <label class="field">Notes (optional)<textarea id="fNotes" rows="2"></textarea></label>
      <div class="actions"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="fSave">Add event</button></div>`, (el) => {
      const allDay = $('#fAllDay', el);
      allDay.addEventListener('change', () => { $('#fTimes', el).style.display = allDay.checked ? 'none' : ''; $('#fEndDateWrap', el).style.display = allDay.checked ? '' : 'none'; });
      $('#fStart', el).addEventListener('change', (ev) => {
        const [h, m] = ev.target.value.split(':').map(Number); if (isNaN(h)) return;
        $('#fEnd', el).value = `${pad(Math.min(23, h + 1))}:${pad(m)}`;
      });
      $('[data-close]', el).addEventListener('click', closeModal);
      $('#fSave', el).addEventListener('click', async () => {
        const title = $('#fTitle', el).value.trim(), date = $('#fDate', el).value;
        if (!title || !date) return toast('Add a title and date');
        let body;
        if (allDay.checked) {
          const endD = $('#fEndDate', el).value || date;
          body = { title, allDay: true, start: date, end: ymd(addDays(parseYmd(endD < date ? date : endD), 1)) };
        } else {
          const s = new Date(`${date}T${$('#fStart', el).value || '09:00'}`);
          let e = new Date(`${date}T${$('#fEnd', el).value || '10:00'}`);
          if (e <= s) e = new Date(+s + 3600e3);
          body = { title, allDay: false, start: s.toISOString(), end: e.toISOString() };
        }
        body.location = $('#fLoc', el).value; body.notes = $('#fNotes', el).value;
        try { await api('/api/events', { body }); closeModal(); toast('Added to ' + state.settings.localCalendar.name); loadCalendar(); } catch (err) { toast(err.message); }
      });
      setTimeout(() => $('#fTitle', el).focus(), 50);
    });
  }

  // ================================================================ BULLETIN BOARD
  const PINS = ['#d64545', '#2f7fd1', '#f2b632', '#3aa66a', '#9b59b6', '#ef7d32'];

  async function loadBoard(fresh) {
    try {
      const [m, notes] = await Promise.all([api('/api/media/board' + (fresh ? '?fresh=1' : '')), api('/api/notes')]);
      state.board.photos = m.items; state.board.notes = notes;
      const msg = $('#boardMsg');
      msg.classList.toggle('hidden', !m.error);
      msg.textContent = m.error ? '⚠ Dropbox: ' + m.error + ' (showing what was loaded before)' : '';
    } catch (e) { toast(e.message); }
    renderBoard();
  }

  function renderBoard() {
    const { photos, notes } = state.board;
    const items = notes.map((n) => ({ type: 'note', at: n.created, n })).concat(photos.map((p, i) => ({ type: 'photo', at: p.modified, p, i })))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
    if (!items.length) {
      $('#boardGrid').innerHTML = `<div class="empty" style="background:rgba(255,250,240,.92);border-radius:16px;padding:1.5rem;column-span:all">
        <div class="big">📌</div><b>The board is empty.</b><br>Drop photos into your Dropbox folder <b>${esc(state.settings.board.dropboxFolder)}</b>,
        tap <b>Add photo</b>, or write a <b>Note</b>.</div>`;
      return;
    }
    $('#boardGrid').innerHTML = items.map((it) => {
      const key = it.type === 'note' ? it.n.id : it.p.id, h = hashNum(key);
      const style = `--r:${((h % 70) / 10 - 3.5).toFixed(1)}deg;--pin:${PINS[h % PINS.length]}`;
      if (it.type === 'note') return `<div class="pin-item sticky ${esc(it.n.color)}" style="${style}">${esc(it.n.text)}<button class="x" data-del-note="${esc(it.n.id)}" aria-label="Remove note">✕</button></div>`;
      return `<button class="pin-item photo" style="${style};border:0;width:100%" data-photo="${it.i}"><img loading="lazy" src="${esc(it.p.thumb)}" alt=""><span class="cap">${esc(it.p.title)}</span></button>`;
    }).join('');
  }

  $('#boardGrid').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del-note]');
    if (del) {
      e.stopPropagation();
      if (confirm('Take this note off the board?')) api('/api/notes/' + del.dataset.delNote, { method: 'DELETE' }).then(() => loadBoard());
      return;
    }
    const ph = e.target.closest('[data-photo]');
    if (ph) openLightbox(Number(ph.dataset.photo));
  });
  $('#boardRefresh').addEventListener('click', () => loadBoard(true));
  $('#boardUpload').addEventListener('change', (e) => uploadFiles('board', e.target.files).then(() => { e.target.value = ''; loadBoard(true); }));
  $('#addNoteBtn').addEventListener('click', () => {
    let color = 'yellow';
    openModal(`<h2>New note</h2>
      <div class="colors">${['yellow', 'pink', 'blue', 'green'].map((c) => `<button class="sticky ${c} ${c === color ? 'on' : ''}" data-c="${c}" style="min-height:0;padding:0"></button>`).join('')}</div>
      <label class="field"><textarea id="noteText" rows="4" maxlength="500" placeholder="Pick up milk 🥛" style="font-family:Caveat,cursive;font-size:1.6rem"></textarea></label>
      <div class="actions"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="noteSave">Pin it</button></div>`, (el) => {
      $$('[data-c]', el).forEach((b) => b.addEventListener('click', () => { color = b.dataset.c; $$('[data-c]', el).forEach((x) => x.classList.toggle('on', x === b)); }));
      $('[data-close]', el).addEventListener('click', closeModal);
      $('#noteSave', el).addEventListener('click', async () => {
        const text = $('#noteText', el).value.trim(); if (!text) return;
        await api('/api/notes', { body: { text, color } }); closeModal(); loadBoard();
      });
      setTimeout(() => $('#noteText', el).focus(), 50);
    });
  });

  async function uploadFiles(kind, files) {
    files = Array.from(files || []);
    if (!files.length) return;
    let ok = 0;
    for (const f of files) {
      toast(`Uploading ${f.name}…`);
      try {
        await api('/api/media/' + kind, { method: 'POST', body: f, headers: { 'X-Filename': encodeURIComponent(f.name), 'Content-Type': f.type || 'application/octet-stream' } });
        ok++;
      } catch (e) { toast(`${f.name}: ${e.message}`); }
    }
    if (ok) toast(`Uploaded ${ok} picture${ok > 1 ? 's' : ''}`);
  }

  // lightbox (tap a photo → full size, swipe to flip through)
  let lbIndex = 0;
  function openLightbox(i) { lbIndex = i; $('#lightbox').classList.remove('hidden'); showLb(); }
  function showLb() {
    const list = state.board.photos; if (!list.length) return closeLb();
    lbIndex = (lbIndex + list.length) % list.length;
    const p = list[lbIndex], img = $('#lbImg');
    img.style.opacity = 0;
    img.onload = () => { img.style.opacity = 1; };
    img.src = p.full;
    $('#lbTitle').textContent = `${p.title}  ·  ${lbIndex + 1} / ${list.length}`;
    // preload neighbour so swiping feels instant
    new Image().src = list[(lbIndex + 1) % list.length].full;
  }
  function closeLb() { $('#lightbox').classList.add('hidden'); $('#lbImg').src = ''; }
  $('#lightbox .lb-close').addEventListener('click', closeLb);
  $('#lightbox .prev').addEventListener('click', () => { lbIndex--; showLb(); });
  $('#lightbox .next').addEventListener('click', () => { lbIndex++; showLb(); });
  $('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') closeLb(); });
  swipe($('#lightbox'), (dir) => { lbIndex += dir; showLb(); });
  $('#lbDelete').addEventListener('click', () => withPin(async () => {
    const p = state.board.photos[lbIndex];
    if (!p || !confirm(`Remove "${p.title}" from the board?${p.source === 'dropbox' ? ' (This deletes it from Dropbox.)' : ''}`)) return;
    try { await api(`/api/media/board/${p.id}`, { method: 'DELETE' }); closeLb(); loadBoard(true); } catch (e) { toast(e.message); }
  }));

  function swipe(el, cb) {
    let x0 = null, y0 = 0;
    el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) cb(dx < 0 ? 1 : -1);
    });
  }

  // ================================================================ CAMERAS
  let camTimer;
  function renderCameras() {
    const cams = state.settings.cameras || [];
    if (!cams.length) {
      $('#camGrid').innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="big">📷</div>
        <b>No cameras yet.</b><br>Wyze doesn't let other apps view cameras directly, so run the free
        <b>docker-wyze-bridge</b> on a home computer, then add each camera in <b>Settings → Cameras</b>.
        See the README for the 5-minute setup.</div>`;
      return;
    }
    $('#camGrid').innerHTML = cams.map((c, i) => `<button class="cam" data-cam="${i}">
      ${c.snapshot ? `<img data-snap="${i}" alt="">` : '<div style="height:100%;display:flex;align-items:center;justify-content:center;color:#888;font-size:3rem">▶</div>'}
      <span class="label">${esc(c.name)}</span></button>`).join('');
    refreshSnapshots();
  }
  function refreshSnapshots() {
    clearTimeout(camTimer);
    if (state.view !== 'cameras' || !$('#saver').classList.contains('hidden')) return;
    $$('[data-snap]').forEach((img) => {
      const next = new Image();
      next.onload = () => { img.src = next.src; img.closest('.cam').classList.remove('offline'); };
      next.onerror = () => img.closest('.cam').classList.add('offline');
      next.src = `/api/cameras/${img.dataset.snap}/snapshot?t=${Date.now()}`;
    });
    camTimer = setTimeout(refreshSnapshots, 10000);
  }
  $('#camGrid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cam]'); if (!b) return;
    const cam = state.settings.cameras[Number(b.dataset.cam)];
    if (!cam.live) return toast('Add a live-view URL for this camera in Settings');
    $('#camLiveTitle').textContent = cam.name;
    $('#camFrame').src = cam.live;
    $('#camLive').classList.remove('hidden');
  });
  $('#camLive .lb-close').addEventListener('click', () => { $('#camLive').classList.add('hidden'); $('#camFrame').src = 'about:blank'; });

  // ================================================================ HOME / ALEXA
  const ICONS = { light: '💡', switch: '🔌', fan: '🌀', scene: '✨', script: '▶️', input_boolean: '🔘', lock: '🔒', cover: '🪟', climate: '🌡️', media_player: '🔊' };
  let homeStates = [];

  async function loadHome() {
    const body = $('#homeBody');
    if (!state.status.homeAssistant) {
      body.innerHTML = `<div class="empty"><div class="big">🏠</div><b>Connect Home Assistant to control your home.</b><br>
        Amazon doesn't offer a public Alexa API, so Family Hub talks to <b>Home Assistant</b> (free), which can run
        your Echo devices through the <b>Alexa Media Player</b> add-on and control the same lights and plugs Alexa does.
        Set <code>HA_URL</code> and <code>HA_TOKEN</code> on the server — the README walks through it.</div>`;
      return;
    }
    try { homeStates = await api('/api/home/states'); } catch (e) { body.innerHTML = `<div class="empty">⚠ ${esc(e.message)}</div>`; return; }
    renderHome();
  }

  function renderHome() {
    const s = state.settings.home, alexaIds = new Set(s.alexaDevices || []);
    const tiles = homeStates.filter((e) => !alexaIds.has(e.entity_id) && (s.entities.length ? true : e.domain !== 'media_player'));
    const echos = homeStates.filter((e) => alexaIds.has(e.entity_id));
    let html = '';
    if (echos.length) {
      const sel = localStorage.getItem('alexaDevice');
      const cur = echos.find((e) => e.entity_id === sel) || echos[0];
      const np = cur.attributes.media_title ? `${cur.attributes.media_title}${cur.attributes.media_artist ? ' — ' + cur.attributes.media_artist : ''}` : (cur.state === 'playing' ? 'Playing' : 'Nothing playing');
      html += `<div class="home-section"><h2>Alexa</h2><div class="alexa">
        <div class="row"><select id="alexaDev" style="flex:0 0 auto">${echos.map((e) => `<option value="${esc(e.entity_id)}" ${e === cur ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>
          <input id="alexaText" placeholder="Tell Alexa… e.g. “turn on the porch light”" autocomplete="off">
          <button class="btn primary" id="alexaSend" style="flex:0 0 auto">Send</button></div>
        <label class="check" style="margin:0"><input type="checkbox" id="alexaAnnounce"> Announce it out loud instead (house-wide message)</label>
        <div class="quick">${['What\'s the weather', 'Turn off all lights', 'Play relaxing music', 'Stop', 'Good night'].map((q) => `<button data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
        <div class="media"><button data-media="volume_down">🔉</button><button data-media="media_play_pause">⏯</button><button data-media="media_next_track">⏭</button><button data-media="volume_up">🔊</button><span class="np">${esc(np)}</span></div>
      </div></div>`;
    }
    html += `<div class="home-section"><h2>Devices</h2><div class="tiles">${tiles.map(tileHtml).join('') ||
      '<div class="empty" style="grid-column:1/-1">Pick which devices show here in <b>Settings → Home</b>.</div>'}</div></div>`;
    $('#homeBody').innerHTML = html;
  }

  function tileHtml(e) {
    const on = ['on', 'open', 'playing', 'unlocked', 'heat', 'cool', 'heat_cool'].includes(e.state);
    let status = e.state.replace(/_/g, ' ');
    if (e.domain === 'light' && on && e.attributes.brightness) status = `On · ${Math.round(e.attributes.brightness / 2.55)}%`;
    if (e.domain === 'climate') status = `${e.attributes.current_temperature ?? '–'}° now · set ${e.attributes.temperature ?? '–'}°`;
    if (e.domain === 'scene' || e.domain === 'script') status = 'Tap to run';
    const extra = e.domain === 'climate'
      ? `<div style="display:flex;gap:.4rem"><span class="btn ghost" data-temp="-1" style="min-height:2.2rem">–</span><span class="btn ghost" data-temp="1" style="min-height:2.2rem">+</span></div>` : '';
    return `<button class="tile ${on ? 'on' : ''} ${e.state === 'unavailable' ? 'unavailable' : ''}" data-entity="${esc(e.entity_id)}">
      <span class="ti">${e.domain === 'lock' && e.state === 'unlocked' ? '🔓' : ICONS[e.domain] || '⚪'}</span>
      <span><div class="tn">${esc(e.name)}</div><div class="ts">${esc(status)}</div></span>${extra}</button>`;
  }

  async function haCall(domain, service, data) {
    try { await api('/api/home/call', { body: { domain, service, data } }); } catch (e) { toast(e.message); }
    setTimeout(loadHome, 1200);
  }

  $('#homeBody').addEventListener('click', async (ev) => {
    const q = ev.target.closest('[data-q]');
    if (q) { $('#alexaText').value = q.dataset.q; return sendAlexa(); }
    if (ev.target.closest('#alexaSend')) return sendAlexa();
    const m = ev.target.closest('[data-media]');
    if (m) return haCall('media_player', m.dataset.media, { entity_id: $('#alexaDev').value });
    const t = ev.target.closest('[data-entity]'); if (!t) return;
    const e = homeStates.find((x) => x.entity_id === t.dataset.entity); if (!e) return;
    const id = { entity_id: e.entity_id };
    const temp = ev.target.closest('[data-temp]');
    if (e.domain === 'climate') {
      if (temp) haCall('climate', 'set_temperature', Object.assign(id, { temperature: (e.attributes.temperature || 70) + Number(temp.dataset.temp) }));
      return;
    }
    if (e.domain === 'lock') {
      const unlock = e.state === 'locked';
      if (unlock && !confirm(`Unlock ${e.name}?`)) return;
      return haCall('lock', unlock ? 'unlock' : 'lock', id);
    }
    if (e.domain === 'cover') return haCall('cover', e.state === 'open' ? 'close_cover' : 'open_cover', id);
    if (e.domain === 'scene' || e.domain === 'script') { toast(`Running ${e.name}`); return haCall(e.domain, 'turn_on', id); }
    if (e.domain === 'media_player') return haCall('media_player', 'media_play_pause', id);
    t.classList.toggle('on'); // instant feedback
    haCall(e.domain, 'toggle', id);
  });
  $('#homeBody').addEventListener('change', (e) => { if (e.target.id === 'alexaDev') { localStorage.setItem('alexaDevice', e.target.value); renderHome(); } });
  $('#homeBody').addEventListener('keydown', (e) => { if (e.target.id === 'alexaText' && e.key === 'Enter') sendAlexa(); });
  $('#homeRefresh').addEventListener('click', loadHome);

  async function sendAlexa() {
    const text = $('#alexaText').value.trim(); if (!text) return;
    try {
      await api('/api/alexa/command', { body: { device: $('#alexaDev').value, text, announce: $('#alexaAnnounce').checked } });
      toast('Sent to Alexa'); $('#alexaText').value = '';
    } catch (e) { toast(e.message); }
  }

  // ================================================================ SETTINGS
  let draft;
  function renderSettings() {
    draft = JSON.parse(JSON.stringify(state.settings));
    const st = state.status, s = draft, ss = s.screensaver;
    const origin = location.origin;
    $('#settingsBody').innerHTML = `
    <div class="card"><h2>General</h2>
      <label class="field">Display name<input id="sTitle" value="${esc(s.title)}"></label>
      <div class="row"><label class="field">Clock<select id="s24"><option value="0">12-hour (3:30 PM)</option><option value="1" ${s.use24h ? 'selected' : ''}>24-hour (15:30)</option></select></label>
      <label class="field">Week starts<select id="sWeek"><option value="0">Sunday</option><option value="1" ${s.weekStartsOn === 1 ? 'selected' : ''}>Monday</option></select></label></div>
      <label class="field">Settings PIN (blank = no PIN)<input id="sPin" inputmode="numeric" maxlength="8" placeholder="${s.hasPin ? '•••• (unchanged)' : 'none'}"></label>
      ${s.hasPin ? '<div class="check"><input type="checkbox" id="sPinOff"> Remove the PIN</div>' : ''}
      <div class="check"><input type="checkbox" id="tCam" ${s.tabs.cameras !== false ? 'checked' : ''}> Cameras tab</div>
      <div class="check"><input type="checkbox" id="tHome" ${s.tabs.home !== false ? 'checked' : ''}> Home / Alexa tab</div>
      <div class="check"><input type="checkbox" id="tSnacks" ${s.tabs.snacks ? 'checked' : ''}> Snack Station tab</div>
    </div>

    <div class="card"><h2>Calendars</h2>
      <p class="hint">Paste the <b>secret iCal / .ics address</b> of each calendar. Google: Calendar settings → <i>Secret address in iCal format</i>.
      iPhone/iCloud: share calendar → <i>Public Calendar</i>. Outlook: Settings → Shared calendars → <i>Publish</i>. Syncs every 10 minutes.</p>
      <div id="calRows"></div>
      <button class="btn ghost" id="addCal">＋ Add calendar</button>
      <hr style="border:0;border-top:1px solid var(--line);margin:1rem 0">
      <div class="list-row"><input type="color" id="localColor" value="${esc(s.localCalendar.color)}"><input type="text" id="localName" value="${esc(s.localCalendar.name)}"></div>
      <p class="hint" style="margin:0">Events you add on this screen go into this calendar. To see them on your phones, subscribe to
      <code>${esc(origin)}/calendar.ics</code> (works while your phone is on home Wi-Fi).</p>
    </div>

    <div class="card"><h2>Dropbox</h2>
      <div class="status ${st.dropbox.connected ? 'ok' : ''}">${st.dropbox.connected ? 'Connected' : st.dropbox.appKeys ? 'Not connected' : 'App keys not set on server'}</div>
      ${st.dropbox.appKeys ? (st.dropbox.connected
        ? '<div><button class="btn ghost" id="dbxOff">Disconnect</button></div>'
        : `<p class="hint">1. Tap <b>Get code</b> and sign in to Dropbox (scan/open it on your phone if easier).<br>2. Paste the code it shows you here.</p>
           <div class="list-row"><button class="btn ghost" id="dbxLink">Get code</button><input type="text" id="dbxCode" placeholder="Paste code"><button class="btn primary" id="dbxGo">Connect</button></div>
           <div id="dbxUrl" class="hint" style="word-break:break-all"></div>`)
        : '<p class="hint">Create a Dropbox app and set <code>DROPBOX_APP_KEY</code> / <code>DROPBOX_APP_SECRET</code> on the server (see README). Until then, photos uploaded here are stored on the server.</p>'}
      <label class="field">Bulletin board folder<input id="boardFolder" value="${esc(s.board.dropboxFolder)}"></label>
      <label class="field">Screensaver folder<input id="saverFolder" value="${esc(ss.dropboxFolder)}"></label>
    </div>

    <div class="card"><h2>Screensaver</h2>
      <div class="check"><input type="checkbox" id="ssOn" ${ss.enabled ? 'checked' : ''}> Start automatically when idle</div>
      <div class="row"><label class="field">After (minutes idle)<input type="number" min="1" max="240" id="ssIdle" value="${ss.idleMinutes}"></label>
      <label class="field">Change picture every (seconds)<input type="number" min="5" max="3600" id="ssInt" value="${ss.intervalSeconds}"></label></div>
      <div class="check"><input type="checkbox" id="ssClock" ${ss.showClock ? 'checked' : ''}> Show the time</div>
      <div class="check"><input type="checkbox" id="ssDate" ${ss.showDate ? 'checked' : ''}> Show the date</div>
      <div class="check"><input type="checkbox" id="ssNext" ${ss.showNextEvent ? 'checked' : ''}> Show the next calendar event</div>
      <div class="check"><input type="checkbox" id="ssKb" ${ss.kenBurns ? 'checked' : ''}> Slow zoom effect</div>
      <label class="field">Clock position<select id="ssPos">${['bottom-left', 'bottom-right', 'top-left', 'top-right', 'center'].map((p) => `<option ${ss.clockPosition === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
      <div class="list-row"><label class="btn ghost">⬆️ Upload artwork<input type="file" id="ssUpload" accept="image/*" multiple hidden></label><button class="btn ghost" id="ssPreview">Preview</button></div>
      <div id="ssThumbs" class="thumbs"></div>
    </div>

    <div class="card"><h2>Cameras</h2>
      <p class="hint">With docker-wyze-bridge running at e.g. <code>192.168.1.50</code>, a camera named "Front Door" uses<br>
      Live: <code>http://192.168.1.50:8889/front-door/</code><br>Snapshot: <code>http://192.168.1.50:5000/snapshot/front-door.jpg</code></p>
      <div id="camRows"></div><button class="btn ghost" id="addCam">＋ Add camera</button>
    </div>

    <div class="card"><h2>Home &amp; Alexa</h2>
      <div class="status ${st.homeAssistant ? 'ok' : ''}">${st.homeAssistant ? 'Home Assistant connected' : 'Home Assistant not configured'}</div>
      ${st.homeAssistant ? '<p class="hint">Tick what to show. Echo devices (from Alexa Media Player) appear as media players — tick them under <b>Alexa</b>.</p><div id="haPick" class="picklist">Loading…</div>'
        : '<p class="hint">Set <code>HA_URL</code> and <code>HA_TOKEN</code> on the server, then restart it.</p>'}
    </div>

    <div class="card"><h2>About</h2><p class="hint">Open <code>${esc(origin)}</code> on a phone or computer on the same Wi-Fi to change settings or upload pictures from there.</p>
      <button class="btn ghost" onclick="location.reload()">Reload display</button></div>`;

    // calendars
    const calRows = () => {
      $('#calRows').innerHTML = s.calendars.map((c, i) => `<div class="list-row"><input type="color" data-ci="${i}" data-k="color" value="${esc(c.color)}">
        <input type="text" data-ci="${i}" data-k="name" value="${esc(c.name)}" placeholder="Name" style="flex:0 0 8rem">
        <input type="url" data-ci="${i}" data-k="url" value="${esc(c.url)}" placeholder="https://… .ics"><button class="rm" data-rmcal="${i}">✕</button></div>`).join('');
    };
    calRows();
    $('#calRows').addEventListener('input', (e) => { const i = e.target.dataset.ci; if (i != null) s.calendars[i][e.target.dataset.k] = e.target.value; });
    $('#calRows').addEventListener('click', (e) => { const i = e.target.dataset.rmcal; if (i != null) { s.calendars.splice(i, 1); calRows(); } });
    $('#addCal').addEventListener('click', () => { s.calendars.push({ name: '', url: '', color: ['#3d7dd8', '#81b29a', '#9b59b6', '#f2b632', '#d64545'][s.calendars.length % 5] }); calRows(); });

    // cameras
    const camRows = () => {
      $('#camRows').innerHTML = s.cameras.map((c, i) => `<div style="margin-bottom:.7rem"><div class="list-row"><input type="text" data-mi="${i}" data-k="name" value="${esc(c.name)}" placeholder="Name"><button class="rm" data-rmcam="${i}">✕</button></div>
        <div class="list-row"><input type="url" data-mi="${i}" data-k="live" value="${esc(c.live || '')}" placeholder="Live view URL"></div>
        <div class="list-row"><input type="url" data-mi="${i}" data-k="snapshot" value="${esc(c.snapshot || '')}" placeholder="Snapshot URL (optional)"></div></div>`).join('');
    };
    camRows();
    $('#camRows').addEventListener('input', (e) => { const i = e.target.dataset.mi; if (i != null) s.cameras[i][e.target.dataset.k] = e.target.value; });
    $('#camRows').addEventListener('click', (e) => { const i = e.target.dataset.rmcam; if (i != null) { s.cameras.splice(i, 1); camRows(); } });
    $('#addCam').addEventListener('click', () => { s.cameras.push({ name: '', live: '', snapshot: '' }); camRows(); });

    // dropbox
    if ($('#dbxLink')) $('#dbxLink').addEventListener('click', async () => {
      try {
        const { url } = await api('/api/dropbox/auth-url');
        $('#dbxUrl').innerHTML = `Opening Dropbox… If nothing opens, visit:<br><code>${esc(url)}</code>`;
        window.open(url, '_blank');
      } catch (e) { toast(e.message); }
    });
    if ($('#dbxGo')) $('#dbxGo').addEventListener('click', async () => {
      try { await api('/api/dropbox/code', { body: { code: $('#dbxCode').value } }); toast('Dropbox connected'); await refreshStatus(); renderSettings(); } catch (e) { toast(e.message); }
    });
    if ($('#dbxOff')) $('#dbxOff').addEventListener('click', async () => {
      if (!confirm('Disconnect Dropbox? Your files stay in Dropbox.')) return;
      await api('/api/dropbox/disconnect', { body: {} }); await refreshStatus(); renderSettings();
    });

    // screensaver art
    const loadThumbs = async (fresh) => {
      const { items } = await api('/api/media/screensaver' + (fresh ? '?fresh=1' : ''));
      $('#ssThumbs').innerHTML = items.map((it) => `<div><img loading="lazy" src="${esc(it.thumb)}" alt=""><button data-rmart="${esc(it.id)}" aria-label="Remove">✕</button></div>`).join('') ||
        '<p class="hint" style="grid-column:1/-1">No artwork yet — the screensaver will use bulletin board photos until you add some.</p>';
    };
    loadThumbs();
    $('#ssUpload').addEventListener('change', (e) => uploadFiles('screensaver', e.target.files).then(() => { e.target.value = ''; loadThumbs(true); }));
    $('#ssThumbs').addEventListener('click', async (e) => {
      const id = e.target.dataset.rmart; if (!id || !confirm('Remove this artwork?')) return;
      try { await api('/api/media/screensaver/' + id, { method: 'DELETE' }); loadThumbs(true); } catch (err) { toast(err.message); }
    });
    $('#ssPreview').addEventListener('click', () => { collectSettings(); startSaver(draft.screensaver); });

    // home assistant picker
    if (st.homeAssistant) api('/api/home/all').then((all) => {
      const sel = new Set(s.home.entities), alexa = new Set(s.home.alexaDevices);
      const players = all.filter((e) => e.domain === 'media_player'), others = all.filter((e) => e.domain !== 'media_player');
      const row = (e, set, attr) => `<label><input type="checkbox" ${attr}="${esc(e.entity_id)}" ${set.has(e.entity_id) ? 'checked' : ''}> ${ICONS[e.domain] || ''} ${esc(e.name)} <small>${esc(e.entity_id)}</small></label>`;
      $('#haPick').innerHTML = `<b>Alexa / speakers</b>${players.map((e) => row(e, alexa, 'data-alexa')).join('') || '<div class="hint">No media players found — install Alexa Media Player in Home Assistant.</div>'}
        <br><b>Devices</b>${others.map((e) => row(e, sel, 'data-ent')).join('')}`;
    }).catch((e) => { $('#haPick').textContent = e.message; });
  }

  function collectSettings() {
    const s = draft, v = (id) => $('#' + id).value, c = (id) => $('#' + id).checked;
    s.title = v('sTitle'); s.use24h = v('s24') === '1'; s.weekStartsOn = Number(v('sWeek'));
    s.tabs = { cameras: c('tCam'), home: c('tHome'), snacks: c('tSnacks') };
    s.localCalendar = { name: v('localName') || 'Family', color: v('localColor') };
    s.board.dropboxFolder = v('boardFolder');
    Object.assign(s.screensaver, {
      enabled: c('ssOn'), idleMinutes: Math.max(1, Number(v('ssIdle')) || 5), intervalSeconds: Math.max(5, Number(v('ssInt')) || 20),
      showClock: c('ssClock'), showDate: c('ssDate'), showNextEvent: c('ssNext'), kenBurns: c('ssKb'), clockPosition: v('ssPos'), dropboxFolder: v('saverFolder'),
    });
    if ($('#haPick') && $('[data-ent], [data-alexa]', $('#haPick'))) {
      s.home.entities = $$('[data-ent]:checked').map((x) => x.dataset.ent);
      s.home.alexaDevices = $$('[data-alexa]:checked').map((x) => x.dataset.alexa);
    }
    s.calendars = s.calendars.filter((k) => k.url.trim());
    s.cameras = s.cameras.filter((k) => k.name.trim() || k.live.trim());
    const pin = v('sPin').trim();
    if (pin) s.pin = pin; else delete s.pin;
    if ($('#sPinOff') && c('sPinOff')) s.pin = '';
    return s;
  }

  $('#saveSettings').addEventListener('click', async () => {
    const s = collectSettings();
    try {
      state.settings = await api('/api/settings', { method: 'PUT', body: s });
      if (s.pin) state.pin = s.pin;
      applyTabs(); resetIdle(); toast('Saved'); loadCalendar(); renderSettings();
    } catch (e) { toast(e.message); }
  });

  async function refreshStatus() { state.status = await api('/api/status'); }

  // ================================================================ SCREENSAVER
  let idleTimer, saverTimer, saverItems = [], saverIdx = 0, saverFront = 'A', saverOpts, nextEvent = null;

  function resetIdle() {
    clearTimeout(idleTimer);
    const ss = state.settings && state.settings.screensaver;
    if (!ss || !ss.enabled) return;
    // don't fall asleep mid-movie on a live camera
    idleTimer = setTimeout(() => { if ($('#camLive').classList.contains('hidden')) startSaver(); else resetIdle(); }, ss.idleMinutes * 60000);
  }
  ['pointerdown', 'touchstart', 'keydown', 'wheel'].forEach((ev) => document.addEventListener(ev, () => { if ($('#saver').classList.contains('hidden')) resetIdle(); }, { passive: true, capture: true }));

  async function startSaver(opts) {
    saverOpts = opts || state.settings.screensaver;
    const saver = $('#saver');
    saver.classList.remove('hidden');
    saver.classList.toggle('with-clock', saverOpts.showClock || saverOpts.showDate);
    const clock = $('#saverClock');
    clock.className = 'saver-clock ' + saverOpts.clockPosition;
    clock.classList.toggle('hidden', !(saverOpts.showClock || saverOpts.showDate || saverOpts.showNextEvent));
    const pos = { 'bottom-left': ['0%', '100%'], 'bottom-right': ['100%', '100%'], 'top-left': ['0%', '0%'], 'top-right': ['100%', '0%'], center: ['50%', '50%'] }[saverOpts.clockPosition] || ['0%', '100%'];
    saver.style.setProperty('--sx', pos[0]); saver.style.setProperty('--sy', pos[1]);
    renderSaverClock(new Date());
    try {
      saverItems = (await api('/api/media/screensaver')).items;
      if (!saverItems.length) saverItems = (await api('/api/media/board')).items; // fall back to board photos
    } catch { saverItems = []; }
    shuffle(saverItems);
    saverIdx = 0;
    loadNextEvent();
    $('#saverA').className = 'saver-img'; $('#saverB').className = 'saver-img';
    if (!saverItems.length) { $('#saverA').className = 'saver-img show saver-empty'; return; }
    saverStep();
  }

  function saverStep() {
    clearTimeout(saverTimer);
    if ($('#saver').classList.contains('hidden') || !saverItems.length) return;
    const item = saverItems[saverIdx++ % saverItems.length];
    const img = new Image();
    img.onload = () => {
      if ($('#saver').classList.contains('hidden')) return;
      const incoming = $('#saver' + (saverFront === 'A' ? 'B' : 'A')), outgoing = $('#saver' + saverFront);
      // art shaped like the screen fills it; art in the other orientation is shown whole rather than cropped
      const imgR = img.naturalWidth / img.naturalHeight, scrR = window.innerWidth / window.innerHeight;
      const fill = Math.max(imgR / scrR, scrR / imgR) < 1.45;
      $('.fg', incoming).style.backgroundImage = $('.bg', incoming).style.backgroundImage = `url("${item.full}")`;
      incoming.style.setProperty('--dur', (saverOpts.intervalSeconds + 3) + 's');
      incoming.style.setProperty('--kx', (Math.random() * 4 - 2).toFixed(1) + '%');
      incoming.style.setProperty('--ky', (Math.random() * 4 - 2).toFixed(1) + '%');
      incoming.className = 'saver-img' + (fill ? ' fill' : '') + (saverOpts.kenBurns ? ' kb' : '');
      void incoming.offsetWidth; // restart the zoom animation
      incoming.classList.add('show');
      outgoing.classList.remove('show');
      saverFront = saverFront === 'A' ? 'B' : 'A';
      saverTimer = setTimeout(saverStep, saverOpts.intervalSeconds * 1000);
    };
    img.onerror = () => { saverTimer = setTimeout(saverStep, 1000); };
    img.src = item.full;
  }

  function renderSaverClock(now) {
    const o = saverOpts || state.settings.screensaver;
    const t = fmtTime(now), m = t.match(/^(.*?)\s?([AP]M)$/i);
    $('#scTime').innerHTML = o.showClock ? (m ? `${esc(m[1])}<small>${esc(m[2])}</small>` : esc(t)) : '';
    $('#scDate').textContent = o.showDate ? now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) : '';
    let next = '';
    if (o.showNextEvent && nextEvent) {
      const s = nextEvent.allDay ? parseYmd(nextEvent.start) : new Date(nextEvent.start);
      const day = sameDay(s, now) ? 'Today' : sameDay(s, addDays(now, 1)) ? 'Tomorrow' : s.toLocaleDateString([], { weekday: 'long' });
      next = `Next: ${nextEvent.title} · ${day}${nextEvent.allDay ? '' : ' ' + fmtTime(s)}`;
    }
    $('#scNext').textContent = next;
  }

  async function loadNextEvent() {
    try {
      const now = new Date();
      const { events } = await api(`/api/events?from=${now.toISOString()}&to=${addDays(now, 14).toISOString()}`);
      const today = ymd(now);
      nextEvent = events.filter((e) => !state.cal.hidden.has(e.calendarId))
        .find((e) => (e.allDay ? e.start >= today : new Date(e.start) > now)) || null;
      renderSaverClock(new Date());
    } catch { nextEvent = null; }
  }

  function stopSaver() {
    clearTimeout(saverTimer);
    $('#saver').classList.add('hidden');
    $$('#saver .bg, #saver .fg').forEach((el) => { el.style.backgroundImage = ''; });
    resetIdle();
    if (state.view === 'cameras') refreshSnapshots();
    if (state.view === 'calendar') loadCalendar();
  }
  // swallow the waking tap so it doesn't also press whatever was underneath
  ['pointerdown', 'touchstart', 'mousedown', 'click'].forEach((ev) => $('#saver').addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    if (ev === 'pointerdown' || ev === 'touchstart') setTimeout(stopSaver, 50);
  }, { passive: false }));
  $('#sleepBtn').addEventListener('click', () => startSaver());

  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  // ================================================================ boot
  async function boot() {
    try {
      [state.settings] = await Promise.all([api('/api/settings'), refreshStatus()]);
    } catch (e) {
      document.body.innerHTML = `<div class="empty" style="margin-top:20vh"><div class="big">🔌</div><b>Can't reach the Family Hub server.</b><br>${esc(e.message)}<br>Retrying…</div>`;
      return setTimeout(() => location.reload(), 15000);
    }
    applyTabs();
    tickClock(); setInterval(tickClock, 1000);
    showView('calendar');
    loadCalendar();
    resetIdle();
    setInterval(() => { if ($('#saver').classList.contains('hidden')) loadCalendar(); }, 5 * 60000);
    setInterval(() => { if (state.view === 'board' && $('#saver').classList.contains('hidden')) loadBoard(); }, 10 * 60000);
    window.addEventListener('resize', () => { if (state.view === 'calendar') renderCalendar(); });
  }
  boot();
})();
