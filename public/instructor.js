import { parseDeck, fillAssets, sendQuiz } from "/slide-runtime.js";
import { filesFromZip, filesFromFolder, pickDeck } from "/deck-loader.js";

const $ = (id) => document.getElementById(id);
// Keep these in sync with src/worker.js
const MAX_PAGE_CHARS = 900_000;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_DECK_BYTES = 200 * 1024 * 1024;
const PASSCODE_KEY = "freeboard.passcode";

const code = (new URLSearchParams(location.search).get("c") || "").toUpperCase() || null;
let passcode = "";
try {
  passcode = localStorage.getItem(PASSCODE_KEY) || "";
} catch {}

let course = null;
let pending = null; // deck chosen in the "Add a deck" form: { text, assets }
let room = null; // live class: { deckId, pages: [titles], index, quiz }
// room.quiz, when the page has one: { answered, revealed, results: [per quiz] }
const pageCache = new Map();
let ws = null;
let retryMs = 1000;
let pingTimer = null;

function show(view) {
  for (const id of ["login", "courses", "course", "room"]) $(id).hidden = id !== view;
  $("footer").hidden = view === "room";
}

// Every instructor request carries the passcode. A 401 sends you back to sign-in.
async function api(path, options = {}) {
  const res = await fetch(`/api/courses${path}`, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${passcode}` },
  });
  if (res.status === 401) {
    show("login");
    throw new Error("Wrong instructor passcode.");
  }
  if (res.status === 503) throw new Error("This site has no instructor passcode set up yet. See the README.");
  return res;
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + " MB";
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---------- Courses ----------

async function showCourses() {
  const res = await api("");
  const list = await res.json();
  $("no-courses").hidden = list.length > 0;
  $("course-list").replaceChildren(
    ...list.map((c) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.className = "open";
      a.href = `/instructor?c=${c.code}`;
      a.textContent = c.title;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = c.code;
      li.append(a, meta);
      return li;
    }),
  );
  show("courses");
}

$("new-course").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("course-error").textContent = "";
  try {
    const res = await api("", { method: "POST", body: JSON.stringify({ title: $("course-name").value }) });
    if (!res.ok) throw new Error("Could not create the course. Try again.");
    location.href = `/instructor?c=${(await res.json()).code}`;
  } catch (err) {
    $("course-error").textContent = err.message;
  }
});

// ---------- One course ----------

async function loadCourse() {
  const res = await api(`/${code}`);
  if (!res.ok) return false;
  course = await res.json();
  document.title = `${course.title} · Freeboard · Social Shields`;
  $("course-title").textContent = course.title;
  $("course-code").textContent = code;
  $("no-decks").hidden = course.decks.length > 0;
  $("deck-list").replaceChildren(...course.decks.map(deckRow));
  return true;
}

function deckRow(d) {
  const li = document.createElement("li");
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = d.title;
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = plural(d.pages, "page");
  const badge = document.createElement("span");
  badge.className = d.status === "live" ? "badge live" : "badge";
  badge.textContent = { draft: "Not taught yet", live: "Live now", released: "Open to students" }[d.status];

  const start = document.createElement("button");
  start.className = "ss-btn";
  start.textContent = d.status === "live" ? "Resume class" : d.status === "released" ? "Teach again" : "Start class";
  start.disabled = Boolean(course.live) && course.live.deckId !== d.id;
  start.onclick = () => startClass(d);

  const del = document.createElement("button");
  del.className = "btn-quiet";
  del.textContent = "Delete";
  del.disabled = d.status === "live";
  del.onclick = async () => {
    if (!confirm(`Delete “${d.title}”? Students will no longer be able to open it.`)) return;
    const res = await api(`/${code}/decks/${d.id}`, { method: "DELETE" });
    $("deck-error").textContent = res.ok ? "" : "Could not delete the deck.";
    loadCourse();
  };

  li.append(name, badge, meta, start, del);
  return li;
}

$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(`${location.origin}/?c=${code}`);
  $("copy").textContent = "Copied";
  setTimeout(() => ($("copy").textContent = "Copy student link"), 1500);
});

// ---------- Add a deck ----------

function failDeck(message) {
  pending = null;
  $("add-error").textContent = message;
  $("deck-info").textContent = "";
  $("add").disabled = true;
}

async function chooseDeck(read, fallbackTitle) {
  $("add-error").textContent = "";
  try {
    const { text, assets } = await read();
    const deck = parseDeck(text, assets.size > 0);
    const tooBig = deck.pages.findIndex((p) => p.html.length > MAX_PAGE_CHARS);
    if (tooBig >= 0) {
      return failDeck(`Page ${tooBig + 1} is too large. Put images and other media in separate files next to the deck instead of embedding them.`);
    }
    let total = 0;
    for (const [path, blob] of assets) {
      if (blob.size > MAX_ASSET_BYTES) return failDeck(`“${path}” is ${mb(blob.size)}. Each media file can be at most ${mb(MAX_ASSET_BYTES)}.`);
      total += blob.size;
    }
    if (total > MAX_DECK_BYTES) return failDeck(`This deck's media adds up to ${mb(total)}. The limit is ${mb(MAX_DECK_BYTES)}.`);

    pending = { pages: deck.pages, assets };
    $("deck-name").value = deck.title || fallbackTitle;
    $("deck-info").textContent = plural(deck.pages.length, "page") + (assets.size ? `, ${plural(assets.size, "media file")} (${mb(total)})` : "");
    $("add").disabled = false;
  } catch (err) {
    failDeck(err.message || "Could not read this deck.");
  }
}

