import { fillAssets, sendQuiz } from "/slide-runtime.js";

const $ = (id) => document.getElementById(id);

let code = null;
let course = null;
let mode = "home"; // "home" | "live" | "review"
let review = null; // { id, title, pages: [titles], index }
let ws = null;
let retryMs = 1000;
let pingTimer = null;

// Quiz on the page being shown: { deckId, page, selected: [option per quiz], results: [per quiz], key }.
// `key` (the answers) is only known in review, after the deck has been released.
let quiz = null;
const mine = new Map(); // this student's answers in the live class, by "deckId:page"

// An anonymous id for this browser, so answering again replaces the earlier answer.
let voter = crypto.randomUUID();
try {
  voter = localStorage.getItem("freeboard.voter") || voter;
  localStorage.setItem("freeboard.voter", voter);
} catch {}

function show(view) {
  $("join").hidden = view !== "join";
  $("course").hidden = view !== "course";
  $("viewer").hidden = view !== "viewer";
  $("footer").hidden = view === "viewer";
}

function renderCourse() {
  document.title = `${course.title} · Freeboard · Social Shields`;
  $("course-title").textContent = course.title;
  $("no-decks").hidden = course.decks.length > 0;
  $("decks").replaceChildren(
    ...course.decks.map((d) => {
      const li = document.createElement("li");
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = `${d.pages} ${d.pages === 1 ? "page" : "pages"}`;
      if (d.status === "released") {
        const b = document.createElement("button");
        b.className = "open";
        b.textContent = d.title;
        b.onclick = () => openReview(d.id, 0);
        li.append(b, meta);
      } else {
        li.className = "locked";
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = d.title;
        const badge = document.createElement("span");
        badge.className = d.status === "live" ? "badge live" : "badge";
        badge.textContent = d.status === "live" ? "Live now" : "Not taught yet";
        li.append(name, badge, meta);
      }
      return li;
    }),
  );
}

async function loadCourse() {
  const res = await fetch(`/api/courses/${code}`);
  if (!res.ok) return false;
  course = await res.json();
  renderCourse();
  return true;
}

function goHome() {
  mode = "home";
  review = null;
  show("course");
  loadCourse();
}

// Live: the instructor's current page. No navigation for students.
function showLive(msg) {
  mode = "live";
  review = null;
  $("deck-title").textContent = msg.title;
  quiz = { deckId: msg.deckId, page: msg.index, selected: mine.get(`${msg.deckId}:${msg.index}`) || [], results: msg.results || [] };
  $("stage").srcdoc = fillAssets(msg.html, code, msg.deckId);
  $("status").textContent = `Page ${msg.index + 1} of ${msg.total}`;
  $("live-badge").hidden = false;
  $("back").hidden = true;
  $("nav").hidden = true;
  show("viewer");
}

// Review: a deck that has been taught. Students turn pages themselves.
async function openReview(id, index) {
  const res = await fetch(`/api/courses/${code}/decks/${id}`);
  if (!res.ok) return goHome();
  const deck = await res.json();
  mode = "review";
  review = { id, title: deck.title, pages: deck.pages, index: 0 };
  $("deck-title").textContent = deck.title;
  $("live-badge").hidden = true;
  $("back").hidden = false;
  $("nav").hidden = false;
  $("status").textContent = "";
  show("viewer");
  await goTo(Math.min(index, deck.pages.length - 1));
}

async function goTo(index) {
  if (mode !== "review" || index < 0 || index >= review.pages.length) return;
  const deckId = review.id;
  const [res, keyRes] = await Promise.all([
    fetch(`/api/courses/${code}/decks/${deckId}/pages/${index}`),
    fetch(`/api/courses/${code}/decks/${deckId}/pages/${index}/quiz`),
  ]);
  if (!res.ok || mode !== "review" || review.id !== deckId) return;
  review.index = index;
  quiz = { deckId, page: index, selected: [], results: [], key: keyRes.ok ? (await keyRes.json()).key : [] };
  $("stage").srcdoc = fillAssets(await res.text(), code, deckId);
  $("pos").textContent = `${index + 1} / ${review.pages.length}`;
  $("prev").disabled = index === 0;
  $("next").disabled = index === review.pages.length - 1;
}

