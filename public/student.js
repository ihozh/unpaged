import { fillAssets, sendQuiz, printDeck } from "/slide-runtime.js";

const $ = (id) => document.getElementById(id);

let code = null;
let course = null;
let mode = "home"; // "home" | "live" | "review"
let review = null; // { id, title, pages: [titles], index }
let ws = null;
let retryMs = 1000;
let pingTimer = null;
const OUTLINE_KEY = "unpaged.outline"; // "off" once you close the outline on a wide screen
const PDF_HINT = "Opens the print dialog. Choose “Save as PDF” there.";
const narrow = matchMedia("(max-width: 820px)"); // here the outline opens over the page

// Quiz on the page being shown: { deckId, page, selected: [option per quiz], results: [per quiz], key }.
// `key` (the answers) is only known in review, after the deck has been released.
let quiz = null;
const mine = new Map(); // this student's answers in the live class, by "deckId:page"

// An anonymous id for this browser, so answering again replaces the earlier answer.
let voter = crypto.randomUUID();
try {
  voter = localStorage.getItem("unpaged.voter") || voter;
  localStorage.setItem("unpaged.voter", voter);
} catch {}

function show(view) {
  $("join").hidden = view !== "join";
  $("course").hidden = view !== "course";
  $("viewer").hidden = view !== "viewer";
  $("footer").hidden = view === "viewer";
}

function renderCourse() {
  document.title = `${course.title} · Unpaged · Social Shields`;
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
        const pdf = document.createElement("button");
        pdf.className = "btn-quiet";
        pdf.textContent = "Save as PDF";
        pdf.title = PDF_HINT;
        pdf.onclick = () => savePdf({ id: d.id, title: d.title, count: d.pages }, pdf);
        li.append(b, meta, pdf);
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
  $("outline").hidden = true;
  $("pdf").hidden = true;
  setOutline(false);
  show("viewer");
}

// The outline lists every page of a deck in review. It is not offered during a live class,
// where students only know about the page the instructor is on.
function setOutline(open) {
  $("viewer").classList.toggle("with-list", open);
  $("page-list").hidden = !open;
  $("outline").setAttribute("aria-expanded", String(open));
}
$("outline").addEventListener("click", () => {
  const open = $("page-list").hidden;
  setOutline(open);
  if (open) $("page-list").querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  if (narrow.matches) return; // on a narrow screen it always starts closed
  try {
    localStorage.setItem(OUTLINE_KEY, open ? "on" : "off");
  } catch {}
});

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
  $("page-list").replaceChildren(
    ...deck.pages.map((title, i) => {
      const b = document.createElement("button");
      b.textContent = `${i + 1}. ${title}`;
      b.title = title;
      b.onclick = () => {
        if (narrow.matches) setOutline(false);
        goTo(i);
      };
      return b;
    }),
  );
  $("outline").hidden = false;
  $("pdf").hidden = false;
  $("pdf").title = PDF_HINT;
  $("pdf").textContent = "Save as PDF";
  let wanted = !narrow.matches;
  try {
    wanted = wanted && localStorage.getItem(OUTLINE_KEY) !== "off";
  } catch {}
  setOutline(wanted);
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
  [...$("page-list").children].forEach((b, i) => {
    b.setAttribute("aria-current", String(i === index));
    if (i === index && !$("page-list").hidden) b.scrollIntoView({ block: "nearest" });
  });
}

// Save as PDF: the whole deck goes into one hidden document, which prints itself. The browser's
// print dialog does the saving. Quiz answers are included: a deck in review is already open.
// Offered on the course page and in the viewer, for released decks only; the server does not
// hand out a deck's pages before that. deck: { id, title, count }.
let printFrame = null;
async function savePdf(deck, button) {
  button.disabled = true;
  button.textContent = "Preparing…";
  try {
    const base = `/api/courses/${code}/decks/${deck.id}/pages/`;
    const pages = new Array(deck.count);
    let next = 0;
    const worker = async () => {
      for (let i; (i = next++) < pages.length; ) {
        const res = await fetch(base + i);
        if (!res.ok) throw new Error("page");
        const html = fillAssets(await res.text(), code, deck.id);
        let key = [];
        if (/class\s*=\s*["'][^"']*\bquiz\b/.test(html)) {
          const keyRes = await fetch(`${base}${i}/quiz`);
          if (keyRes.ok) key = (await keyRes.json()).key;
        }
        pages[i] = { html, key };
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    printFrame?.remove();
    printFrame = document.createElement("iframe");
    printFrame.className = "print-frame";
    // Same sandbox as a page, plus allow-modals, which is what lets it open the print dialog.
    printFrame.setAttribute("sandbox", "allow-scripts allow-modals");
    printFrame.setAttribute("aria-hidden", "true");
    printFrame.tabIndex = -1;
    printFrame.srcdoc = printDeck(deck.title, pages);
    document.body.append(printFrame);
    button.textContent = "Save as PDF";
  } catch {
    button.textContent = "Could not prepare the PDF. Try again";
  }
  button.disabled = false;
}
$("pdf").addEventListener("click", () => {
  if (mode === "review") savePdf({ id: review.id, title: review.title, count: review.pages.length }, $("pdf"));
});

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
  if (printFrame && e.source === printFrame.contentWindow && e.data?.unpagedPrinted) {
    printFrame.remove();
    printFrame = null;
    return;
  }
  if (e.source !== $("stage").contentWindow || !e.data) return;
  if (e.data.unpagedKey) onKey(e.data.unpagedKey);
  if (e.data.unpagedReady && quiz) sendQuiz($("stage"), quiz); // the page has loaded and asks for its quiz state
  if (e.data.unpagedAnswer) answer(Number(e.data.unpagedAnswer.quiz), Number(e.data.unpagedAnswer.option));
});

const fromUrl = new URLSearchParams(location.search).get("c");
if (fromUrl) {
  $("code").value = fromUrl;
  join(fromUrl);
} else {
  show("join");
}
