// Tiny JSON-file persistence for settings, local events and secrets.
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export function readJSON(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

export function writeJSON(name, value) {
  const file = path.join(DATA_DIR, name);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file); // atomic replace so a power cut can't corrupt the file
}

export const DEFAULT_SETTINGS = {
  title: 'Family Hub',
  pin: '',                 // optional PIN required to change settings / delete things
  use24h: false,
  weekStartsOn: 0,         // 0 = Sunday, 1 = Monday
  calendars: [],           // [{ id, name, url, color }]
  localCalendar: { name: 'Family', color: '#e07a5f' },
  board: { dropboxFolder: '/Bulletin Board' },
  screensaver: {
    enabled: true,
    idleMinutes: 5,
    intervalSeconds: 20,
    showClock: true,
    showDate: true,
    showNextEvent: true,
    clockPosition: 'bottom-left', // bottom-left | bottom-right | top-left | top-right | center
    kenBurns: true,
    dropboxFolder: '/Screensaver',
  },
  cameras: [],             // [{ name, live, snapshot }]
  home: { entities: [], alexaDevices: [] },
  tabs: { cameras: true, home: true, snacks: false },
};

export function getSettings() {
  const s = readJSON('settings.json', DEFAULT_SETTINGS);
  // shallow-merge nested defaults so new options appear after upgrades
  const out = { ...structuredClone(DEFAULT_SETTINGS), ...s };
  for (const k of ['localCalendar', 'board', 'screensaver', 'home', 'tabs']) {
    out[k] = { ...DEFAULT_SETTINGS[k], ...(s[k] || {}) };
  }
  return out;
}

export function saveSettings(s) {
  writeJSON('settings.json', s);
}
