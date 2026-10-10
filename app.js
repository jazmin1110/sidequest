// SideQuest — vanilla JS PWA. One file on purpose: easy to read, easy to tweak.
// Flow: login -> pick/create/join a group -> Quests / Diary / Crew tabs.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $app = document.getElementById('app');

// Everything the UI shows lives here. Render functions read it, nothing else.
const state = {
  user: null, profile: null,
  groups: [], group: null, tab: 'quests',
  members: [], quests: [], entries: [],
  filter: null,    // tag key the Quests tab is filtered to (null = all)
  cal: null,       // calendar month being viewed {y, m}; null = this month
  photoUrls: {},   // storage path -> signed url
  chan: null,      // realtime channel
};

// ---------- tiny helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const myId = () => state.user.id;

// ---------- avatars ----------
// Every member is a little full-body character drawn from SVG layers (no outside service, works offline).
// A profile's avatar_seed is either "fb1:" + a query string of the picks below, or an older plain seed.
// Older seeds are turned into a random-but-stable character so nobody starts empty; it's saved the first time they edit.
// Same column as before, so no database change.
const SKIN = ['ffe0c7', 'f6c9a0', 'e0a878', 'c58c5e', '9a6540', '6b4429'];
const HAIRC = ['2b1d16', '4a3224', '7a4b2a', 'b5742f', 'e0b45c', 'f0dfa6', 'c0392b', 'f48fb1', '8e6cc6', '4a90d9', '9aa0a6', 'ffffff'];
const CLOTH = ['e63946', 'f4845f', 'f9c74f', '90be6a', '43aa8b', '4d908e', '4a90d9', '5b4bdb', '9b5de5', 'f15bb5', '2b2540', '6c757d', 'f1f1f1', '8d6e63'];
const BGS = ['d9ecff', 'e4dcff', 'ffdfe6', 'ffe9d2', 'dcf5e3', 'fff6c9', 'e6e6ee', 'cfeff0'];
const AV_OPTS = {
  hair: ['short', 'spiky', 'long', 'bob', 'curly', 'bun', 'ponytail', 'buzz', 'bald'],
  eyes: ['dot', 'happy', 'sparkle', 'sleepy', 'wink'],
  mouth: ['smile', 'open', 'flat', 'cat'],
  blush: ['1', '0'],
  glasses: ['none', 'round', 'sunglasses'],
  head: ['none', 'cap', 'beanie', 'bow', 'crown', 'headband'],
  top: ['tee', 'hoodie', 'tank', 'jacket', 'dress'],
  bottom: ['pants', 'shorts', 'skirt'],
  shoes: ['sneakers', 'boots', 'sandals'],
};
const AV_COLORS = { skin: SKIN, hairColor: HAIRC, topColor: CLOTH, bottomColor: CLOTH, shoeColor: CLOTH, accent: CLOTH, bg: BGS };
// Editor layout: tab name -> rows of [key, label, kind]. kind 'chips' = text buttons, 'color' = swatches.
const AV_TABS = [
  ['Hair', [['hair', 'Style', 'chips'], ['hairColor', 'Hair color', 'color']]],
  ['Face', [['skin', 'Skin', 'color'], ['eyes', 'Eyes', 'chips'], ['mouth', 'Mouth', 'chips'], ['blush', 'Blush', 'chips'], ['glasses', 'Glasses', 'chips']]],
  ['Outfit', [['top', 'Top', 'chips'], ['topColor', 'Top color', 'color'], ['bottom', 'Bottom (dress ignores this)', 'chips'], ['bottomColor', 'Bottom color', 'color'], ['shoes', 'Shoes', 'chips'], ['shoeColor', 'Shoe color', 'color']]],
  ['Extras', [['head', 'Headwear', 'chips'], ['accent', 'Headwear color', 'color']]],
  ['Backdrop', [['bg', 'Background', 'color']]],
];
const AV_DEFAULT = { hair: 'short', hairColor: '2b1d16', skin: 'f6c9a0', eyes: 'dot', mouth: 'smile', blush: '1', glasses: 'none', head: 'none', accent: 'f9c74f', top: 'hoodie', topColor: '5b4bdb', bottom: 'pants', bottomColor: '2b2540', shoes: 'sneakers', shoeColor: 'f1f1f1', bg: 'e4dcff' };

const hashStr = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const rngFrom = (seed) => { let a = hashStr(seed); return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; };
const avRandom = (rand = Math.random) => {
  const p = (a) => a[Math.floor(rand() * a.length)];
  return {
    hair: p(AV_OPTS.hair), hairColor: p(HAIRC), skin: p(SKIN), eyes: p(AV_OPTS.eyes), mouth: p(AV_OPTS.mouth), blush: p(AV_OPTS.blush),
    glasses: rand() < .25 ? p(AV_OPTS.glasses.slice(1)) : 'none', head: rand() < .35 ? p(AV_OPTS.head.slice(1)) : 'none', accent: p(CLOTH),
    top: p(AV_OPTS.top), topColor: p(CLOTH), bottom: p(AV_OPTS.bottom), bottomColor: p(CLOTH), shoes: p(AV_OPTS.shoes), shoeColor: p(CLOTH), bg: p(BGS),
  };
};
const avEncode = (cfg) => 'fb1:' + new URLSearchParams(cfg).toString();
// Seed -> full valid config. Unknown/old seeds become a stable random character.
const avDecode = (seed) => {
  const s = String(seed ?? '');
  if (!s.startsWith('fb1:')) return avRandom(rngFrom(s));
  const got = Object.fromEntries(new URLSearchParams(s.slice(4)));
  const cfg = { ...AV_DEFAULT };
  for (const k of Object.keys(AV_DEFAULT)) {
    const list = AV_OPTS[k] || AV_COLORS[k];
    if (list.includes(got[k])) cfg[k] = got[k];
  }
  return cfg;
};
const avLabel = (v) => v === '1' ? 'On' : v === '0' ? 'Off' : v === 'none' ? 'None' : v.charAt(0).toUpperCase() + v.slice(1);

