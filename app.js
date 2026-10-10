// SideQuest — vanilla JS PWA. One file on purpose: easy to read, easy to tweak.
// Flow: login -> pick/create/join a group -> Quests / Diary / Crew tabs.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, VAPID_PUBLIC_KEY } from './config.js';

// A password-reset email link opens the app with #...type=recovery. Remember that before supabase-js clears the URL.
const RECOVERY = /type=recovery/.test(location.hash + location.search);
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $app = document.getElementById('app');

// Everything the UI shows lives here. Render functions read it, nothing else.
const state = {
  user: null, profile: null,
  groups: [], group: null, tab: 'quests',
  members: [], quests: [], entries: [],
  filter: null,    // tag key the Quests tab is filtered to (null = all)
  comments: [], reactions: [],   // diary comments + emoji reactions for this crew
  cal: null,       // calendar month being viewed {y, m}; null = this month
  xp: {},          // user id -> XP (from the get_xp database function)
  archived: [],    // quests tucked away (hidden from lists + calendar)
  diaryMode: 'feed', bookYear: null,   // diary: 'feed' or 'book' (memory book)
  editingComment: null,                // id of the comment being edited
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
  head: ['none', 'cap', 'beanie', 'bow', 'headband', 'catears', 'halo', 'flower', 'crown'],
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
const avLabel = (v) => v === '1' ? 'On' : v === '0' ? 'Off' : v === 'none' ? 'None' : v === 'catears' ? 'Cat ears' : v.charAt(0).toUpperCase() + v.slice(1);

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

  if (cfg.head === 'catears') L.push(`<path d="M27 27L29 5L45 18Z M73 27L71 5L55 18Z" fill="${A}" stroke="${A}" stroke-width="2.4" stroke-linejoin="round"/><path d="M32 20L33 11L40 17Z M68 20L67 11L60 17Z" fill="#ff9bb3"/>`);
  if (cfg.head === 'halo') L.push(`<ellipse cx="50" cy="8" rx="15" ry="4.2" fill="none" stroke="${A}" stroke-width="3.4"/><ellipse cx="50" cy="8" rx="15" ry="4.2" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1"/>`);
  if (cfg.head === 'flower') L.push([[31, 24], [40, 16], [50, 13], [60, 16], [69, 24]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="4.6" fill="${A}"/><circle cx="${x}" cy="${y}" r="1.7" fill="#fff7c2"/>`).join(''));

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

  sb.auth.onAuthStateChange((evt) => {
    if (evt === 'SIGNED_OUT') { state.user = null; showAuth(); }
    if (evt === 'PASSWORD_RECOVERY') showReset();
  });

  const { data: { session } } = await sb.auth.getSession();
  if (session && RECOVERY) showReset();
  else if (session) await afterLogin(session.user);
  else { showAuth(); if (RECOVERY) toast('That reset link expired. Ask for a new one.'); }
}

async function afterLogin(user) {
  state.user = user;
  const { data: p, error } = await sb.from('profiles').select('*').eq('id', user.id).single();
  if (error) return fail(error);
  state.profile = p;
  await loadXp([user.id]);

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
        <button type="button" class="btn ghost" data-act="forgot">Forgot password?</button>
      </form>
      <p class="hint">Private to you and your friends. No ads, no public feed.</p>
    </div>`;
}

// Screen shown after tapping the link in a password-reset email.
function showReset() {
  closeSheet(); unsubscribe();
  $app.innerHTML = `
    <div class="auth">
      <div class="logo">🔑</div>
      <h1>New password</h1>
      <p class="tag">Pick something you'll remember. 6+ characters.</p>
      <form data-form="newPassword">
        <input type="password" name="pw1" required minlength="6" placeholder="New password" autocomplete="new-password">
        <input type="password" name="pw2" required minlength="6" placeholder="Type it again" autocomplete="new-password">
        <button class="btn primary">Save password</button>
      </form>
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
          <div class="herolv">Lv ${levelOf(myXp())} · ${esc(levelName(levelOf(myXp())))}</div>
          ${xpBar(myXp())}
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
  state.quests = q.data.filter((x) => !x.archived);
  state.archived = q.data.filter((x) => x.archived);
  state.entries = e.data;
  // comments + reactions for those diary entries
  const ids = e.data.map((x) => x.id);
  state.comments = []; state.reactions = [];
  if (ids.length) {
    const [c, r] = await Promise.all([
      sb.from('entry_comments').select('*').in('entry_id', ids).order('created_at', { ascending: true }),
      sb.from('entry_reactions').select('*').in('entry_id', ids),
    ]);
    if (c.error || r.error) return fail(c.error || r.error);
    state.comments = c.data; state.reactions = r.data;
  }
  await loadXp(state.members.map((m) => m.id));
  await signPhotos();
}

// ---------- realtime ----------
const refresh = debounce(async () => {
  if (!state.group) return;
  const y = window.scrollY;
  await loadGroupData(); render(); window.scrollTo(0, y);
  const open = document.getElementById('sheet')?.dataset.entry;
  if (open && state.entries.some((x) => x.id === open)) entrySheet(open);   // keep an open comments sheet live
}, 400);

function subscribe() {
  unsubscribe();
  const gid = state.group.id;
  state.chan = sb.channel('group-' + gid)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'quests', filter: `group_id=eq.${gid}` }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'entries', filter: `group_id=eq.${gid}` }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'quest_participants' }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'entry_comments' }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'entry_reactions' }, refresh)
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

const questCard = (q) => {
  const mine = q.quest_participants.some((p) => p.user_id === myId());
  return `
  <div class="card quest ${q.status}">
    <button class="qmain" data-act="open-quest" data-id="${q.id}">
      <div class="qt">${esc(q.title)}</div>
      ${q.tags?.length ? `<div class="pills">${tagPills(q.tags)}</div>` : ''}
      <div class="meta">${q.due_date ? '📅 ' + fmtDate(q.due_date) : ''}${q.location ? ` &nbsp;📍 ${esc(q.location)}` : ''}</div>
    </button>
    <div class="qfoot">
      ${q.quest_participants.length ? `<div class="faces">${q.quest_participants.map((p) => face(p.user_id, 26)).join('')}</div>` : ''}
      ${q.status === 'open' ? `<button class="imin ${mine ? 'on' : ''}" data-act="imin" data-id="${q.id}">${mine ? "✓ I'm in" : "🙋 I'm in"}</button>` : ''}
    </div>
  </div>`;
};

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
  if (!state.quests.length) return scene + `<div class="empty"><div class="big">🗺️</div><p>No quests yet.<br>Add the first thing you've all been saying "we should do someday".</p><button class="btn primary" data-act="ideas" style="margin-top:12px">💡 Need ideas?</button></div>` + archivedSection();
  return `
    ${scene}
    ${progressStrip()}
    ${filterBar()}
    ${!filtered.length ? `<div class="empty" style="padding:24px"><p>No quests with that tag yet.</p></div>` : ''}
    ${someday.length ? `<div class="nudge"><p><b>${someday.length}</b> quest${someday.length > 1 ? 's have' : ' has'} no date yet.</p><button data-act="spin">🎲 Pick one</button></div>` : ''}
    ${dated.length ? `<div class="section-title">Coming up</div>${dated.map(questCard).join('')}` : ''}
    ${someday.length ? `<div class="section-title">Someday</div>${someday.map(questCard).join('')}` : ''}
    ${done.length ? `<div class="section-title">Done ✓</div>${done.map(questCard).join('')}` : ''}
    ${archivedSection()}`;
}

const REACTS = ['❤️', '😂', '🔥', '🥹', '👏'];
const ago = (iso) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  return m < 1 ? 'now' : m < 60 ? m + 'm' : m < 1440 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd';
};
const nameOf = (id) => memberById(id)?.display_name || 'Someone';
const reactBar = (e) => REACTS.map((em) => {
  const n = state.reactions.filter((r) => r.entry_id === e.id && r.emoji === em).length;
  const mine = state.reactions.some((r) => r.entry_id === e.id && r.emoji === em && r.user_id === myId());
  return `<button class="react ${mine ? 'on' : ''}" data-act="react" data-entry="${e.id}" data-emoji="${em}">${em}${n ? ` <i>${n}</i>` : ''}</button>`;
}).join('');

// Comments sheet for one diary entry.
function entrySheet(id) {
  const e = state.entries.find((x) => x.id === id);
  if (!e) return;
  const q = state.quests.find((x) => x.id === e.quest_id);
  const keep = document.querySelector('#sheet form[data-form=comment] input[name=body]')?.value || '';   // don't lose half-typed text on a live refresh
  const cs = state.comments.filter((c) => c.entry_id === id);
  openSheet(`
    <h2>${esc(q?.title || 'Diary entry')}</h2>
    <div class="react-row" style="margin-bottom:10px">${reactBar(e)}</div>
    <div class="comments">${cs.length ? cs.map((c) => `
      <div class="cmt">${face(c.author_id, 30)}<div class="cbody"><div><b>${esc(nameOf(c.author_id))}</b> <span class="meta">${ago(c.created_at)}${c.edited_at ? ' · edited' : ''}</span>${(c.author_id === myId() || isFounder()) ? ` <button class="x" data-act="del-comment" data-id="${c.id}" aria-label="Delete comment">✕</button>` : ''}${c.author_id === myId() ? ` <button class="x" data-act="edit-comment" data-id="${c.id}" aria-label="Edit comment">✎</button>` : ''}</div>
        ${state.editingComment === c.id
          ? `<form data-form="editComment" data-id="${c.id}" class="row cform"><input type="text" name="body" maxlength="500" required value="${esc(c.body)}" style="margin:0"><button class="btn primary" style="margin:0;flex:none;width:auto">Save</button><button type="button" class="btn" data-act="cancel-edit-comment" style="margin:0;flex:none;width:auto">✕</button></form>`
          : `<p>${esc(c.body)}</p>`}</div></div>`).join('') : `<p class="meta" style="margin:6px 0 12px">No comments yet. Say something nice (or roast them lovingly).</p>`}</div>
    <form data-form="comment" data-id="${id}" class="row cform">
      <input type="text" name="body" maxlength="500" required placeholder="Add a comment…" autocomplete="off" style="margin:0">
      <button class="btn primary" style="margin:0;flex:none;width:auto">Send</button>
    </form>`);
  const sh = document.getElementById('sheet'); sh.dataset.entry = id;
  const inp = sh.querySelector('form[data-form=comment] input[name=body]'); inp.value = keep;
  sh.querySelector('.panel').scrollTop = sh.querySelector('.panel').scrollHeight;
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
      <div><div class="nm">${esc(m.display_name)}${m.id === myId() ? ' (you)' : ''}</div><div class="sub">${doneBy(m.id)} quest${doneBy(m.id) === 1 ? '' : 's'} done${m.role === 'admin' ? ' · founder' : ''}</div><div class="lvtag">Lv ${levelOf(state.xp[m.id])} · ${esc(levelName(levelOf(state.xp[m.id])))}</div></div>
    </div>`).join('');
  const g = state.group;
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
    ${statsCard()}
    <div class="section-title">The crew · ${state.members.length}</div>${rows}
    <button class="btn primary" data-act="share" style="margin-top:14px">Invite a friend</button>
    ${isFounder() ? `<button class="btn ghost" data-act="reset-invite" style="margin-top:6px">🔄 Make a new invite code</button>` : ''}
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

function newQuestSheet(date = '', preset = {}) {
  openSheet(`
    <h2>New quest</h2>
    <form data-form="newQuest">
      <input type="text" name="title" required maxlength="120" placeholder="What are we doing? e.g. Sunrise hike" value="${esc(preset.title || '')}">
      <textarea name="details" maxlength="2000" placeholder="Details (optional)"></textarea>
      <input type="text" name="location" maxlength="120" placeholder="Where? (optional)">
      <label class="lbl">When? (leave empty for someday)</label>
      <input type="date" name="due_date" value="${esc(date)}">
      ${tagPicker(preset.tags || [])}
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
    <button class="btn" data-act="archive-quest" data-id="${q.id}">📦 Archive (hide it, restore anytime)</button>
    ${(q.created_by === myId() || isFounder()) ? `<button class="btn danger" data-act="delete-quest" data-id="${q.id}">Delete quest</button>` : ''}`);
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
    ${e && e.author_id === myId() ? `<button class="btn" data-act="edit-entry" data-id="${e.id}">✏️ Edit diary entry</button>` : ''}
    ${e ? `<label class="cbtn addph" style="display:block;text-align:center;margin:8px 0">📷 Add photos<input type="file" accept="image/*" multiple hidden data-addphotos="${e.id}"></label>` : ''}
    <details class="arch"><summary>✏️ Edit quest details</summary>
      <form data-form="editDone" data-id="${q.id}" style="margin-top:10px">
        <input type="text" name="title" required maxlength="120" value="${esc(q.title)}">
        <textarea name="details" maxlength="2000" placeholder="Details">${esc(q.details || '')}</textarea>
        <input type="text" name="location" maxlength="120" placeholder="Where?" value="${esc(q.location || '')}">
        ${tagPicker(q.tags || [])}
        <button class="btn">Save quest details</button>
      </form>
    </details>
    ${(q.created_by === myId() || isFounder()) ? `<button class="btn danger" data-act="delete-quest" data-id="${q.id}">Delete quest & diary entry</button>` : ''}`);
}