$("file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $("folder").value = "";
  const name = file.name.replace(/\.(html?|zip)$/i, "");
  if (/\.zip$/i.test(file.name)) chooseDeck(async () => pickDeck(await filesFromZip(file)), name);
  else chooseDeck(async () => ({ text: await file.text(), assets: new Map() }), name);
});
$("folder").addEventListener("change", (e) => {
  const files = e.target.files;
  if (!files.length) return;
  $("file").value = "";
  chooseDeck(() => pickDeck(filesFromFolder(files)), (files[0].webkitRelativePath || "").split("/")[0] || "Untitled deck");
});

$("add-deck").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!pending) return;
  $("add").disabled = true;
  $("add-error").textContent = "";
  const id = crypto.randomUUID();
  const { pages, assets } = pending;
  try {
    // Media first, so the deck never appears with missing files.
    const queue = [...assets];
    let done = 0;
    const worker = async () => {
      for (let item; (item = queue.shift()); ) {
        const [path, blob] = item;
        const url = `/${code}/decks/${id}/assets/` + path.split("/").map(encodeURIComponent).join("/");
        const res = await api(url, { method: "PUT", body: blob });
        if (!res.ok) throw new Error(`Uploading “${path}” failed.`);
        $("deck-info").textContent = `Uploading media: ${++done} of ${assets.size}`;
      }
    };
    await Promise.all([worker(), worker(), worker()]);

    const res = await api(`/${code}/decks`, { method: "POST", body: JSON.stringify({ id, title: $("deck-name").value, pages }) });
    if (!res.ok) throw new Error("Could not save the deck. Try again.");
  } catch (err) {
    $("add-error").textContent = err.message;
    $("add").disabled = false;
    return;
  }
  pending = null;
  e.target.reset();
  $("deck-info").textContent = "Deck added. Students cannot open it until you have taught it.";
  loadCourse();
});

// ---------- Teaching ----------

async function startClass(d) {
  $("deck-error").textContent = "";
  const started = await api(`/${code}/decks/${d.id}/start`, { method: "POST" });
  if (!started.ok) {
    $("deck-error").textContent = started.status === 409 ? "Another class is live in this course. End it first." : "Could not start the class.";
    return;
  }
  const live = await started.json();
  const deck = await (await api(`/${code}/decks/${d.id}`)).json();
  room = { deckId: d.id, pages: deck.pages, index: -1 };
  pageCache.clear();

  $("room-title").textContent = deck.title;
  $("room-code").textContent = code;
  $("page-list").replaceChildren(
    ...deck.pages.map((title, i) => {
      const b = document.createElement("button");
      b.textContent = `${i + 1}. ${title}`;
      b.title = title;
      b.onclick = () => go(i);
      return b;
    }),
  );
  show("room");
  await go(live.index, false);
}

async function pageHtml(index) {
  if (!pageCache.has(index)) {
    const res = await api(`/${code}/decks/${room.deckId}/pages/${index}`);
    pageCache.set(index, fillAssets(await res.text(), code, room.deckId));
  }
  return pageCache.get(index);
}