// Draw the character. mode 'full' = whole body on transparent; 'head' = square head crop with the backdrop colour (for small spots).
function avatarSvg(cfg, mode = 'full') {
  const ink = '#2b2540';
  const S = '#' + cfg.skin, H = '#' + cfg.hairColor, T = '#' + cfg.topColor, B = '#' + cfg.bottomColor, SH = '#' + cfg.shoeColor, A = '#' + cfg.accent;
  const shadeLayer = (d) => `<path d="${d}" fill="#000" opacity=".1"/>`;
  const dress = cfg.top === 'dress';
  const longSleeve = cfg.top === 'hoodie' || cfg.top === 'jacket';
  const bare = cfg.top === 'tank';
  const L = []; // layers, back to front

  L.push('<ellipse cx="50" cy="141" rx="24" ry="4.5" fill="#000" opacity=".12"/>');

  // hair behind head/body
  if (cfg.hair === 'long') L.push(`<path d="M25 36C22 70 24 86 31 90L69 90C76 86 78 70 75 36Z" fill="${H}"/>`);
  if (cfg.hair === 'bob') L.push(`<path d="M25 34C22 52 24 63 31 65L69 65C76 63 78 52 75 34Z" fill="${H}"/>`);
  if (cfg.hair === 'curly') L.push([[30, 28, 11], [40, 19, 12], [50, 16, 12], [60, 19, 12], [70, 28, 11], [26, 42, 8], [74, 42, 8]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${H}"/>`).join(''));
  if (cfg.hair === 'bun') L.push(`<circle cx="50" cy="11" r="9" fill="${H}"/>`);
  if (cfg.hair === 'ponytail') L.push(`<ellipse cx="83" cy="52" rx="7" ry="17" transform="rotate(-14 83 52)" fill="${H}"/>`);

  // legs (skin) + bottoms
  L.push(`<rect x="38.5" y="102" width="10.5" height="30" rx="4" fill="${S}"/><rect x="51" y="102" width="10.5" height="30" rx="4" fill="${S}"/>`);
  if (!dress) {
    if (cfg.bottom === 'pants') L.push(`<rect x="37" y="98" width="12.5" height="31" rx="4" fill="${B}"/><rect x="50.5" y="98" width="12.5" height="31" rx="4" fill="${B}"/>`);
    if (cfg.bottom === 'shorts') L.push(`<rect x="37" y="98" width="12.5" height="17" rx="4" fill="${B}"/><rect x="50.5" y="98" width="12.5" height="17" rx="4" fill="${B}"/>`);
    if (cfg.bottom === 'skirt') L.push(`<path d="M35 98L65 98L73 121L27 121Z" fill="${B}" stroke="${B}" stroke-width="3" stroke-linejoin="round"/>`);
  }
  // shoes
  if (cfg.shoes === 'sneakers') L.push(`<ellipse cx="43" cy="134" rx="9.5" ry="5.2" fill="${SH}"/><ellipse cx="57" cy="134" rx="9.5" ry="5.2" fill="${SH}"/><rect x="33.5" y="136.5" width="19" height="3" rx="1.5" fill="#fff" opacity=".85"/><rect x="47.5" y="136.5" width="19" height="3" rx="1.5" fill="#fff" opacity=".85"/>`);
  if (cfg.shoes === 'boots') L.push(`<rect x="36.5" y="122" width="13" height="15" rx="4.5" fill="${SH}"/><rect x="50.5" y="122" width="13" height="15" rx="4.5" fill="${SH}"/><ellipse cx="42" cy="136.5" rx="9" ry="4" fill="${SH}"/><ellipse cx="58" cy="136.5" rx="9" ry="4" fill="${SH}"/>`);
  if (cfg.shoes === 'sandals') L.push(`<ellipse cx="43" cy="135.5" rx="8.5" ry="3.2" fill="${SH}"/><ellipse cx="57" cy="135.5" rx="8.5" ry="3.2" fill="${SH}"/><path d="M38 132Q43 128 48 132M52 132Q57 128 62 132" stroke="${SH}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`);

  // arms
  const sleeveFull = `<rect x="23.5" y="70" width="10.5" height="31" rx="5.2" fill="${T}"/><rect x="66" y="70" width="10.5" height="31" rx="5.2" fill="${T}"/>`;
  const armSkin = `<rect x="23.5" y="70" width="10.5" height="31" rx="5.2" fill="${S}"/><rect x="66" y="70" width="10.5" height="31" rx="5.2" fill="${S}"/>`;
  L.push(longSleeve ? sleeveFull : armSkin + (bare ? '' : `<rect x="23.5" y="70" width="10.5" height="14" rx="5.2" fill="${T}"/><rect x="66" y="70" width="10.5" height="14" rx="5.2" fill="${T}"/>`));
  L.push(`<circle cx="28.7" cy="102" r="5.3" fill="${S}"/><circle cx="71.3" cy="102" r="5.3" fill="${S}"/>`);

  // torso
  if (dress) L.push(`<path d="M33 98L67 98L75 124L25 124Z" fill="${T}" stroke="${T}" stroke-width="3" stroke-linejoin="round"/>`);
  L.push(bare ? `<rect x="36" y="68" width="28" height="38" rx="10" fill="${T}"/>` : `<rect x="33" y="68" width="34" height="38" rx="11" fill="${T}"/>`);
  if (bare) L.push(`<rect x="36" y="64" width="28" height="9" rx="4" fill="${S}"/>`);
  if (cfg.top === 'hoodie') L.push(`<path d="M37 66Q50 83 63 66" fill="none" stroke="#000" stroke-opacity=".16" stroke-width="5.5" stroke-linecap="round"/><path d="M45 76L44.5 86M55 76L55.5 86" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity=".85"/><rect x="40" y="92" width="20" height="9" rx="4" fill="#000" opacity=".1"/>`);
  if (cfg.top === 'jacket') L.push(`<line x1="50" y1="70" x2="50" y2="106" stroke="#fff" stroke-opacity=".7" stroke-width="1.8"/><path d="M40 68L50 80L60 68" fill="none" stroke="#000" stroke-opacity=".18" stroke-width="3.2" stroke-linejoin="round"/>`);
  if (cfg.top === 'tee') L.push(`<path d="M42 68Q50 76 58 68" fill="none" stroke="#000" stroke-opacity=".16" stroke-width="3" stroke-linecap="round"/>`);
  if (dress) L.push(`<path d="M42 68Q50 76 58 68" fill="none" stroke="#000" stroke-opacity=".16" stroke-width="3" stroke-linecap="round"/>`);

  // neck + head
  L.push(`<rect x="44.5" y="58" width="11" height="12" rx="4" fill="${S}"/>${shadeLayer('M44.5 66Q50 72 55.5 66L55.5 62L44.5 62Z')}`);
  L.push(`<circle cx="26.5" cy="42" r="4.2" fill="${S}"/><circle cx="73.5" cy="42" r="4.2" fill="${S}"/>`);
  L.push(`<ellipse cx="50" cy="40" rx="24" ry="23" fill="${S}"/>`);

  // hair in front
  const fringe = `<path d="M26 40C25 14 75 14 74 40C72 33 68 28 62 27C54 30 44 24 36 28C30 30 27 34 26 40Z" fill="${H}"/>`;
  if (['short', 'long', 'bob', 'bun', 'ponytail'].includes(cfg.hair)) L.push(fringe);
  if (cfg.hair === 'spiky') L.push(`<path d="M25 40L28 17L36 28L42 11L50 26L58 11L64 28L72 17L75 40C70 32 62 28 50 30C38 28 30 32 25 40Z" fill="${H}"/>`);
  if (cfg.hair === 'curly') L.push(`<path d="M30 35C34 22 66 22 70 35C64 30 56 28 50 29C44 28 36 30 30 35Z" fill="${H}"/>`);
  if (cfg.hair === 'buzz') L.push(`<path d="M26 38C26 16 74 16 74 38C70 28 60 25 50 25C40 25 30 28 26 38Z" fill="${H}" opacity=".55"/>`);
  if (cfg.hair === 'long') L.push(`<rect x="23.5" y="34" width="7.5" height="44" rx="3.7" fill="${H}"/><rect x="69" y="34" width="7.5" height="44" rx="3.7" fill="${H}"/>`);
  if (cfg.hair === 'bob') L.push(`<rect x="23.5" y="34" width="7.5" height="28" rx="3.7" fill="${H}"/><rect x="69" y="34" width="7.5" height="28" rx="3.7" fill="${H}"/>`);
  if (cfg.hair === 'ponytail') L.push(`<circle cx="72" cy="31" r="3.2" fill="${A}"/>`);

  // face
  const eyeY = 43;
  const dot = (x) => `<circle cx="${x}" cy="${eyeY}" r="2.7" fill="${ink}"/>`;
  const arc = (x) => `<path d="M${x - 3.6} ${eyeY + 1.2}Q${x} ${eyeY - 4.6} ${x + 3.6} ${eyeY + 1.2}" fill="none" stroke="${ink}" stroke-width="2" stroke-linecap="round"/>`;
  const sparkle = (x) => `<ellipse cx="${x}" cy="${eyeY}" rx="3.3" ry="4.2" fill="${ink}"/><circle cx="${x + 1.1}" cy="${eyeY - 1.5}" r="1.2" fill="#fff"/>`;
  const sleepy = (x) => `<path d="M${x - 3.6} ${eyeY}Q${x} ${eyeY + 3.8} ${x + 3.6} ${eyeY}" fill="none" stroke="${ink}" stroke-width="2" stroke-linecap="round"/>`;
  const eyeFns = { dot: [dot, dot], happy: [arc, arc], sparkle: [sparkle, sparkle], sleepy: [sleepy, sleepy], wink: [dot, arc] };
  const [le, re] = eyeFns[cfg.eyes];
  L.push(le(40) + re(60));
  if (cfg.blush === '1') L.push('<ellipse cx="34.5" cy="50" rx="4" ry="2.6" fill="#ff7a93" opacity=".42"/><ellipse cx="65.5" cy="50" rx="4" ry="2.6" fill="#ff7a93" opacity=".42"/>');
  const mouths = {
    smile: `<path d="M44 51.5Q50 57.5 56 51.5" fill="none" stroke="${ink}" stroke-width="2" stroke-linecap="round"/>`,
    open: `<path d="M44.5 51Q50 51.5 55.5 51Q54.5 58.5 50 58.5Q45.5 58.5 44.5 51Z" fill="${ink}"/><path d="M47 56.2Q50 54.8 53 56.2Q52 58.2 50 58.2Q48 58.2 47 56.2Z" fill="#ff7a93"/>`,
    flat: `<path d="M45.5 53.5L54.5 53.5" stroke="${ink}" stroke-width="2" stroke-linecap="round"/>`,
    cat: `<path d="M43.5 51.5Q46.8 56.5 50 52Q53.2 56.5 56.5 51.5" fill="none" stroke="${ink}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  };
  L.push(mouths[cfg.mouth]);
  if (cfg.glasses === 'round') L.push(`<g fill="#fff" fill-opacity=".18" stroke="${ink}" stroke-width="1.7"><circle cx="40" cy="43" r="7.2"/><circle cx="60" cy="43" r="7.2"/></g><path d="M47.2 42.5Q50 40.8 52.8 42.5" fill="none" stroke="${ink}" stroke-width="1.7"/>`);
  if (cfg.glasses === 'sunglasses') L.push(`<g fill="${ink}"><rect x="31.5" y="38" width="17" height="11" rx="4.5"/><rect x="51.5" y="38" width="17" height="11" rx="4.5"/></g><path d="M48.5 41.5L51.5 41.5" stroke="${ink}" stroke-width="2"/><path d="M35 41.5l4 -1.2" stroke="#fff" stroke-opacity=".5" stroke-width="1.4" stroke-linecap="round"/>`);

  // headwear
  if (cfg.head === 'cap') L.push(`<path d="M25.5 34C25 8 75 8 74.5 34Z" fill="${A}"/><ellipse cx="50" cy="34" rx="27" ry="4.6" fill="${A}"/><ellipse cx="50" cy="35" rx="27" ry="4.2" fill="#000" opacity=".12"/><circle cx="50" cy="12.5" r="2.4" fill="#000" opacity=".2"/>`);
  if (cfg.head === 'beanie') L.push(`<path d="M24.5 36C23 4 77 4 75.5 36Z" fill="${A}"/><rect x="24" y="30" width="52" height="8.5" rx="4.2" fill="#000" opacity=".16"/><rect x="24" y="29" width="52" height="8.5" rx="4.2" fill="${A}"/><circle cx="50" cy="6.5" r="5.5" fill="${A}"/><circle cx="50" cy="6.5" r="5.5" fill="#fff" opacity=".25"/>`);
  if (cfg.head === 'bow') L.push(`<path d="M67 19L54 10L54 28Z M67 19L80 10L80 28Z" fill="${A}" stroke="${A}" stroke-width="2" stroke-linejoin="round"/><circle cx="67" cy="19" r="3.8" fill="${A}"/><circle cx="67" cy="19" r="3.8" fill="#000" opacity=".15"/>`);
  if (cfg.head === 'crown') L.push(`<path d="M30 25L33 6L42 17L50 3L58 17L67 6L70 25Z" fill="${A}" stroke="${A}" stroke-width="2.4" stroke-linejoin="round"/><circle cx="50" cy="9" r="2" fill="#fff" opacity=".7"/>`);
  if (cfg.head === 'headband') L.push(`<path d="M25.5 33C29 13 71 13 74.5 33" fill="none" stroke="${A}" stroke-width="5.5" stroke-linecap="round"/>`);

  const body = L.join('');
  if (mode === 'head') return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="14 4 72 72"><rect x="14" y="4" width="72" height="72" fill="#${cfg.bg}"/>${body}</svg>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 146">${body}</svg>`;
}
const avCache = new Map();
// data: URI for <img src>. Cached because the same seeds get drawn over and over.
const avatarUrl = (seed, mode = 'head') => {
  const key = mode + '|' + seed;
  if (!avCache.has(key)) avCache.set(key, 'data:image/svg+xml;utf8,' + encodeURIComponent(avatarSvg(avDecode(seed), mode)));
  return avCache.get(key);
};
const avatar = (seed, size = 36, title = '') => `<img class="av" width="${size}" height="${size}" src="${avatarUrl(seed)}" alt="" title="${esc(title)}" loading="lazy">`;
const figure = (seed, h = 120, cls = '') => `<img class="fig ${cls}" height="${h}" width="${Math.round(h * 100 / 146)}" src="${avatarUrl(seed, 'full')}" alt="">`;
// Quest tags: a fixed list so the filter stays tidy. Max 5 per quest (the database enforces that too).
const TAGS = [['sports', '⚽', 'Sports'], ['arts', '🎨', 'Arts & crafts'], ['out', '🎉', 'Going out'], ['nature', '🌿', 'Nature'], ['food', '🍜', 'Food'], ['travel', '✈️', 'Travel'], ['games', '🎮', 'Games'], ['music', '🎵', 'Music'], ['learn', '📚', 'Learning'], ['wellness', '🧘', 'Wellness'], ['chill', '🛋️', 'Chill'], ['other', '✨', 'Other']];
const tagInfo = (k) => TAGS.find((t) => t[0] === k);
const tagPills = (tags = []) => tags.map(tagInfo).filter(Boolean).map(([, ic, lb]) => `<span class="pill">${ic} ${lb}</span>`).join('');
const CREW_EMOJI = ['🗺️', '⚔️', '🏕️', '🎒', '🌴', '🎉', '🍜', '🎮', '🎨', '⚽', '🚴', '🏖️', '🎬', '📸', '🎤', '🌈', '🔥', '⭐', '🐙', '🦊', '🐸', '🍕'];
const crewBadge = (g, size = 44) => `<span class="badge" style="background:#${g.color || 'e4dcff'};width:${size}px;height:${size}px;font-size:${Math.round(size * .55)}px">${esc(g.emoji || '🗺️')}</span>`;
const GROUP_COLS = 'id,name,invite_code,emoji,color,description,created_at,created_by';
const memberById = (id) => state.members.find((m) => m.id === id);
const face = (id, size = 28) => { const m = memberById(id); return avatar(m?.avatar_seed || id, size, m?.display_name || ''); };
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const fmtDate = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '';
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}
const fail = (err) => { console.error(err); toast(err?.message || 'Something went wrong'); };

// ---------- bottom sheet ----------
function openSheet(html) {
  closeSheet();
  const d = document.createElement('div');
  d.id = 'sheet';
  d.innerHTML = `<div class="scrim" data-act="close-sheet"></div><div class="panel"><div class="grab"></div>${html}</div>`;
  document.body.appendChild(d);
  document.body.classList.add('noscroll');
}
function closeSheet() {
  document.getElementById('sheet')?.remove();
  document.body.classList.remove('noscroll');
}

// ---------- photos ----------
// Shrink photos before upload so the free storage tier lasts a long time.
async function compress(file, max = 1600, quality = 0.82) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
}
async function signPhotos() {
  const need = state.entries.flatMap((e) => e.photo_paths).filter((p) => !state.photoUrls[p]);
  if (!need.length) return;
  const { data } = await sb.storage.from('photos').createSignedUrls(need, 3600);
  (data || []).forEach((r) => { if (r.signedUrl) state.photoUrls[r.path] = r.signedUrl; });
}

// ---------- boot ----------
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  // invite links look like https://yourapp/?join=ABC123 — remember the code through login
  const join = new URLSearchParams(location.search).get('join');
  if (join) { localStorage.setItem('sq_join', join.toUpperCase()); history.replaceState({}, '', location.pathname); }

  sb.auth.onAuthStateChange((evt) => { if (evt === 'SIGNED_OUT') { state.user = null; showAuth(); } });

  const { data: { session } } = await sb.auth.getSession();
  if (session) await afterLogin(session.user); else showAuth();
}