// ---------- sheet: edit a diary entry (note, date, who, photos) ----------
const MAX_PHOTOS = 12;
function editEntrySheet(id) {
  const e = state.entries.find((x) => x.id === id);
  if (!e) return;
  if (e.author_id !== myId()) return toast('Only the person who wrote it can edit it');
  const q = state.quests.find((x) => x.id === e.quest_id);
  const ids = q ? q.quest_participants.map((p) => p.user_id) : [];
  const photos = e.photo_paths.map((p) => `
    <label class="ph"><input type="checkbox" name="rm" value="${esc(p)}">
      ${state.photoUrls[p] ? `<img src="${state.photoUrls[p]}" alt="">` : '<span class="noimg">📷</span>'}<b>✕</b><em>Will be removed</em>
    </label>`).join('');
  openSheet(`
    <h2>Edit diary entry</h2>
    <p class="meta" style="margin-bottom:12px">${esc(q?.title || '')}</p>
    <form data-form="editEntry" data-id="${e.id}">
      <label class="lbl">What happened?</label>
      <textarea name="note" maxlength="4000" placeholder="The funny bits, the food, the plot twists…">${esc(e.note || '')}</textarea>
      ${e.photo_paths.length ? `<label class="lbl">Photos (tap one to remove it)</label><div class="editphotos">${photos}</div>` : ''}
      <label class="lbl">Add photos (up to ${MAX_PHOTOS} in total)</label>
      <input type="file" name="photos" accept="image/*" multiple style="margin-bottom:10px">
      <label class="lbl">When was it?</label>
      <input type="date" name="done_on" required value="${esc(e.done_on)}">
      <label class="lbl">Who was there?</label>
      ${whoIn(ids.length ? ids : [myId()])}
      <button class="btn primary">Save changes</button>
    </form>`);
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
let avStart = null;  // avatar as it was when the editor opened (anything already worn stays selectable)
const avOk = (key, v) => lockLevel(key, v) <= levelOf(myXp()) || avStart?.[key] === v;

// The editor body (tabs + options). Re-rendered on every pick so the highlight and preview stay in sync.
function avEditorHtml() {
  const [, rows] = AV_TABS[avTab];
  const body = rows.map(([key, label, kind]) => {
    const vals = kind === 'color' ? AV_COLORS[key] : AV_OPTS[key];
    const btns = vals.map((v) => !avOk(key, v)
      ? (kind === 'color' ? `<button type="button" class="sw locked" disabled style="background:#${v}" title="Level ${lockLevel(key, v)}">🔒</button>` : `<button type="button" class="opt locked" disabled>🔒 ${avLabel(v)} · Lv ${lockLevel(key, v)}</button>`)
      : kind === 'color'
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
  avStart = { ...avDraft };
  avTab = 0;
  openSheet(`
    <h2>Your profile</h2>
    <form data-form="profile">
      <div class="av-hero">
        <div id="av-stage" class="stage big" style="background:#${avDraft.bg}"><img id="av-prev" class="fig" height="190" width="130" src="${avatarUrl(avEncode(avDraft), 'full')}" alt="Your character"></div>
        <button type="button" class="btn" data-act="shuffle" style="width:auto;margin:0">🎲 Surprise me</button>
      </div>
      <div class="lvlcard"><b>Lv ${levelOf(myXp())} · ${esc(levelName(levelOf(myXp())))}</b>${xpBar(myXp())}${(() => { const n = nextUnlock(levelOf(myXp())); return n ? `<div class="xpmeta">Lv ${n.level} unlocks: ${esc(n.items.join(', '))}</div>` : ''; })()}<div class="xpmeta">Earn XP: +100 per finished quest, +30 per diary entry, +20 with photos.</div></div>
      <input type="hidden" name="avatar_seed" value="${esc(avEncode(avDraft))}">
      <div id="av-editor" class="av-editor">${avEditorHtml()}</div>
      <label class="lbl" style="margin-top:14px">Display name</label>
      <input type="text" name="display_name" required maxlength="40" value="${esc(state.profile.display_name)}">
      <button class="btn primary">Save</button>
    </form>
    <div class="pwbox" id="push-box"></div>
    <form data-form="changePw" class="pwbox">
      <label class="lbl">Change password</label>
      <div class="row"><input type="password" name="pw" minlength="6" required placeholder="New password (6+)" autocomplete="new-password" style="margin:0"><button class="btn" style="margin:0;flex:none;width:auto">Update</button></div>
    </form>
    <button class="btn danger" data-act="logout" style="margin-top:14px">Log out</button>`);
  refreshPushBox();
}

// ================= v3: levels, streaks, stats, ideas, memory book, reminders =================
const isFounder = () => state.members.find((m) => m.id === myId())?.role === 'admin';

// ---------- XP + levels ----------
// XP is worked out in the database (get_xp): 100 per finished quest you were in, +30 per diary entry you wrote, +20 if it has photos.
const levelOf = (xp) => Math.floor(Math.sqrt((xp || 0) / 100)) + 1;
const xpAt = (lv) => 100 * (lv - 1) ** 2;                    // XP needed to reach a level
const LEVEL_NAMES = ['Newbie', 'Wanderer', 'Explorer', 'Adventurer', 'Trailblazer', 'Pathfinder', 'Hero', 'Legend', 'Mythic', 'Ascended'];
const levelName = (lv) => LEVEL_NAMES[Math.min(lv, LEVEL_NAMES.length) - 1];
const myXp = () => state.xp[myId()] || 0;
async function loadXp(ids) {
  const { data, error } = await sb.rpc('get_xp', { uids: ids });
  if (error) return console.error(error);
  (data || []).forEach((r) => { state.xp[r.user_id] = r.xp; });
}
const xpBar = (xp) => {
  const lv = levelOf(xp), lo = xpAt(lv), hi = xpAt(lv + 1);
  return `<div class="xpbar"><i style="width:${Math.round(((xp - lo) / (hi - lo)) * 100)}%"></i></div><div class="xpmeta">${xp - lo} / ${hi - lo} XP to Lv ${lv + 1}</div>`;
};
// What level unlocks which avatar option. Anything not listed is free from the start.
const LOCKS = {
  hair: { bob: 2, curly: 3, bun: 4, ponytail: 5 },
  eyes: { wink: 3, sparkle: 5 },
  mouth: { cat: 4 },
  glasses: { round: 2, sunglasses: 4 },
  head: { cap: 2, beanie: 3, bow: 3, headband: 4, catears: 5, halo: 6, flower: 7, crown: 8 },
  top: { tank: 2, jacket: 3, dress: 4 },
  bottom: { skirt: 3 },
  shoes: { sandals: 2, boots: 3 },
  hairColor: { f48fb1: 3, '8e6cc6': 4, '4a90d9': 5, ffffff: 6 },
  bg: { cfeff0: 2, fff6c9: 3, e6e6ee: 4 },
};
const lockLevel = (key, val) => LOCKS[key]?.[val] || 1;
const unlockLabel = (k, v) => k === 'hairColor' ? 'a new hair color' : k === 'bg' ? 'a new backdrop' : k === 'hair' ? `${avLabel(v)} hair` : k === 'eyes' ? `${avLabel(v)} eyes` : k === 'mouth' ? `${avLabel(v)} mouth` : avLabel(v);
const unlocksAt = (lv) => Object.entries(LOCKS).flatMap(([k, m]) => Object.entries(m).filter(([, l]) => l === lv).map(([v]) => unlockLabel(k, v)));
function nextUnlock(lv) {
  for (let l = lv + 1; l <= 12; l++) { const u = unlocksAt(l); if (u.length) return { level: l, items: u }; }
  return null;
}
function levelUpSheet(lv) {
  const items = unlocksAt(lv);
  openSheet(`
    <div class="lvlup"><div class="big">🎉</div><h2>Level ${lv} · ${levelName(lv)}!</h2>
    ${items.length ? `<p>New in the dress-up room:</p><ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p>Keep going, more outfits are coming.</p>'}
    <button class="btn primary" data-act="profile">👕 Dress up now</button></div>`);
}

// ---------- crew streak (weeks in a row with at least one finished quest) ----------
const weekIdx = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const days = Math.floor(Date.UTC(y, m - 1, d) / 86400000), dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;   // weeks start Monday
  return Math.floor((days - dow + 3) / 7);
};
function streakInfo() {
  const t = today();
  const set = new Set(state.entries.filter((e) => e.done_on && e.done_on <= t).map((e) => weekIdx(e.done_on)));
  const thisW = weekIdx(t);
  let cur = 0, w = set.has(thisW) ? thisW : thisW - 1;
  while (set.has(w)) { cur++; w--; }
  let best = 0, run = 0, prev = null;
  for (const x of [...set].sort((a, b) => a - b)) { run = prev !== null && x === prev + 1 ? run + 1 : 1; best = Math.max(best, run); prev = x; }
  return { cur, best, doneThisWeek: set.has(thisW) };
}
function progressStrip() {
  const xp = myXp(), lv = levelOf(xp), s = streakInfo();
  const msg = s.cur > 0 && s.doneThisWeek ? `🔥 ${s.cur}-week crew streak`
    : s.cur > 0 ? `🔥 ${s.cur}-week streak at risk. Finish a quest by Sunday!`
    : 'No streak yet. Finish a quest this week to start one.';
  return `<div class="strip"><button class="lvlbtn" data-act="profile">Lv ${lv}<small>${esc(levelName(lv))}</small></button><div class="streak">${msg}</div><button class="pillbtn" data-act="ideas">💡 Ideas</button></div>`;
}

// ---------- stats ----------
function statsCard() {
  const done = state.quests.filter((q) => q.status === 'done');
  const total = state.quests.length;
  const pct = total ? Math.round(done.length / total * 100) : 0;
  const year = String(new Date().getFullYear());
  const yearN = state.entries.filter((e) => (e.done_on || '').startsWith(year)).length;
  const photos = state.entries.reduce((n, e) => n + e.photo_paths.length, 0);
  const places = new Set(done.map((q) => (q.location || '').trim().toLowerCase()).filter(Boolean)).size;
  const tagCount = {}; done.forEach((q) => (q.tags || []).forEach((t) => { tagCount[t] = (tagCount[t] || 0) + 1; }));
  const topTag = Object.entries(tagCount).sort((a, b) => b[1] - a[1])[0];
  const att = state.members.map((m) => [m, done.filter((q) => q.quest_participants.some((p) => p.user_id === m.id)).length]).sort((a, b) => b[1] - a[1])[0];
  const loved = state.entries.map((e) => [e, state.reactions.filter((r) => r.entry_id === e.id).length + state.comments.filter((c) => c.entry_id === e.id).length]).sort((a, b) => b[1] - a[1])[0];
  const lovedQ = loved && loved[1] > 0 ? state.quests.find((q) => q.id === loved[0].quest_id) : null;
  const s = streakInfo();
  const tile = (ic, big, lb) => `<div class="stile"><span>${ic}</span><b>${big}</b><em>${lb}</em></div>`;
  return `
    <div class="card stats">
      <h3>Crew stats</h3>
      <div class="prog"><div class="bar"><i style="width:${pct}%"></i></div><span>${done.length} of ${total} quests done (${pct}%)</span></div>
      <div class="sgrid">
        ${tile('🔥', s.cur + 'w', 'current streak')}
        ${tile('🏆', s.best + 'w', 'best streak')}
        ${tile('📅', yearN, 'memories in ' + year)}
        ${tile('📷', photos, 'photos')}
        ${tile('📍', places, 'places')}
        ${topTag ? tile(tagInfo(topTag[0])?.[1] || '✨', tagInfo(topTag[0])?.[2] || topTag[0], 'top vibe') : tile('✨', '–', 'top vibe')}
      </div>
      ${att && att[1] > 0 ? `<p class="mvp">⭐ Most quests: <b>${esc(att[0].display_name)}</b> (${att[1]})</p>` : ''}
      ${lovedQ ? `<p class="mvp">💖 Most loved memory: <b>${esc(lovedQ.title)}</b></p>` : ''}
    </div>`;
}

// ---------- quest ideas ----------
const IDEA_LIST = {
  sports: ['Play badminton or pickleball', 'Bowling night', 'Rent bikes and ride around a park', 'Try wall climbing', 'Futsal game vs another barkada', 'Go swimming at a resort', 'Skate or rollerblade day', 'Join a fun run together'],
  arts: ['Paint and sip night', 'Make pottery', 'Craft a scrapbook of our year', 'Try candle or soap making', 'Do a tote bag painting session', 'Sketch strangers at a cafe', 'DIY photo booth day', 'Make friendship bracelets'],
  out: ['Karaoke night', 'Watch a live gig', 'Night market crawl', 'Movie marathon in a cinema', 'Rooftop bar sunset', 'Thrift shopping day', 'Go to a concert together', 'Try an escape room'],
  nature: ['Sunrise hike', 'Beach day with a picnic', 'Visit a waterfall', 'Camp overnight', 'Stargazing trip', 'Plant trees together', 'Kayak or paddle board', 'Visit a farm or flower garden'],
  food: ['Try a new restaurant every week', 'Street food crawl', 'Cook a full meal together', 'Bake something ridiculous', 'Boodle fight night', 'Dessert crawl', 'Find the best halo-halo', 'Potluck with a theme'],
  travel: ['Weekend road trip', 'Visit a province none of us has been to', 'Island hopping', 'Day trip by train', 'Staycation at a hotel', 'Visit a heritage town', 'Take a ferry somewhere new', 'Plan a trip abroad together'],
  games: ['Board game night', 'Arcade run', 'Video game tournament', 'Mahjong or card night', 'Mini golf', 'Trivia night at a bar', 'Charades marathon', 'Build a huge jigsaw puzzle'],
  music: ['Make a group playlist', 'Learn a song together', 'Jam session with whatever instruments we have', 'Go to an open mic', 'Dance class together', 'Record a silly music video', 'Vinyl shop visit', 'Rewatch a musical'],
  learn: ['Take a one-day workshop', 'Visit a museum', 'Learn a few phrases of a new language', 'Book club meetup', 'Visit a library or bookstore', 'Attend a free talk', 'Try a coding or crafts class', 'Teach each other one skill'],
  wellness: ['Yoga in the park', 'Spa day', 'Digital detox afternoon', 'Morning walk and coffee', 'Meditation session', 'Cold drink and journaling date', 'Sleep early challenge', 'Try a new healthy recipe'],
  chill: ['Pajama party', 'Movie night at home', 'Cafe hop and do nothing', 'Picnic at the park', 'Bake and binge a series', 'Spa night with face masks', 'Backyard bonfire', 'Photo dump night: look through old pics'],
  other: ['Volunteer for a day', 'Throw a surprise party for someone', 'Make a time capsule', 'Group photoshoot', 'Secret Santa or gift swap', 'Visit a pet cafe', 'Random act of kindness day', 'Do something none of us have tried'],
};
const IDEAS = Object.entries(IDEA_LIST).flatMap(([tag, list]) => list.map((title) => [tag, title]));
let ideaTag = null, ideaShown = [];
function ideasSheet() {
  const have = new Set(state.quests.concat(state.archived).map((q) => q.title.trim().toLowerCase()));
  const pool = IDEAS.filter(([tag, title]) => (!ideaTag || tag === ideaTag) && !have.has(title.toLowerCase()));
  ideaShown = [...pool].sort(() => Math.random() - 0.5).slice(0, 5);
  openSheet(`
    <h2>💡 Quest ideas</h2>
    <div class="filters sheetfilters">
      <button class="${!ideaTag ? 'on' : ''}" data-act="idea-tag" data-tag="">All</button>
      ${TAGS.map(([k, ic, lb]) => `<button class="${ideaTag === k ? 'on' : ''}" data-act="idea-tag" data-tag="${k}">${ic} ${lb}</button>`).join('')}
    </div>
    ${ideaShown.length ? ideaShown.map(([tag, title], i) => `
      <div class="idea"><div class="grow"><b>${esc(title)}</b><div class="pills">${tagPills([tag])}</div></div><button class="btn primary" data-act="idea-add" data-i="${i}" style="width:auto;margin:0">＋ Add</button></div>`).join('')
      : '<p class="meta" style="margin:8px 0">You already have every idea in this category. Respect.</p>'}
    <button class="btn" data-act="idea-more" style="margin-top:10px">🎲 Show me others</button>`);
}

// ---------- archived quests ----------
function archivedSection() {
  if (!state.archived.length) return '';
  return `<details class="arch"><summary>📦 Archived (${state.archived.length})</summary>
    ${state.archived.map((q) => `<div class="card quest"><div class="qmain"><div class="qt">${esc(q.title)}</div></div>
      <div class="qfoot"><button class="imin" data-act="restore-quest" data-id="${q.id}">↩ Restore</button>${(q.created_by === myId() || isFounder()) ? `<button class="imin" data-act="delete-quest" data-id="${q.id}">🗑 Delete</button>` : ''}</div></div>`).join('')}
  </details>`;
}

// ---------- diary: feed + memory book ----------
function viewDiary() {
  const toggle = `<div class="seg"><button class="${state.diaryMode === 'feed' ? 'on' : ''}" data-act="diary-mode" data-mode="feed">Feed</button><button class="${state.diaryMode === 'book' ? 'on' : ''}" data-act="diary-mode" data-mode="book">Memory book</button></div>`;
  if (!state.entries.length) return `<div class="empty"><div class="big">📖</div><p>Your diary is empty.<br>Finish a quest and it lands here.</p></div>`;
  return toggle + (state.diaryMode === 'book' ? viewBook() : viewFeed());
}

const addPhotosBtn = (e) => `<label class="cbtn addph">📷 Add photos<input type="file" accept="image/*" multiple hidden data-addphotos="${e.id}"></label>`;

function viewFeed() {
  return state.entries.map((e) => {
    const q = state.quests.find((x) => x.id === e.quest_id);
    const who = q ? q.quest_participants.map((p) => face(p.user_id, 26)).join('') : '';
    const cs = state.comments.filter((c) => c.entry_id === e.id);
    const last = cs[cs.length - 1];
    return `
      <article class="card entry">
        <div class="head">${face(e.author_id, 34)}<div class="grow"><h3>${esc(q?.title || 'Quest')}</h3><div class="meta">${fmtDate(e.done_on)}${q?.location ? ` · 📍 ${esc(q.location)}` : ''}</div></div>${e.author_id === myId() ? `<button class="edit-btn" data-act="edit-entry" data-id="${e.id}" aria-label="Edit diary entry">✏️ Edit</button>` : ''}</div>
        ${e.note ? `<p class="note">${esc(e.note)}</p>` : ''}
        ${photoGrid(e)}
        ${who ? `<div class="faces">${who}</div>` : ''}
        <div class="react-row">${reactBar(e)}<button class="cbtn" data-act="open-entry" data-id="${e.id}">💬 ${cs.length || 'Comment'}</button>${addPhotosBtn(e)}</div>
        ${last ? `<button class="cprev" data-act="open-entry" data-id="${e.id}"><b>${esc(nameOf(last.author_id))}</b> ${esc(last.body)}</button>` : ''}
      </article>`;
  }).join('');
}

function viewBook() {
  const years = [...new Set(state.entries.map((e) => (e.done_on || '').slice(0, 4)).filter(Boolean))].sort().reverse();
  const yr = years.includes(state.bookYear) ? state.bookYear : years[0];
  const list = state.entries.filter((e) => (e.done_on || '').startsWith(yr)).sort((a, b) => b.done_on.localeCompare(a.done_on));
  const photos = list.reduce((n, e) => n + e.photo_paths.length, 0);
  const qs = list.map((e) => state.quests.find((q) => q.id === e.quest_id)).filter(Boolean);
  const places = new Set(qs.map((q) => (q.location || '').trim().toLowerCase()).filter(Boolean)).size;
  const byMonth = {};
  list.forEach((e) => { (byMonth[e.done_on.slice(0, 7)] ||= []).push(e); });
  const months = Object.keys(byMonth).sort().reverse().map((k) => {
    const [y, m] = k.split('-').map(Number);
    return `<div class="section-title">${MONTHS[m - 1]} ${y} · ${byMonth[k].length}</div>` + byMonth[k].map((e) => {
      const q = state.quests.find((x) => x.id === e.quest_id);
      const thumbs = e.photo_paths.slice(0, 3).map((p) => state.photoUrls[p]).filter(Boolean).map((u) => `<img src="${u}" alt="" loading="lazy">`).join('');
      return `<button class="card bk" data-act="open-entry" data-id="${e.id}">
        <div class="bkth ${thumbs ? '' : 'none'}">${thumbs || '📖'}</div>
        <div class="bkt"><b>${esc(q?.title || 'Quest')}</b><span>${fmtDate(e.done_on)}${q?.location ? ` · 📍 ${esc(q.location)}` : ''}</span>${e.note ? `<p>${esc(e.note)}</p>` : ''}</div></button>`;
    }).join('');
  }).join('');
  return `
    ${years.length > 1 ? `<div class="filters">${years.map((y) => `<button class="${y === yr ? 'on' : ''}" data-act="book-year" data-year="${y}">${y}</button>`).join('')}</div>` : ''}
    <div class="card recap"><h3>${yr} so far</h3>
      <div class="crew-stats"><div><b>${list.length}</b><span>memories</span></div><div><b>${photos}</b><span>photos</span></div><div><b>${places}</b><span>places</span></div></div></div>
    ${months}`;
}

async function addPhotosToEntry(entryId, files) {
  const e = state.entries.find((x) => x.id === entryId);
  if (!e || !files.length) return;
  if (e.photo_paths.length + files.length > 12) return toast(`Max 12 photos per entry (it has ${e.photo_paths.length})`);
  toast('Uploading…');
  const gid = state.group.id, added = [];
  try {
    for (const file of files) {
      const blob = await compress(file);
      const path = `${gid}/${e.quest_id || 'misc'}/${crypto.randomUUID()}.jpg`;
      const { error } = await sb.storage.from('photos').upload(path, blob, { contentType: 'image/jpeg' });
      if (error) throw error;
      added.push(path);
    }
    const { error } = await sb.rpc('add_entry_photos', { eid: e.id, paths: added });
    if (error) throw error;
  } catch (err) {
    if (added.length) await sb.storage.from('photos').remove(added);
    throw err;
  }
  await reloadGroup(); toast('Photos added 📷');
}
document.addEventListener('change', (ev) => {
  const inp = ev.target.closest?.('input[data-addphotos]');
  if (!inp) return;
  const files = [...inp.files]; inp.value = '';
  addPhotosToEntry(inp.dataset.addphotos, files).catch(fail);
});

// ---------- push reminders ----------
const b64ToU8 = (s) => { const p = '='.repeat((4 - s.length % 4) % 4), raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...raw].map((c) => c.charCodeAt(0))); };
async function pushStatus() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return ios && !standalone ? 'ios-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}
async function refreshPushBox() {
  const box = document.getElementById('push-box');
  if (!box) return;
  const st = await pushStatus().catch(() => 'unsupported');
  const txt = {
    'ios-install': 'On iPhone, add SideQuest to your Home Screen first (Share button → Add to Home Screen), open it from there, then turn this on.',
    unsupported: "This browser can't do reminders.",
    denied: 'Notifications are blocked. Allow them for SideQuest in your phone settings.',
    on: "On. You'll get a nudge the day before and the morning of a planned quest, plus a Thursday nudge if your crew has nothing planned.",
    off: "Get a nudge the day before and the morning of a planned quest, plus a Thursday nudge if your crew has nothing planned.",
  }[st];
  box.innerHTML = `<label class="lbl">🔔 Reminders</label><p class="meta" style="margin-bottom:8px">${txt}</p>
    ${st === 'on' || st === 'off' ? `<button type="button" class="btn ${st === 'off' ? 'primary' : ''}" data-act="push-toggle">${st === 'on' ? 'Turn off reminders' : 'Turn on reminders'}</button>` : ''}`;
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
  'shuffle': () => { avDraft = avRandom(); for (const k of Object.keys(avDraft)) if (!avOk(k, avDraft[k])) avDraft[k] = AV_DEFAULT[k]; avRefresh(); },
  'av-tab': (t) => { avTab = Number(t.dataset.i); avRefresh(); },
  'av-opt': (t) => { avDraft[t.dataset.key] = t.dataset.val; avRefresh(); },

  'forgot': async (t) => {
    const email = t.closest('form').querySelector('input[name=email]').value.trim();
    if (!email) return toast('Type your email above first');
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/' });
    if (error) return fail(error);
    toast('If that email has an account, a reset link is on its way.');
  },
  'imin': async (t) => {
    const q = state.quests.find((x) => x.id === t.dataset.id);
    if (!q) return;
    const mine = q.quest_participants.some((p) => p.user_id === myId());
    q.quest_participants = mine ? q.quest_participants.filter((p) => p.user_id !== myId()) : [...q.quest_participants, { user_id: myId() }];
    const y = window.scrollY; render(); window.scrollTo(0, y);   // instant feel; the database catches up
    const res = mine
      ? await sb.from('quest_participants').delete().match({ quest_id: q.id, user_id: myId() })
      : await sb.from('quest_participants').insert({ quest_id: q.id, user_id: myId() });
    if (res.error) { fail(res.error); await reloadGroup(); }
  },
  'react': async (t) => {
    const entry_id = t.dataset.entry, emoji = t.dataset.emoji;
    const i = state.reactions.findIndex((r) => r.entry_id === entry_id && r.user_id === myId() && r.emoji === emoji);
    if (i >= 0) state.reactions.splice(i, 1); else state.reactions.push({ entry_id, user_id: myId(), emoji });
    const y = window.scrollY; render(); window.scrollTo(0, y);
    if (document.getElementById('sheet')?.dataset.entry === entry_id) entrySheet(entry_id);
    const res = i >= 0
      ? await sb.from('entry_reactions').delete().match({ entry_id, user_id: myId(), emoji })
      : await sb.from('entry_reactions').insert({ entry_id, user_id: myId(), emoji });
    if (res.error) { fail(res.error); await reloadGroup(); }
  },
  'edit-entry': (t) => editEntrySheet(t.dataset.id),
  'edit-comment': (t) => { state.editingComment = t.dataset.id; const c = state.comments.find((x) => x.id === t.dataset.id); if (c) entrySheet(c.entry_id); },
  'cancel-edit-comment': (t) => { const id = document.getElementById('sheet')?.dataset.entry; state.editingComment = null; if (id) entrySheet(id); },
  'diary-mode': (t) => { state.diaryMode = t.dataset.mode; render(); window.scrollTo(0, 0); },
  'book-year': (t) => { state.bookYear = t.dataset.year; render(); },
  'ideas': () => ideasSheet(),
  'idea-tag': (t) => { ideaTag = t.dataset.tag || null; ideasSheet(); },
  'idea-more': () => ideasSheet(),
  'idea-add': (t) => { const [tag, title] = ideaShown[Number(t.dataset.i)] || []; if (title) newQuestSheet('', { title, tags: [tag] }); },
  'archive-quest': async (t) => {
    const { error } = await sb.from('quests').update({ archived: true }).eq('id', t.dataset.id);
    if (error) return fail(error);
    closeSheet(); await reloadGroup(); toast('Archived 📦');
  },
  'restore-quest': async (t) => {
    const { error } = await sb.from('quests').update({ archived: false }).eq('id', t.dataset.id);
    if (error) return fail(error);
    await reloadGroup(); toast('Restored');
  },
  'push-toggle': async () => {
    const st = await pushStatus();
    const reg = await navigator.serviceWorker.ready;
    if (st === 'on') {
      const sub = await reg.pushManager.getSubscription();
      if (sub) { await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint); await sub.unsubscribe(); }
      toast('Reminders off');
    } else {
      if ((await Notification.requestPermission()) !== 'granted') { refreshPushBox(); return toast('Notifications are blocked. Allow them in your phone settings.'); }
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(VAPID_PUBLIC_KEY) });
      const j = sub.toJSON();
      const { error } = await sb.rpc('save_push', { ep: j.endpoint, p: j.keys.p256dh, a: j.keys.auth });
      if (error) { await sub.unsubscribe(); throw error; }
      reg.showNotification('Reminders are on 🔔', { body: "We'll nudge you about upcoming quests.", icon: 'icons/icon-192.png' });
    }
    refreshPushBox();
  },
  'open-entry': (t) => entrySheet(t.dataset.id),
  'del-comment': async (t) => {
    const c = state.comments.find((x) => x.id === t.dataset.id);
    if (!c) return;
    const { error } = await sb.from('entry_comments').delete().eq('id', c.id);
    if (error) return fail(error);
    state.comments = state.comments.filter((x) => x.id !== c.id);
    render(); entrySheet(c.entry_id);
  },
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
    const q = state.quests.concat(state.archived).find((x) => x.id === t.dataset.id);
    if (!q) return;
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
    const lvBefore = levelOf(myXp());
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
    closeSheet(); state.tab = 'diary'; await reloadGroup();
    const after = levelOf(myXp());
    if (after > lvBefore) levelUpSheet(after); else toast('Saved to the diary 📖 +XP');
  }),

  editEntry: (f) => run(f, async () => {
    const e = state.entries.find((x) => x.id === f.dataset.id);
    if (!e) return;
    const gid = state.group.id, fd = new FormData(f);
    const removed = [...f.querySelectorAll('input[name=rm]:checked')].map((i) => i.value);
    const kept = e.photo_paths.filter((p) => !removed.includes(p));
    const files = [...f.querySelector('input[type=file]').files];
    if (kept.length + files.length > MAX_PHOTOS) throw new Error(`Max ${MAX_PHOTOS} photos. You'd have ${kept.length + files.length}.`);
    const added = [];
    try {
      for (const file of files) {
        const blob = await compress(file);
        const path = `${gid}/${e.quest_id}/${crypto.randomUUID()}.jpg`;
        const { error } = await sb.storage.from('photos').upload(path, blob, { contentType: 'image/jpeg' });
        if (error) throw error;
        added.push(path);
      }
      const { error } = await sb.from('entries').update({
        note: fd.get('note').trim() || null, done_on: fd.get('done_on'), photo_paths: [...kept, ...added],
      }).eq('id', e.id);
      if (error) throw error;
    } catch (err) {
      if (added.length) await sb.storage.from('photos').remove(added);   // don't leave orphaned uploads behind
      throw err;
    }
    if (removed.length) await sb.storage.from('photos').remove(removed);  // only after the entry saved OK
    if (e.quest_id) await setParticipants(e.quest_id, checkedWho(f));
    closeSheet(); await reloadGroup(); toast('Diary updated ✏️');
  }),

  newPassword: (f) => run(f, async () => {
    const fd = new FormData(f);
    if (fd.get('pw1') !== fd.get('pw2')) throw new Error("Those two passwords don't match");
    const { data, error } = await sb.auth.updateUser({ password: fd.get('pw1') });
    if (error) throw error;
    history.replaceState({}, '', location.pathname);
    toast('Password updated 🔑');
    await afterLogin(data.user);
  }),

  changePw: (f) => run(f, async () => {
    const { error } = await sb.auth.updateUser({ password: new FormData(f).get('pw') });
    if (error) throw error;
    f.reset(); toast('Password updated 🔑');
  }),

  comment: (f) => run(f, async () => {
    const body = new FormData(f).get('body').trim();
    if (!body) return;
    const { data, error } = await sb.from('entry_comments').insert({ entry_id: f.dataset.id, author_id: myId(), body }).select().single();
    if (error) throw error;
    state.comments.push(data);
    f.querySelector('input[name=body]').value = '';   // so the live re-draw doesn't put the sent text back
    render(); entrySheet(f.dataset.id);
    document.querySelector('#sheet input[name=body]')?.focus();
  }),

  editComment: (f) => run(f, async () => {
    const body = new FormData(f).get('body').trim();
    const c = state.comments.find((x) => x.id === f.dataset.id);
    if (!body || !c) return;
    const edited_at = new Date().toISOString();
    const { error } = await sb.from('entry_comments').update({ body, edited_at }).eq('id', c.id);
    if (error) throw error;
    Object.assign(c, { body, edited_at });
    state.editingComment = null; render(); entrySheet(c.entry_id);
  }),

  editDone: (f) => run(f, async () => {
    const fd = new FormData(f);
    const { error } = await sb.from('quests').update({
      title: fd.get('title').trim(), details: fd.get('details').trim() || null, location: fd.get('location').trim() || null, tags: checkedTags(f),
    }).eq('id', f.dataset.id);
    if (error) throw error;
    closeSheet(); await reloadGroup(); toast('Saved');
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