// The student picked an option. In a live class the answer goes to the instructor and can be
// changed until the answers are shown. In review the answer is checked on the spot.
function answer(q, option) {
  if (!quiz || quiz.results[q]) return;
  quiz.selected[q] = option;
  if (mode === "live") {
    mine.set(`${quiz.deckId}:${quiz.page}`, quiz.selected);
    fetch(`/api/courses/${code}/answer`, {
      method: "POST",
      body: JSON.stringify({ deckId: quiz.deckId, page: quiz.page, quiz: q, option, voter }),
    }).catch(() => {});
  } else if (quiz.key?.[q]) {
    quiz.results[q] = { correct: quiz.key[q].correct, explain: quiz.key[q].explain };
  }
  sendQuiz($("stage"), quiz);
}

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/api/courses/${code}/ws`);

  ws.onopen = () => {
    retryMs = 1000;
    clearInterval(pingTimer);
    pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30000);
  };

  ws.onmessage = (e) => {
    if (e.data === "pong") return;
    const msg = JSON.parse(e.data);
    if (msg.type === "slide") {
      showLive(msg);
    } else if (msg.type === "reveal") {
      if (mode === "live" && quiz?.deckId === msg.deckId && quiz.page === msg.page) {
        quiz.results = msg.results;
        sendQuiz($("stage"), quiz);
      }
    } else if (msg.type === "end") {
      mine.clear();
      // The class is over: this deck is now open, so stay on the same page and hand over the controls.
      if (mode === "live") openReview(msg.deckId, msg.index);
      else loadCourse();
    } else if (msg.type === "decks" && mode === "home") {
      loadCourse();
    }
  };

  ws.onclose = () => {
    clearInterval(pingTimer);
    if (mode === "live") $("status").textContent = "Connection lost. Reconnecting…";
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 10000);
  };
}

async function join(value) {
  value = value.trim().toUpperCase();
  $("join-error").textContent = "";
  if (!/^[A-Z0-9]{6}$/.test(value)) {
    $("join-error").textContent = "A course code is 6 letters and numbers.";
    return show("join");
  }
  code = value;
  let found;
  try {
    found = await loadCourse();
  } catch {
    $("join-error").textContent = "Network error. Try again.";
    return show("join");
  }
  if (!found) {
    $("join-error").textContent = "No course found with that code.";
    return show("join");
  }
  history.replaceState(null, "", `/?c=${code}`);
  show("course");
  connect(); // if a class is live, the first message switches to it
}

$("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  join($("code").value);
});
$("back").addEventListener("click", goHome);
$("prev").addEventListener("click", () => goTo(review.index - 1));
$("next").addEventListener("click", () => goTo(review.index + 1));

function onKey(key) {
  if (mode !== "review") return;
  if (key === "ArrowRight" || key === "PageDown") goTo(review.index + 1);
  if (key === "ArrowLeft" || key === "PageUp") goTo(review.index - 1);
}
document.addEventListener("keydown", (e) => {
  if (!e.target.closest("input, textarea")) onKey(e.key);
});
// Arrow keys pressed while focus is inside the page iframe.
window.addEventListener("message", (e) => {
  if (e.source !== $("stage").contentWindow || !e.data) return;
  if (e.data.freeboardKey) onKey(e.data.freeboardKey);
  if (e.data.freeboardReady && quiz) sendQuiz($("stage"), quiz); // the page has loaded and asks for its quiz state
  if (e.data.freeboardAnswer) answer(Number(e.data.freeboardAnswer.quiz), Number(e.data.freeboardAnswer.option));
});

const fromUrl = new URLSearchParams(location.search).get("c");
if (fromUrl) {
  $("code").value = fromUrl;
  join(fromUrl);
} else {
  show("join");
}