async function afterLogin(user) {
  state.user = user;
  const { data: p, error } = await sb.from('profiles').select('*').eq('id', user.id).single();
  if (error) return fail(error);
  state.profile = p;

  const pending = localStorage.getItem('sq_join');
  if (pending) {
    localStorage.removeItem('sq_join');
    const { data, error: e2 } = await sb.rpc('join_group', { code: pending });
    if (e2) toast(e2.message); else { toast(`Joined ${data.name}!`); localStorage.setItem('sq_last', data.id); }
  }

  await loadGroups();
  const last = state.groups.find((g) => g.id === localStorage.getItem('sq_last'));
  if (last) await openGroup(last); else showGroups();
}

async function loadGroups() {
  const { data, error } = await sb.from('members').select(`groups(${GROUP_COLS})`).eq('user_id', myId());
  if (error) return fail(error);
  state.groups = (data || []).map((r) => r.groups).filter(Boolean);
}

// ---------- auth screen ----------
function showAuth() {
  closeSheet(); unsubscribe();
  $app.innerHTML = `
    <div class="auth">
      <div class="logo">⚔️</div>
      <h1>SideQuest</h1>
      <p class="tag">Plan things with your friends. Check them off. Keep the memories.</p>
      <form data-form="auth">
        <input type="email" name="email" required placeholder="Email" autocomplete="email" autocapitalize="off">
        <input type="password" name="password" required minlength="6" placeholder="Password (6+ characters)" autocomplete="current-password">
        <button class="btn primary" data-mode="login">Log in</button>
        <button class="btn" data-mode="signup">Create account</button>
      </form>
      <p class="hint">Private to you and your friends. No ads, no public feed.</p>
    </div>`;
}