async function go(index, publish = true) {
  if (!room || index < 0 || index >= room.pages.length || index === room.index) return;
  room.index = index;
  $("pos").textContent = `${index + 1} / ${room.pages.length}`;
  $("prev").disabled = index === 0;
  $("next").disabled = index === room.pages.length - 1;
  [...$("page-list").children].forEach((b, i) => {
    b.setAttribute("aria-current", String(i === index));
    if (i === index) b.scrollIntoView({ block: "nearest" });
  });
  // Students first; your own preview loads alongside.
  const sent = publish ? api(`/${code}/goto`, { method: "POST", body: JSON.stringify({ index }) }) : null;
  const html = await pageHtml(index);
  if (room?.index !== index) return;
  room.quiz = null;
  showQuiz();
  $("stage").srcdoc = html;
  if (sent && !(await sent).ok) setConn(false, "Page turn did not reach students. Try again.");
  const info = await (await api(`/${code}/decks/${room.deckId}/pages/${index}/quiz`)).json();
  if (room?.index !== index || !info.key.length) return;
  room.quiz = { answered: info.answered || 0, revealed: Boolean(info.revealed), results: info.results || [] };
  showQuiz();
}

// Quiz controls under the page: how many students have answered, and the button that shows the answers.
function showQuiz() {
  const q = room?.quiz;
  $("answered").hidden = !q;
  $("reveal").hidden = !q || q.revealed;
  if (!q) return;
  $("answered").textContent = `${q.answered} answered` + (q.revealed ? " · answers shown" : "");
  sendQuiz($("stage"), { selected: [], results: q.results });
}

$("reveal").addEventListener("click", async () => {
  const index = room.index;
  const res = await api(`/${code}/reveal`, { method: "POST" });
  if (!res.ok) return setConn(false, "Could not show the answers. Try again.");
  const results = await res.json();
  if (room?.index !== index || !room.quiz) return;
  room.quiz.revealed = true;
  room.quiz.results = results;
  showQuiz();
});

function setConn(ok, label) {
  $("dot").classList.toggle("on", ok);
  $("conn").textContent = label || (ok ? "Connected" : "Reconnecting…");
}

$("prev").addEventListener("click", () => go(room.index - 1));
$("next").addEventListener("click", () => go(room.index + 1));
$("leave").addEventListener("click", async () => {
  room = null;
  await loadCourse();
  show("course");
});
$("end").addEventListener("click", async () => {
  if (!confirm("End this class? The deck then opens to students, who can browse it on their own.")) return;
  const res = await api(`/${code}/end`, { method: "POST" });
  if (!res.ok) return setConn(false, "Could not end the class. Try again.");
  room = null;
  await loadCourse();
  show("course");
});

function onKey(key) {
  if (!room) return;
  if (key === "ArrowRight" || key === "PageDown") go(room.index + 1);
  if (key === "ArrowLeft" || key === "PageUp") go(room.index - 1);
}
document.addEventListener("keydown", (e) => {
  if (!e.target.closest("input, textarea")) onKey(e.key);
});
// Arrow keys pressed while focus is inside the page iframe.
window.addEventListener("message", (e) => {
  if (e.source !== $("stage").contentWindow || !e.data) return;
  if (e.data.freeboardKey) onKey(e.data.freeboardKey);
  if (e.data.freeboardReady) showQuiz(); // the page has loaded and asks for its quiz state
});

// The socket reports how many students are connected and how many have answered a quiz.
function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/api/courses/${code}/ws?role=instructor`);
  ws.onopen = () => {
    retryMs = 1000;
    setConn(true);
    clearInterval(pingTimer);
    pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30000);
  };
  ws.onmessage = (e) => {
    if (e.data === "pong") return;
    const msg = JSON.parse(e.data);
    if (msg.type === "count") $("count").textContent = msg.students;
    if (msg.type === "answered" && room?.quiz && msg.page === room.index) {
      room.quiz.answered = msg.count;
      showQuiz();
    }
  };
  ws.onclose = () => {
    clearInterval(pingTimer);
    setConn(false);
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 10000);
  };
}

// ---------- Sign-in and startup ----------

async function enter() {
  if (!code) return showCourses();
  await api(""); // reading a course needs no passcode, so check it here before showing instructor controls
  if (!(await loadCourse())) {
    location.href = "/instructor";
    return;
  }
  show("course");
  connect();
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  passcode = $("passcode").value;
  $("login-error").textContent = "";
  try {
    await enter();
    try {
      localStorage.setItem(PASSCODE_KEY, passcode); // remember it on this device
    } catch {}
  } catch (err) {
    $("login-error").textContent = err.message;
  }
});
$("sign-out").addEventListener("click", () => {
  try {
    localStorage.removeItem(PASSCODE_KEY);
  } catch {}
  passcode = "";
  $("passcode").value = "";
  show("login");
});

if (passcode) enter().catch(() => show("login"));
else show("login");
