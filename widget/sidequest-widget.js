// SideQuest home-screen widget for the Scriptable app (free on the App Store).
// Shows your next quest + countdown. Tap it to open SideQuest.
// Your personal key is baked into the line below. Don't share this script with anyone.
const KEY = "__KEY__";
const ENDPOINT = "__ENDPOINT__";
const APP_URL = "__APP_URL__";

// ---- look ----
const BG_TOP = new Color("#6a5bf0"), BG_BOTTOM = new Color("#3d2fb0");
const WHITE = Color.white(), SOFT = new Color("#ffffff", 0.72), HOT = new Color("#ff9d6a");

async function load() {
  try {
    const r = new Request(ENDPOINT);
    r.headers = { "x-widget-key": KEY };
    r.timeoutInterval = 15;
    const data = await r.loadJSON();
    if (data.error) throw new Error(data.error);
    return data;
  } catch (e) { return { error: String(e.message || e) }; }
}

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const parse = (d) => { const [y, m, dd] = d.split("-").map(Number); return new Date(y, m - 1, dd); };
const shortDate = (d) => { const x = parse(d); return MON[x.getMonth()] + " " + x.getDate(); };
const t12 = (t) => { if (!t) return ""; const [h, m] = t.split(":").map(Number); return ((h + 11) % 12 + 1) + ":" + String(m).padStart(2, "0") + (h < 12 ? " AM" : " PM"); };
function when(q) {
  let s = shortDate(q.due_date);
  if (q.end_date && q.end_date > q.due_date) s += " → " + shortDate(q.end_date);
  if (q.start_time) s += " · " + t12(q.start_time);
  return s;
}
function countdown(q, today) {
  const t = parse(today), a = parse(q.due_date), b = parse(q.end_date || q.due_date);
  if (a <= t && b >= t) return ["Happening now", true];
  const n = Math.round((a - t) / 864e5);
  if (n === 1) return ["Tomorrow", true];
  return ["in " + n + " days", n <= 1];
}

function text(stack, s, size, color, bold, lines) {
  const t = stack.addText(s);
  t.font = bold ? Font.boldSystemFont(size) : Font.mediumSystemFont(size);
  t.textColor = color; if (lines) t.lineLimit = lines;
  return t;
}

function build(data, family) {
  const w = new ListWidget();
  const g = new LinearGradient(); g.colors = [BG_TOP, BG_BOTTOM]; g.locations = [0, 1];
  w.backgroundGradient = g; w.url = APP_URL; w.setPadding(14, 14, 12, 14);
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);

  if (data.error) {
    text(w, "SideQuest", 15, WHITE, true);
    w.addSpacer(4);
    text(w, "Couldn't load. Check your connection, or get a fresh key in Profile.", 12, SOFT, false, 3);
    return w;
  }
  const q = (data.upcoming || [])[0];
  if (!q) {
    text(w, "SideQuest 🗺️", 15, WHITE, true);
    w.addSpacer(6);
    text(w, data.someday ? data.someday + " quest" + (data.someday > 1 ? "s" : "") + " with no date yet" : "Nothing planned yet", 14, WHITE, true, 2);
    w.addSpacer(2);
    text(w, "Pick a date and get the crew moving.", 12, SOFT, false, 2);
    return w;
  }
  const [cd, hot] = countdown(q, data.today);

  if (family === "accessoryRectangular") {
    text(w, cd, 11, WHITE, true); text(w, q.title, 14, WHITE, true, 2); text(w, when(q), 11, WHITE, false, 1);
    return w;
  }

  const head = w.addStack(); head.centerAlignContent();
  text(head, (q.emoji || "🗺️") + " " + (q.crew || "SideQuest"), 11, SOFT, true, 1);
  w.addSpacer(6);
  text(w, cd, family === "small" ? 12 : 13, hot ? HOT : WHITE, true);
  w.addSpacer(2);
  text(w, q.title, family === "small" ? 16 : 20, WHITE, true, family === "small" ? 3 : 2);
  w.addSpacer(3);
  text(w, when(q), 12, SOFT, false, 1);
  if (q.location) text(w, "📍 " + q.location, 12, SOFT, false, 1);

  if (family !== "small") {
    w.addSpacer();
    const rest = (data.upcoming || []).slice(1, family === "large" ? 4 : 3);
    rest.forEach((r) => {
      const row = w.addStack(); row.centerAlignContent();
      text(row, shortDate(r.due_date) + "  ", 11, HOT, true);
      text(row, r.title, 11, WHITE, false, 1);
      w.addSpacer(2);
    });
    if (q.going && q.going.length) text(w, "✓ " + q.going.slice(0, 4).join(", ") + (q.going.length > 4 ? " +" + (q.going.length - 4) : ""), 11, SOFT, false, 1);
  }
  return w;
}

const data = await load();
const family = config.widgetFamily || "medium";
const widget = build(data, family);
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentMedium();   // tap Play in Scriptable to preview
Script.complete();