// ---------- groups screen ----------
function showGroups() {
  unsubscribe(); state.group = null; localStorage.removeItem('sq_last');
  const list = state.groups.map((g) => `
    <button class="card" data-act="open-group" data-id="${g.id}">
      <div class="crew-row">${crewBadge(g, 46)}<div><div class="qt" style="font-weight:800;font-size:18px">${esc(g.name)}</div>
      <div class="meta">${esc(g.description || 'Tap to open')}</div></div></div>
    </button>`).join('');
  $app.innerHTML = `
    <header class="top">
      <div class="grow"><h1>Hey, ${esc(state.profile.display_name)} 👋</h1></div>
      <button class="icon-btn" data-act="profile" aria-label="Your profile">${avatar(state.profile.avatar_seed, 36)}</button>
    </header>
    <main>
      <section class="hero">
        <div class="stage" style="background:#${avDecode(state.profile.avatar_seed).bg}">${figure(state.profile.avatar_seed, 150)}</div>
        <div class="hero-txt">
          <div class="hi">Your character</div>
          <p>Dress up your little adventurer. Your crew sees you like this.</p>
          <button class="btn primary" data-act="profile" style="margin:8px 0 0">👕 Dress up</button>
        </div>
      </section>
      ${state.groups.length ? `<div class="section-title">Your crews</div>${list}` : `
        <div class="empty"><div class="big">🧭</div><p>No crew yet. Start one, or join with an invite code from a friend.</p></div>`}
      <div class="section-title">Start a new crew</div>
      <form data-form="createGroup" class="row">
        <input type="text" name="name" required maxlength="60" placeholder="e.g. College barkada" style="margin:0">
        <button class="btn primary" style="margin:0;flex:none;width:auto">Create</button>
      </form>
      <div class="section-title">Join with a code</div>
      <form data-form="joinGroup" class="row">
        <input type="text" name="code" required maxlength="20" placeholder="Invite code" autocapitalize="characters" style="margin:0">
        <button class="btn" style="margin:0;flex:none;width:auto">Join</button>
      </form>
    </main>`;
}

async function openGroup(g) {
  state.group = g; state.tab = 'quests';
  localStorage.setItem('sq_last', g.id);
  await loadGroupData();
  subscribe();
  render();
  window.scrollTo(0, 0);
}

async function loadGroupData() {
  const gid = state.group.id;
  const [m, q, e] = await Promise.all([
    sb.from('members').select('role, profiles(id,display_name,avatar_seed)').eq('group_id', gid),
    sb.from('quests').select('*, quest_participants(user_id)').eq('group_id', gid).order('created_at', { ascending: false }),
    sb.from('entries').select('*').eq('group_id', gid).order('done_on', { ascending: false }).order('created_at', { ascending: false }),
  ]);
  const err = m.error || q.error || e.error;
  if (err) return fail(err);
  state.members = m.data.filter((r) => r.profiles).map((r) => ({ ...r.profiles, role: r.role }));
  state.quests = q.data;
  state.entries = e.data;
  await signPhotos();
}

// ---------- realtime ----------
const refresh = debounce(async () => {
  if (!state.group) return;
  const y = window.scrollY;
  await loadGroupData(); render(); window.scrollTo(0, y);
}, 400);

function subscribe() {
  unsubscribe();
  const gid = state.group.id;
  state.chan = sb.channel('group-' + gid)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'quests', filter: `group_id=eq.${gid}` }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'entries', filter: `group_id=eq.${gid}` }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'quest_participants' }, refresh)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'groups', filter: `id=eq.${gid}` }, async () => {
      const { data } = await sb.from('groups').select(GROUP_COLS).eq('id', gid).single();
      if (data && state.group?.id === gid) { Object.assign(state.group, data); render(); }
    })
    .subscribe();
}
function unsubscribe() { if (state.chan) { sb.removeChannel(state.chan); state.chan = null; } }

