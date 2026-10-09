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
  photoUrls: {},   // storage path -> signed url
  chan: null,      // realtime channel
};

// ---------- tiny helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const myId = () => state.user.id;
const avatarUrl = (seed) => `https://api.dicebear.com/9.x/adventurer/svg?seed=${encodeURIComponent(seed)}`;
const avatar = (seed, size = 36, title = '') => `<img class="av" width="${size}" height="${size}" src="${avatarUrl(seed)}" alt="" title="${esc(title)}" loading="lazy">`;
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
  const { data, error } = await sb.from('members').select('groups(id,name,invite_code)').eq('user_id', myId());
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
      <div class="qt" style="font-weight:800;font-size:18px">${esc(g.name)}</div>
      <div class="meta">Tap to open</div>
    </button>`).join('');
  $app.innerHTML = `
    <header class="top">
      <div class="grow"><h1>Hey, ${esc(state.profile.display_name)} 👋</h1></div>
      <button class="icon-btn" data-act="profile" aria-label="Your profile">${avatar(state.profile.avatar_seed, 36)}</button>
    </header>
    <main>
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
    .subscribe();
}
function unsubscribe() { if (state.chan) { sb.removeChannel(state.chan); state.chan = null; } }

// ---------- group screen ----------
function render() {
  if (!state.group) return;
  const g = state.group;
  const tabs = [['quests', '🗺️', 'Quests'], ['diary', '📖', 'Diary'], ['crew', '👥', 'Crew']];
  $app.innerHTML = `
    <header class="top">
      <button class="icon-btn" data-act="back" aria-label="All crews">‹</button>
      <div class="grow">
        <h1>${esc(g.name)}</h1>
        <button class="code-btn" data-act="share">Invite · ${esc(g.invite_code)}</button>
      </div>
      <button class="icon-btn" data-act="profile" aria-label="Your profile">${avatar(state.profile.avatar_seed, 36)}</button>
    </header>
    <main>${state.tab === 'quests' ? viewQuests() : state.tab === 'diary' ? viewDiary() : viewCrew()}</main>
    ${state.tab === 'quests' ? `<button class="fab" data-act="new-quest">＋ New quest</button>` : ''}
    <nav class="tabs">${tabs.map(([k, ic, lb]) => `<button class="${state.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}"><span>${ic}</span>${lb}</button>`).join('')}</nav>`;
}

const questCard = (q) => `
  <button class="card quest ${q.status}" data-act="open-quest" data-id="${q.id}">
    <div class="qt">${esc(q.title)}</div>
    <div class="meta">${q.due_date ? '📅 ' + fmtDate(q.due_date) : ''}${q.location ? ` &nbsp;📍 ${esc(q.location)}` : ''}</div>
    ${q.quest_participants.length ? `<div class="faces">${q.quest_participants.map((p) => face(p.user_id, 26)).join('')}</div>` : ''}
  </button>`;

function viewQuests() {
  const open = state.quests.filter((q) => q.status === 'open');
  const dated = open.filter((q) => q.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const someday = open.filter((q) => !q.due_date);
  const done = state.quests.filter((q) => q.status === 'done');
  if (!state.quests.length) return `<div class="empty"><div class="big">🗺️</div><p>No quests yet.<br>Add the first thing you've all been saying "we should do someday".</p></div>`;
  return `
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
      ${avatar(m.avatar_seed, 48)}
      <div><div class="nm">${esc(m.display_name)}${m.id === myId() ? ' (you)' : ''}</div><div class="sub">${doneBy(m.id)} quest${doneBy(m.id) === 1 ? '' : 's'} done${m.role === 'admin' ? ' · founder' : ''}</div></div>
    </div>`).join('');
  return `
    <div class="section-title">The crew · ${state.members.length}</div>${rows}
    <button class="btn primary" data-act="share" style="margin-top:14px">Invite a friend</button>
    <button class="btn danger" data-act="leave" style="margin-top:22px">Leave this crew</button>`;
}

// ---------- sheets: quests ----------
const whoIn = (selected = []) => `<div class="who">${state.members.map((m) => `
  <label class="chip"><input type="checkbox" name="who" value="${m.id}" ${selected.includes(m.id) ? 'checked' : ''}>${avatar(m.avatar_seed, 26)}<span>${esc(m.display_name)}</span></label>`).join('')}</div>`;
const checkedWho = (f) => [...f.querySelectorAll('input[name=who]:checked')].map((i) => i.value);

function newQuestSheet() {
  openSheet(`
    <h2>New quest</h2>
    <form data-form="newQuest">
      <input type="text" name="title" required maxlength="120" placeholder="What are we doing? e.g. Sunrise hike">
      <textarea name="details" maxlength="2000" placeholder="Details (optional)"></textarea>
      <input type="text" name="location" maxlength="120" placeholder="Where? (optional)">
      <label class="lbl">When? (leave empty for someday)</label>
      <input type="date" name="due_date">
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
      <label class="lbl">Who's in?</label>
      ${whoIn(ids)}
      <button class="btn">Save changes</button>
    </form>
    <button class="btn primary" data-act="complete" data-id="${q.id}">✅ We did it!</button>
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

// ---------- sheet: profile ----------
function profileSheet() {
  openSheet(`
    <h2>Your profile</h2>
    <form data-form="profile">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
        <img id="av-prev" class="av" width="72" height="72" src="${avatarUrl(state.profile.avatar_seed)}" alt="">
        <button type="button" class="btn" data-act="shuffle" style="width:auto;margin:0">🎲 Shuffle avatar</button>
      </div>
      <input type="hidden" name="avatar_seed" value="${esc(state.profile.avatar_seed)}">
      <label class="lbl">Display name</label>
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
  'shuffle': () => {
    const seed = crypto.randomUUID().slice(0, 8);
    document.querySelector('input[name=avatar_seed]').value = seed;
    document.getElementById('av-prev').src = avatarUrl(seed);
  },
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
