// Smart-home bridge. Neither Wyze nor Amazon offers a public API for this, so we
// go through Home Assistant: its "Alexa Media Player" custom integration can
// drive Echo devices, and Home Assistant itself controls the lights/plugs/etc.
// that Alexa normally controls. The token stays on the server.
const URL_ = (process.env.HA_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.HA_TOKEN || '';
export const isConfigured = () => !!(URL_ && TOKEN);

async function ha(pathname, body) {
  const res = await fetch(URL_ + pathname, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Home Assistant ${pathname} → HTTP ${res.status}`);
  return res.json();
}

export const CONTROLLABLE = ['light', 'switch', 'fan', 'scene', 'script', 'input_boolean', 'lock', 'cover', 'media_player', 'climate'];

export async function states(entityIds) {
  const all = await ha('/api/states');
  const pick = (s) => ({
    entity_id: s.entity_id,
    domain: s.entity_id.split('.')[0],
    name: s.attributes.friendly_name || s.entity_id,
    state: s.state,
    attributes: {
      brightness: s.attributes.brightness,
      current_temperature: s.attributes.current_temperature,
      temperature: s.attributes.temperature,
      unit: s.attributes.unit_of_measurement,
      media_title: s.attributes.media_title,
      media_artist: s.attributes.media_artist,
      volume_level: s.attributes.volume_level,
    },
  });
  if (entityIds?.length) {
    const byId = new Map(all.map((s) => [s.entity_id, s]));
    return entityIds.map((id) => byId.get(id)).filter(Boolean).map(pick);
  }
  return all.filter((s) => CONTROLLABLE.includes(s.entity_id.split('.')[0])).map(pick);
}

// Only allow the small set of actions the dashboard actually needs.
const ALLOWED = {
  light: ['toggle', 'turn_on', 'turn_off'],
  switch: ['toggle', 'turn_on', 'turn_off'],
  fan: ['toggle', 'turn_on', 'turn_off'],
  input_boolean: ['toggle', 'turn_on', 'turn_off'],
  scene: ['turn_on'],
  script: ['turn_on'],
  lock: ['lock', 'unlock'],
  cover: ['open_cover', 'close_cover', 'stop_cover'],
  climate: ['set_temperature'],
  media_player: ['media_play_pause', 'media_next_track', 'volume_up', 'volume_down', 'volume_set', 'play_media'],
};

export async function call(domain, service, data) {
  if (!ALLOWED[domain]?.includes(service)) throw Object.assign(new Error(`${domain}.${service} is not allowed`), { status: 400 });
  return ha(`/api/services/${domain}/${service}`, data);
}

// "Alexa, turn on the porch light" — typed or tapped on the display, run by the chosen Echo.
export const alexaCommand = (device, text) =>
  ha('/api/services/media_player/play_media', { entity_id: device, media_content_id: text, media_content_type: 'custom' });

export const alexaAnnounce = (device, message) =>
  ha('/api/services/notify/alexa_media', { message, target: [device], data: { type: 'announce' } });