// ---------- group screen ----------
function render() {
  if (!state.group) return;
  const g = state.group;
  const tabs = [['quests', '🗺️', 'Quests'], ['calendar', '📅', 'Calendar'], ['diary', '📖', 'Diary'], ['crew', '👥', 'Crew']];
  $app.innerHTML = `
    <header class="top">
      <button class="icon-btn" data-act="back" aria-label="All crews">‹</button>
      ${crewBadge(g, 34)}
      <div class="grow">
        <h1>${esc(g.name)}</h1>
        <button class="code-btn" data-act="share">Invite · ${esc(g.invite_code)}</button>
      </div>
      <button class="icon-btn" data-act="profile" aria-label="Your profile">${avatar(state.profile.avatar_seed, 36)}</button>
    </header>
    <main>${state.tab === 'quests' ? viewQuests() : state.tab === 'calendar' ? viewCalendar() : state.tab === 'diary' ? viewDiary() : viewCrew()}</main>
    ${state.tab === 'quests' || state.tab === 'calendar' ? `<button class="fab" data-act="new-quest">＋ New quest</button>` : ''}
    <nav class="tabs">${tabs.map(([k, ic, lb]) => `<button class="${state.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}"><span>${ic}</span>${lb}</button>`).join('')}</nav>`;
}

const questCard = (q) => `
  <button class="card quest ${q.status}" data-act="open-quest" data-id="${q.id}">
    <div class="qt">${esc(q.title)}</div>
    ${q.tags?.length ? `<div class="pills">${tagPills(q.tags)}</div>` : ''}
    <div class="meta">${q.due_date ? '📅 ' + fmtDate(q.due_date) : ''}${q.location ? ` &nbsp;📍 ${esc(q.location)}` : ''}</div>
    ${q.quest_participants.length ? `<div class="faces">${q.quest_participants.map((p) => face(p.user_id, 26)).join('')}</div>` : ''}
  </button>`;

// The "group shot": every member standing together. Tap it to open the Crew tab.
function crewScene() {
  const row = state.members.map((m, i) => `<div class="mate" style="--i:${i}">${figure(m.avatar_seed, 128)}<span>${esc((m.display_name || '').split(' ')[0])}${m.id === myId() ? ' ★' : ''}</span></div>`).join('');
  return `<div class="scene" data-act="tab" data-tab="crew" role="button" aria-label="The crew"><div class="scene-row">${row}</div></div>`;
}

// Row of tag chips above the list. Only tags that are actually in use show up.
function filterBar() {
  const counts = {};
  state.quests.forEach((q) => (q.tags || []).forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
  const used = TAGS.filter(([k]) => counts[k]);
  if (!used.length) return '';
  if (state.filter && !counts[state.filter]) state.filter = null;
  return `<div class="filters">
    <button class="${!state.filter ? 'on' : ''}" data-act="filter" data-tag="">All</button>
    ${used.map(([k, ic, lb]) => `<button class="${state.filter === k ? 'on' : ''}" data-act="filter" data-tag="${k}">${ic} ${lb} <i>${counts[k]}</i></button>`).join('')}
  </div>`;
}

function viewQuests() {
  const all = state.quests;
  const filtered = state.filter ? all.filter((q) => (q.tags || []).includes(state.filter)) : all;
  const open = filtered.filter((q) => q.status === 'open');
  const dated = open.filter((q) => q.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const someday = open.filter((q) => !q.due_date);
  const done = filtered.filter((q) => q.status === 'done');
  const scene = state.members.length ? crewScene() : '';
  if (!state.quests.length) return scene + `<div class="empty"><div class="big">🗺️</div><p>No quests yet.<br>Add the first thing you've all been saying "we should do someday".</p></div>`;
  return `
    ${scene}
    ${filterBar()}
    ${!filtered.length ? `<div class="empty" style="padding:24px"><p>No quests with that tag yet.</p></div>` : ''}
    ${someday.length ? `<div class="nudge"><p><b>${someday.length}</b> quest${someday.length > 1 ? 's have' : ' has'} no date yet.</p><button data-act="spin">🎲 Pick one</button></div>` : ''}
    ${dated.length ? `<div class="section-title">Coming up</div>${dated.map(questCard).join('')}` : ''}
    ${someday.length ? `<div class="section-title">Someday</div>${someday.map(questCard).join('')}` : ''}
    ${done.length ? `<div class="section-title">Done ✓</div>${done.map(questCard).join('')}` : ''}`;
}

function viewDiary() {
  if (!state.entries.length) return `<div class="empty"><div class="big">📖</div><p>Your diary is empty.<br>Finish a quest and it lands here.</p></div>`;
  return state.entries.map((e) => {
    const q = state.quests.find((x) => x.id === e.quest_id);
    const who = q ? q.quest_participants.map((p) => face(p.user_id, 26)).join('') : '';
    return `
      <article class="card entry">
        <div class="head">${face(e.author_id, 34)}<div><h3>${esc(q?.title || 'Quest')}</h3><div class="meta">${fmtDate(e.done_on)}${q?.location ? ` · 📍 ${esc(q.location)}` : ''}</div></div></div>
        ${e.note ? `<p class="note">${esc(e.note)}</p>` : ''}
        ${photoGrid(e)}
        ${who ? `<div class="faces">${who}</div>` : ''}
      </article>`;
  }).join('');
}

function photoGrid(e) {
  const imgs = e.photo_paths.map((p) => state.photoUrls[p]).filter(Boolean);
  return imgs.length ? `<div class="photos">${imgs.map((u) => `<a href="${u}" target="_blank" rel="noopener"><img src="${u}" alt="" loading="lazy"></a>`).join('')}</div>` : '';
}

function viewCrew() {
  const doneBy = (id) => state.quests.filter((q) => q.status === 'done' && q.quest_participants.some((p) => p.user_id === id)).length;
  const rows = state.members.map((m) => `
    <div class="card person">
      ${figure(m.avatar_seed, 76)}
      <div><div class="nm">${esc(m.display_name)}${m.id === myId() ? ' (you)' : ''}</div><div class="sub">${doneBy(m.id)} quest${doneBy(m.id) === 1 ? '' : 's'} done${m.role === 'admin' ? ' · founder' : ''}</div></div>
    </div>`).join('');
  const g = state.group;
  const isFounder = state.members.find((m) => m.id === myId())?.role === 'admin';
  const totalDone = state.quests.filter((q) => q.status === 'done').length;
  const card = `
    <div class="card crew-card">
      <div class="crew-top">${crewBadge(g, 64)}<div class="grow"><h2>${esc(g.name)}</h2><div class="meta">Since ${g.created_at ? new Date(g.created_at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : '—'}</div></div></div>
      ${g.description ? `<p class="crew-desc">${esc(g.description)}</p>` : `<p class="crew-desc muted">No description yet. Add your crew's story, motto, or inside joke.</p>`}
      <div class="crew-stats"><div><b>${state.members.length}</b><span>members</span></div><div><b>${state.quests.length}</b><span>quests</span></div><div><b>${totalDone}</b><span>done</span></div></div>
      <button class="btn" data-act="edit-crew" style="margin-top:12px">✏️ Edit crew details</button>
    </div>`;
  return `
    ${card}
    <div class="section-title">The crew · ${state.members.length}</div>${rows}
    <button class="btn primary" data-act="share" style="margin-top:14px">Invite a friend</button>
    ${isFounder ? `<button class="btn ghost" data-act="reset-invite" style="margin-top:6px">🔄 Make a new invite code</button>` : ''}
    <button class="btn danger" data-act="leave" style="margin-top:12px">Leave this crew</button>`;
}

// ---------- calendar ----------
// No new database stuff: it just lays out each quest's due_date (or, once done, the day it was done).
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// The date a quest shows on: finished quests use the day they happened, open ones their due date.
function questDay(q) {
  if (q.status === 'done') return state.entries.find((e) => e.quest_id === q.id)?.done_on || q.due_date || null;
  return q.due_date || null;
}
function questsOn(date) { return state.quests.filter((q) => questDay(q) === date); }

function shiftMonth(delta) {
  const c = state.cal || { y: new Date().getFullYear(), m: new Date().getMonth() };
  const d = new Date(c.y, c.m + delta, 1);
  state.cal = { y: d.getFullYear(), m: d.getMonth() };
  render();
}

function viewCalendar() {
  const now = new Date();
  const { y, m } = state.cal || { y: now.getFullYear(), m: now.getMonth() };
  const lead = new Date(y, m, 1).getDay();          // blank cells before the 1st (Sunday-first)
  const total = new Date(y, m + 1, 0).getDate();
  const t = today();
  let cells = '';
  for (let i = 0; i < lead; i++) cells += '<div class="cal-cell blank"></div>';
  for (let d = 1; d <= total; d++) {
    const key = dayKey(y, m, d);
    const qs = questsOn(key);
    const dots = qs.slice(0, 3).map((q) => `<i class="${q.status}"></i>`).join('') + (qs.length > 3 ? '<b>+</b>' : '');
    cells += `<button class="cal-cell ${key === t ? 'today' : ''} ${qs.length ? 'has' : ''}" data-act="cal-day" data-date="${key}"><span>${d}</span><div class="dots">${dots}</div></button>`;
  }
  const monthPrefix = `${y}-${pad(m + 1)}-`;
  const inMonth = state.quests.filter((q) => (questDay(q) || '').startsWith(monthPrefix)).sort((a, b) => questDay(a).localeCompare(questDay(b)));
  return `
    <div class="cal-head">
      <button class="icon-btn" data-act="cal-prev" aria-label="Previous month">‹</button>
      <div class="cal-title"><b>${MONTHS[m]}</b> ${y}</div>
      <button class="icon-btn" data-act="cal-next" aria-label="Next month">›</button>
    </div>
    <div class="cal-grid">
      ${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<div class="cal-dow">${d}</div>`).join('')}
      ${cells}
    </div>
    <div class="cal-legend"><i class="open"></i> planned <i class="done"></i> done <button class="linkish" data-act="cal-today">Today</button></div>
    <div class="section-title">${MONTHS[m]} plans</div>
    ${inMonth.length ? inMonth.map(questCard).join('') : `<div class="empty" style="padding:18px"><p>Nothing planned this month.<br>Tap a day to add a quest.</p></div>`}`;
}

function daySheet(date) {
  const qs = questsOn(date);
  openSheet(`
    <h2>${fmtDate(date)}</h2>
    ${qs.length ? qs.map(questCard).join('') : '<p class="meta" style="margin-bottom:12px">Nothing planned yet.</p>'}
    <button class="btn primary" data-act="new-quest-on" data-date="${date}">＋ New quest on this day</button>`);
}

// Export a quest to the phone's calendar app as a standard .ics file (all-day event).
function downloadIcs(q) {
  if (!q?.due_date) return toast('Give the quest a date first');
  const compact = (d) => d.replaceAll('-', '');
  const next = new Date(q.due_date + 'T00:00:00'); next.setDate(next.getDate() + 1);
  const end = `${next.getFullYear()}${pad(next.getMonth() + 1)}${pad(next.getDate())}`;
  const txt = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SideQuest//EN', 'BEGIN:VEVENT',
    `UID:${q.id}@sidequest`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    `DTSTART;VALUE=DATE:${compact(q.due_date)}`, `DTEND;VALUE=DATE:${end}`,
    `SUMMARY:${txt('SideQuest: ' + q.title)}`, q.location ? `LOCATION:${txt(q.location)}` : '', q.details ? `DESCRIPTION:${txt(q.details)}` : '',
    'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'sidequest.ics' });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- sheets: quests ----------
const whoIn = (selected = []) => `<div class="who">${state.members.map((m) => `
  <label class="chip"><input type="checkbox" name="who" value="${m.id}" ${selected.includes(m.id) ? 'checked' : ''}>${avatar(m.avatar_seed, 26)}<span>${esc(m.display_name)}</span></label>`).join('')}</div>`;
const tagPicker = (selected = []) => `<label class="lbl">Tags (optional, up to 5)</label><div class="who tags">${TAGS.map(([k, ic, lb]) => `
  <label class="chip tagchip"><input type="checkbox" name="tag" value="${k}" ${selected.includes(k) ? 'checked' : ''}><span>${ic} ${lb}</span></label>`).join('')}</div>`;
const checkedTags = (f) => {
  const t = [...f.querySelectorAll('input[name=tag]:checked')].map((i) => i.value);
  if (t.length > 5) throw new Error('Pick up to 5 tags');
  return t;
};
const checkedWho = (f) => [...f.querySelectorAll('input[name=who]:checked')].map((i) => i.value);

function newQuestSheet(date = '') {
  openSheet(`
    <h2>New quest</h2>
    <form data-form="newQuest">
      <input type="text" name="title" required maxlength="120" placeholder="What are we doing? e.g. Sunrise hike">
      <textarea name="details" maxlength="2000" placeholder="Details (optional)"></textarea>
      <input type="text" name="location" maxlength="120" placeholder="Where? (optional)">
      <label class="lbl">When? (leave empty for someday)</label>
      <input type="date" name="due_date" value="${esc(date)}">
      ${tagPicker([])}
      <label class="lbl">Who's in?</label>
      ${whoIn([myId()])}
      <button class="btn primary">Add quest</button>
    </form>`);
}

function questSheet(q) {
  const ids = q.quest_participants.map((p) => p.user_id);
  if (q.status === 'done') return doneSheet(q);
  openSheet(`
    <h2>${esc(q.title)}</h2>
    <form data-form="editQuest" data-id="${q.id}">
      <input type="text" name="title" required maxlength="120" value="${esc(q.title)}">
      <textarea name="details" maxlength="2000" placeholder="Details">${esc(q.details || '')}</textarea>
      <input type="text" name="location" maxlength="120" placeholder="Where?" value="${esc(q.location || '')}">
      <label class="lbl">When?</label>
      <input type="date" name="due_date" value="${q.due_date || ''}">
      ${tagPicker(q.tags || [])}
      <label class="lbl">Who's in?</label>
      ${whoIn(ids)}
      <button class="btn">Save changes</button>
    </form>
    <button class="btn primary" data-act="complete" data-id="${q.id}">✅ We did it!</button>
    ${q.due_date ? `<button class="btn" data-act="ics" data-id="${q.id}">📅 Add to my phone calendar</button>` : ''}
    ${q.created_by === myId() ? `<button class="btn danger" data-act="delete-quest" data-id="${q.id}">Delete quest</button>` : ''}`);
}

function completeSheet(q) {
  const ids = q.quest_participants.map((p) => p.user_id);
  openSheet(`
    <h2>Add to the diary 📖</h2>
    <p class="meta" style="margin-bottom:12px">${esc(q.title)}</p>
    <form data-form="complete" data-id="${q.id}">
      <label class="lbl">What happened?</label>
      <textarea name="note" maxlength="4000" placeholder="The funny bits, the food, the plot twists…"></textarea>
      <label class="lbl">Photos (up to 6)</label>
      <input type="file" name="photos" accept="image/*" multiple style="margin-bottom:10px">
      <label class="lbl">When was it?</label>
      <input type="date" name="done_on" required value="${(q.due_date && q.due_date <= today()) ? q.due_date : today()}">
      <label class="lbl">Who was there?</label>
      ${whoIn(ids.length ? ids : [myId()])}
      <button class="btn primary">Save to diary</button>
    </form>`);
}

function doneSheet(q) {
  const e = state.entries.find((x) => x.quest_id === q.id);
  openSheet(`
    <h2>${esc(q.title)}</h2>
    <div class="meta">${e ? fmtDate(e.done_on) : ''}${q.location ? ` · 📍 ${esc(q.location)}` : ''}</div>
    ${q.quest_participants.length ? `<div class="faces" style="margin:12px 0">${q.quest_participants.map((p) => face(p.user_id, 30)).join('')}</div>` : ''}
    ${e?.note ? `<p class="note" style="white-space:pre-wrap;margin:10px 0">${esc(e.note)}</p>` : ''}
    ${e ? photoGrid(e) : ''}
    ${q.created_by === myId() ? `<button class="btn danger" data-act="delete-quest" data-id="${q.id}">Delete quest & diary entry</button>` : ''}`);
}

// ---------- sheet: edit crew ----------
function editCrewSheet() {
  const g = state.group;
  openSheet(`
    <h2>Crew details</h2>
    <form data-form="editCrew">
      <input type="hidden" name="emoji" value="${esc(g.emoji || '🗺️')}">
      <input type="hidden" name="color" value="${esc(g.color || 'e4dcff')}">
      <label class="lbl">Crew name</label>
      <input type="text" name="name" required maxlength="60" value="${esc(g.name)}">
      <label class="lbl">Icon</label>
      <div class="opts" id="crew-emoji">${CREW_EMOJI.map((e) => `<button type="button" class="opt emoji ${e === (g.emoji || '🗺️') ? 'on' : ''}" data-act="crew-emoji" data-val="${e}">${e}</button>`).join('')}</div>
      <label class="lbl">Color</label>
      <div class="opts color" id="crew-color">${BGS.map((c) => `<button type="button" class="sw ${c === (g.color || 'e4dcff') ? 'on' : ''}" style="background:#${c}" data-act="crew-color" data-val="${c}" aria-label="${c}"></button>`).join('')}</div>
      <label class="lbl">About this crew</label>
      <textarea name="description" maxlength="300" placeholder="Who are you, what's your motto, what's the inside joke?">${esc(g.description || '')}</textarea>
      <button class="btn primary">Save</button>
    </form>`);
}

// ---------- sheet: profile ----------
let avDraft = null;  // avatar being edited (config object) while the profile sheet is open
let avTab = 0;       // which editor tab is showing

// The editor body (tabs + options). Re-rendered on every pick so the highlight and preview stay in sync.
function avEditorHtml() {
  const [, rows] = AV_TABS[avTab];
  const body = rows.map(([key, label, kind]) => {
    const vals = kind === 'color' ? AV_COLORS[key] : AV_OPTS[key];
    const btns = vals.map((v) => kind === 'color'
      ? `<button type="button" class="sw ${avDraft[key] === v ? 'on' : ''}" style="background:#${v}" data-act="av-opt" data-key="${key}" data-val="${v}" aria-label="${v}"></button>`
      : `<button type="button" class="opt ${avDraft[key] === v ? 'on' : ''}" data-act="av-opt" data-key="${key}" data-val="${v}">${avLabel(v)}</button>`).join('');
    return `<label class="lbl">${label}</label><div class="opts ${kind}">${btns}</div>`;
  }).join('');
  return `
    <div class="avtabs">${AV_TABS.map(([name], i) => `<button type="button" class="${i === avTab ? 'on' : ''}" data-act="av-tab" data-i="${i}">${name}</button>`).join('')}</div>
    ${body}`;
}
function avRefresh() {
  const seed = avEncode(avDraft);
  document.querySelector('input[name=avatar_seed]').value = seed;
  document.getElementById('av-prev').src = avatarUrl(seed, 'full');
  document.getElementById('av-stage').style.background = '#' + avDraft.bg;
  document.getElementById('av-editor').innerHTML = avEditorHtml();
}

function profileSheet() {
  const seed = state.profile.avatar_seed;
  // Old random avatars start the editor from defaults; the user's picks become theirs on save.
  avDraft = avDecode(seed);   // old seeds become their stable random character
  avTab = 0;
  openSheet(`
    <h2>Your profile</h2>
    <form data-form="profile">
      <div class="av-hero">
        <div id="av-stage" class="stage big" style="background:#${avDraft.bg}"><img id="av-prev" class="fig" height="190" width="130" src="${avatarUrl(avEncode(avDraft), 'full')}" alt="Your character"></div>
        <button type="button" class="btn" data-act="shuffle" style="width:auto;margin:0">🎲 Surprise me</button>
      </div>
      <input type="hidden" name="avatar_seed" value="${esc(avEncode(avDraft))}">
      <div id="av-editor" class="av-editor">${avEditorHtml()}</div>
      <label class="lbl" style="margin-top:14px">Display name</label>
      <input type="text" name="display_name" required maxlength="40" value="${esc(state.profile.display_name)}">
      <button class="btn primary">Save</button>
    </form>
    <button class="btn danger" data-act="logout" style="margin-top:14px">Log out</button>`);
}

// ---------- click + submit routing ----------
const acts = {
  'close-sheet': () => closeSheet(),
  'back': () => { showGroups(); },
  'tab': (t) => { state.tab = t.dataset.tab; render(); window.scrollTo(0, 0); },
  'open-group': async (t) => { await openGroup(state.groups.find((g) => g.id === t.dataset.id)); },
  'new-quest': () => newQuestSheet(),
  'open-quest': (t) => questSheet(state.quests.find((q) => q.id === t.dataset.id)),
  'complete': (t) => completeSheet(state.quests.find((q) => q.id === t.dataset.id)),
  'spin': () => {
    const pool = state.quests.filter((q) => q.status === 'open' && !q.due_date);
    if (pool.length) questSheet(pool[Math.floor(Math.random() * pool.length)]);
  },
  'share': async () => {
    const url = `${location.origin}/?join=${state.group.invite_code}`;
    const text = `Join our crew "${state.group.name}" on SideQuest 🗺️`;
    try {
      if (navigator.share) await navigator.share({ title: 'SideQuest', text, url });
      else { await navigator.clipboard.writeText(`${text}\n${url}`); toast('Invite link copied'); }
    } catch { /* user cancelled share */ }
  },
  'profile': () => profileSheet(),
  'shuffle': () => { avDraft = avRandom(); avRefresh(); },
  'av-tab': (t) => { avTab = Number(t.dataset.i); avRefresh(); },
  'av-opt': (t) => { avDraft[t.dataset.key] = t.dataset.val; avRefresh(); },

  'filter': (t) => { state.filter = t.dataset.tag || null; render(); },
  'edit-crew': () => editCrewSheet(),
  'crew-emoji': (t) => {
    document.querySelector('input[name=emoji]').value = t.dataset.val;
    document.querySelectorAll('#crew-emoji .opt').forEach((b) => b.classList.toggle('on', b === t));
  },
  'crew-color': (t) => {
    document.querySelector('input[name=color]').value = t.dataset.val;
    document.querySelectorAll('#crew-color .sw').forEach((b) => b.classList.toggle('on', b === t));
  },
  'reset-invite': async () => {
    if (!confirm('Make a new invite code? The old code and old invite links will stop working.')) return;
    const { data, error } = await sb.rpc('reset_invite_code', { gid: state.group.id });
    if (error) return fail(error);
    Object.assign(state.group, data); render(); toast('New invite code ready');
  },

  // calendar
  'cal-prev': () => { shiftMonth(-1); },
  'cal-next': () => { shiftMonth(1); },
  'cal-today': () => { state.cal = null; render(); },
  'cal-day': (t) => daySheet(t.dataset.date),
  'new-quest-on': (t) => newQuestSheet(t.dataset.date),
  'ics': (t) => downloadIcs(state.quests.find((q) => q.id === t.dataset.id)),
  'logout': async () => { await sb.auth.signOut(); },
  'leave': async () => {
    if (!confirm(`Leave "${state.group.name}"? You'll need a new invite to come back.`)) return;
    const { error } = await sb.from('members').delete().match({ group_id: state.group.id, user_id: myId() });
    if (error) return fail(error);
    await loadGroups(); showGroups();
  },
  'delete-quest': async (t) => {
    if (!confirm('Delete this quest for everyone? This also removes its diary entry and photos.')) return;
    const q = state.quests.find((x) => x.id === t.dataset.id);
    const paths = state.entries.filter((e) => e.quest_id === q.id).flatMap((e) => e.photo_paths);
    const { error } = await sb.from('quests').delete().eq('id', q.id);
    if (error) return fail(error);
    if (paths.length) await sb.storage.from('photos').remove(paths);
    closeSheet(); await loadGroupData(); render(); toast('Quest deleted');
  },
};

// Wraps a form submit: disables buttons, catches errors, re-enables.
async function run(f, fn) {
  const btns = [...f.querySelectorAll('button')];
  btns.forEach((b) => { b.disabled = true; });
  try { await fn(); } catch (err) { fail(err); } finally { btns.forEach((b) => { b.disabled = false; }); }
}

async function setParticipants(questId, ids) {
  const del = await sb.from('quest_participants').delete().eq('quest_id', questId);
  if (del.error) throw del.error;
  if (ids.length) {
    const ins = await sb.from('quest_participants').insert(ids.map((user_id) => ({ quest_id: questId, user_id })));
    if (ins.error) throw ins.error;
  }
}
async function reloadGroup() { await loadGroupData(); render(); }

const forms = {
  auth: (f, e) => run(f, async () => {
    const fd = new FormData(f);
    const email = fd.get('email').trim(), password = fd.get('password');
    if (e.submitter?.dataset.mode === 'signup') {
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) throw error;
      if (data.session) await afterLogin(data.session.user);
      else toast('Check your email to confirm, then log in.');
    } else {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await afterLogin(data.user);
    }
  }),

  createGroup: (f) => run(f, async () => {
    const { data, error } = await sb.rpc('create_group', { group_name: new FormData(f).get('name') });
    if (error) throw error;
    await loadGroups(); await openGroup(data);
  }),

  joinGroup: (f) => run(f, async () => {
    const { data, error } = await sb.rpc('join_group', { code: new FormData(f).get('code') });
    if (error) throw error;
    toast(`Joined ${data.name}!`);
    await loadGroups(); await openGroup(state.groups.find((g) => g.id === data.id));
  }),

  newQuest: (f) => run(f, async () => {
    const fd = new FormData(f);
    const { data: q, error } = await sb.from('quests').insert({
      group_id: state.group.id,
      title: fd.get('title').trim(),
      details: fd.get('details').trim() || null,
      location: fd.get('location').trim() || null,
      due_date: fd.get('due_date') || null,
      tags: checkedTags(f),
      created_by: myId(),
    }).select().single();
    if (error) throw error;
    await setParticipants(q.id, checkedWho(f));
    closeSheet(); await reloadGroup(); toast('Quest added 🗺️');
  }),

  editQuest: (f) => run(f, async () => {
    const fd = new FormData(f), id = f.dataset.id;
    const { error } = await sb.from('quests').update({
      title: fd.get('title').trim(),
      details: fd.get('details').trim() || null,
      location: fd.get('location').trim() || null,
      due_date: fd.get('due_date') || null,
      tags: checkedTags(f),
    }).eq('id', id);
    if (error) throw error;
    await setParticipants(id, checkedWho(f));
    closeSheet(); await reloadGroup(); toast('Saved');
  }),

  complete: (f) => run(f, async () => {
    const fd = new FormData(f), qid = f.dataset.id, gid = state.group.id;
    const files = [...f.querySelector('input[type=file]').files].slice(0, 6);
    const paths = [];
    for (const file of files) {
      const blob = await compress(file);
      const path = `${gid}/${qid}/${crypto.randomUUID()}.jpg`;
      const { error } = await sb.storage.from('photos').upload(path, blob, { contentType: 'image/jpeg' });
      if (error) throw error;
      paths.push(path);
    }
    const ins = await sb.from('entries').insert({
      quest_id: qid, group_id: gid, author_id: myId(),
      note: fd.get('note').trim() || null, photo_paths: paths, done_on: fd.get('done_on'),
    });
    if (ins.error) throw ins.error;
    const upd = await sb.from('quests').update({ status: 'done', done_at: new Date().toISOString() }).eq('id', qid);
    if (upd.error) throw upd.error;
    await setParticipants(qid, checkedWho(f));
    closeSheet(); state.tab = 'diary'; await reloadGroup(); toast('Saved to the diary 📖');
  }),

  editCrew: (f) => run(f, async () => {
    const fd = new FormData(f);
    const { data, error } = await sb.rpc('update_group', {
      gid: state.group.id, new_name: fd.get('name').trim(), new_emoji: fd.get('emoji'), new_color: fd.get('color'), new_description: fd.get('description'),
    });
    if (error) throw error;
    Object.assign(state.group, data);   // state.group is the same object as in state.groups, so both update
    closeSheet(); render(); toast('Crew updated');
  }),

  profile: (f) => run(f, async () => {
    const fd = new FormData(f);
    const patch = { display_name: fd.get('display_name').trim(), avatar_seed: fd.get('avatar_seed') };
    const { error } = await sb.from('profiles').update(patch).eq('id', myId());
    if (error) throw error;
    Object.assign(state.profile, patch);
    closeSheet();
    if (state.group) await reloadGroup(); else showGroups();
    toast('Profile updated');
  }),
};

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (t && acts[t.dataset.act]) { e.preventDefault(); Promise.resolve(acts[t.dataset.act](t, e)).catch(fail); }
});
document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-form]');
  if (f && forms[f.dataset.form]) { e.preventDefault(); forms[f.dataset.form](f, e); }
});

boot().catch(fail);
