import { DurableObject } from "cloudflare:workers";

// Keep the size limits in sync with public/instructor.js
const MAX_PAGE_CHARS = 900_000;
const MAX_PAGES = 500;
const CHUNK = 1024 * 1024; // media is stored in 1 MB chunks
const MAX_ASSET_BYTES = 25 * CHUNK;
const MAX_DECK_BYTES = 200 * CHUNK;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1
const MAX_QUIZZES = 20; // per page
const MAX_OPTIONS = 12; // per quiz
const MAX_VOTERS = 2000; // per page
const DECK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
  css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  json: "application/json", lottie: "application/zip", riv: "application/octet-stream", wasm: "application/wasm",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  txt: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8", vtt: "text/vtt; charset=utf-8",
  glb: "model/gltf-binary", gltf: "model/gltf+json",
};

const ASSET_HEADERS = {
  "Accept-Ranges": "bytes",
  "Cache-Control": "private, max-age=3600",
  // Slides run in an opaque-origin sandbox, so their fetch() calls are cross-origin.
  "Access-Control-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
  // If someone opens an uploaded file directly, it must not run as this site.
  "Content-Security-Policy": "sandbox",
};

const text = (body, status = 200) => new Response(body, { status });

// The list of courses, for the instructor's home page.
export class Directory extends DurableObject {
  async fetch(request) {
    if (request.method === "POST") {
      const course = await request.json();
      await this.ctx.storage.put(`course:${course.code}`, course);
      return text("ok");
    }
    const all = [...(await this.ctx.storage.list({ prefix: "course:" })).values()];
    return Response.json(all.sort((a, b) => b.created - a.created));
  }
}

// One Course per course code. It stores the course's decks (pages + media) and runs
// the live class: while a deck is live, students only ever receive the current page.
//
// A quiz page is stored without its answers. The answer key (which options are correct, and
// the explanation) is kept apart from the page and is sent to students only once the
// instructor reveals it, or once the deck is released.
//
// Deck status: "draft" (uploaded, not taught) -> "live" (being taught) -> "released"
// (taught; students may browse it freely).
export class Course extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Answered by the runtime without waking the object, so idle courses stay hibernated.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // The Worker has already checked the passcode: X-Instructor is "1" only for the instructor,
  // and every non-GET request that reaches this object comes from the instructor, except
  // POST /answer, which is a student answering a quiz.
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const instructor = request.headers.get("X-Instructor") === "1";
    const store = this.ctx.storage;
    const course = await store.get("course");

    if (path === "/init") {
      if (course) return text("exists", 409);
      const { title } = await request.json();
      await store.put("course", { title, created: Date.now() });
      await store.put("decks", []);
      return text("ok");
    }
    if (!course) return text("no such course", 404);

    const decks = (await store.get("decks")) || [];
    const live = (await store.get("live")) || null;

    if (path === "/" && method === "GET") {
      return Response.json({
        title: course.title,
        live: live && (instructor ? live : { deckId: live.deckId }),
        decks: decks.map((d) => ({
          // Students do not get the id of a deck that has not been taught yet.
          id: instructor || d.status !== "draft" ? d.id : undefined,
          title: d.title,
          pages: d.pages.length,
          status: d.status,
        })),
      });
    }

    if (path === "/ws") {
      const { 0: client, 1: server } = new WebSocketPair();
      // The role only decides who is counted as a student; it grants nothing.
      this.ctx.acceptWebSocket(server, [url.searchParams.get("role") === "instructor" ? "instructor" : "student"]);
      if (live) server.send(await this.slideMessage(decks, live));
      this.sendCount();
      return new Response(null, { status: 101, webSocket: client });
    }

    if (path === "/decks" && method === "POST") {
      const body = await request.json().catch(() => null);
      const pages = body?.pages;
      if (!body || !DECK_ID.test(body.id) || decks.some((d) => d.id === body.id)) return text("bad deck id", 400);
      if (!Array.isArray(pages) || !pages.length || pages.length > MAX_PAGES) return text("bad page count", 400);
      if (pages.some((p) => typeof p.html !== "string" || p.html.length > MAX_PAGE_CHARS)) return text("page too large", 413);
      const keys = pages.map((p) => quizKey(p.quiz));
      if (keys.includes(null)) return text("bad quiz", 400);
      for (let i = 0; i < pages.length; i++) {
        await store.put(`page:${body.id}:${i}`, pages[i].html);
        if (keys[i].length) await store.put(`quiz:${body.id}:${i}`, keys[i]);
      }
      decks.push({
        id: body.id,
        title: String(body.title || "Untitled deck").slice(0, 200),
        pages: pages.map((p, i) => String(p.title || `Page ${i + 1}`).slice(0, 200)),
        status: "draft",
        created: Date.now(),
      });
      await store.put("decks", decks);
      this.broadcast({ type: "decks" });
      return text("ok");
    }

    if (path === "/goto" && method === "POST") {
      if (!live) return text("no class is live", 409);
      const deck = decks.find((d) => d.id === live.deckId);
      const index = Number((await request.json()).index);
      if (!Number.isInteger(index) || index < 0 || index >= deck.pages.length) return text("bad page", 400);
      live.index = index;
      await store.put("live", live);
      this.broadcastRaw(await this.slideMessage(decks, live), "student");
      return text("ok");
    }

    // A student picks an option on the page that is live right now. One answer per student
    // per quiz; picking again replaces it, until the instructor reveals the answers.
    if (path === "/answer" && method === "POST") {
      const body = await request.json().catch(() => null);
      if (!live || !body || body.deckId !== live.deckId || body.page !== live.index) return text("that page is not live", 409);
      if (live.revealed?.includes(live.index)) return text("answers are already shown", 409);
      const key = await store.get(`quiz:${live.deckId}:${live.index}`);
      const { quiz, option, voter } = body;
      if (!key || !Number.isInteger(quiz) || !key[quiz] || !Number.isInteger(option) || option < 0 || option >= key[quiz].options) return text("bad answer", 400);
      if (typeof voter !== "string" || !DECK_ID.test(voter)) return text("bad answer", 400);
      const votesKey = `votes:${live.deckId}:${live.index}`;
      const votes = (await store.get(votesKey)) || {};
      if (!votes[voter] && Object.keys(votes).length >= MAX_VOTERS) return text("too many answers", 429);
      (votes[voter] ||= [])[quiz] = option;
      await store.put(votesKey, votes);
      // The instructor's screen only gets a head count: who chose what stays hidden until the reveal.
      this.broadcastRaw(JSON.stringify({ type: "answered", page: live.index, count: Object.keys(votes).length }), "instructor");
      return text("ok");
    }

    // The instructor shows the answers for the page that is live.
    if (path === "/reveal" && method === "POST") {
      if (!live) return text("no class is live", 409);
      const results = await this.quizResults(live.deckId, live.index);
      if (!results) return text("this page has no quiz", 400);
      live.revealed = [...new Set([...(live.revealed || []), live.index])];
      await store.put("live", live);
      this.broadcast({ type: "reveal", deckId: live.deckId, page: live.index, results });
      return Response.json(results);
    }

    if (path === "/end" && method === "POST") {
      if (!live) return text("ok");
      decks.find((d) => d.id === live.deckId).status = "released";
      await store.put("decks", decks);
      await store.delete("live");
      this.broadcast({ type: "end", deckId: live.deckId, index: live.index });
      return text("ok");
    }

    const m = path.match(/^\/decks\/([0-9a-f-]{36})(\/.*)?$/);
    if (!m) return text("not found", 404);
    const [, id, rest = ""] = m;
    const deck = decks.find((d) => d.id === id);

    // Media. Uploaded before the deck record exists, so it is not tied to `deck`.
    if (rest.startsWith("/assets/")) {
      let file;
      try {
        file = decodeURIComponent(rest.slice("/assets/".length)).normalize("NFC");
      } catch {
        return text("bad path", 400);
      }
      if (!file || file.length > 512 || file.split("/").some((s) => s === "" || s === "." || s === "..")) return text("bad path", 400);
      if (method === "PUT") return this.putAsset(id, file, request);
      if (method === "GET") return this.getAsset(id, file, request);
      return text("method not allowed", 405);
    }

    if (!deck) return text("no such deck", 404);
    const canRead = instructor || deck.status === "released";

    if (rest === "" && method === "GET") {
      if (!canRead) return text("this deck is not open yet", 403);
      return Response.json({ id, title: deck.title, status: deck.status, pages: deck.pages });
    }

    if (rest === "" && method === "DELETE") {
      if (live?.deckId === id) return text("end the class first", 409);
      for (const prefix of [`page:${id}:`, `quiz:${id}:`, `votes:${id}:`, `asset:${id}/`, `chunk:${id}/`]) {
        for (;;) {
          const keys = [...(await store.list({ prefix, limit: 128 })).keys()];
          if (!keys.length) break;
          await store.delete(keys);
        }
      }
      await store.delete(`bytes:${id}`);
      await store.put("decks", decks.filter((d) => d.id !== id));
      this.broadcast({ type: "decks" });
      return text("ok");
    }

    const page = rest.match(/^\/pages\/(\d+)$/);
    if (page && method === "GET") {
      if (!canRead) return text("this deck is not open yet", 403);
      const html = await store.get(`page:${id}:${page[1]}`);
      if (html === undefined) return text("no such page", 404);
      return new Response(html, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    }

    // The quiz on a page. The instructor always gets the answer key, plus how the class answered
    // while the deck is live. Students get the key once the deck is released.
    const quizPage = rest.match(/^\/pages\/(\d+)\/quiz$/);
    if (quizPage && method === "GET") {
      if (!canRead) return text("this deck is not open yet", 403);
      const n = Number(quizPage[1]);
      const key = (await store.get(`quiz:${id}:${n}`)) || [];
      const out = { key };
      if (instructor && live?.deckId === id && key.length) {
        out.answered = Object.keys((await store.get(`votes:${id}:${n}`)) || {}).length;
        out.revealed = Boolean(live.revealed?.includes(n));
        if (out.revealed) out.results = await this.quizResults(id, n);
      }
      return Response.json(out, { headers: { "Cache-Control": "no-store" } });
    }

    if (rest === "/start" && method === "POST") {
      if (live && live.deckId !== id) return text("another class is live in this course", 409);
      if (live) return Response.json(live); // resuming
      const started = { deckId: id, index: 0, revealed: [] };
      // A new class starts with no answers from the last time this deck was taught.
      const old = [...(await store.list({ prefix: `votes:${id}:` })).keys()];
      if (old.length) await store.delete(old);
      deck.status = "live";
      await store.put("decks", decks);
      await store.put("live", started);
      this.broadcastRaw(await this.slideMessage(decks, started), "student");
      this.broadcast({ type: "decks" });
      return Response.json(started);
    }

    return text("not found", 404);
  }

  async slideMessage(decks, live) {
    const deck = decks.find((d) => d.id === live.deckId);
    return JSON.stringify({
      type: "slide",
      deckId: deck.id,
      title: deck.title,
      index: live.index,
      total: deck.pages.length,
      html: await this.ctx.storage.get(`page:${deck.id}:${live.index}`),
      // Present only when the answers on this page have been shown.
      results: live.revealed?.includes(live.index) ? await this.quizResults(deck.id, live.index) : null,
    });
  }

  // Per quiz on the page: the correct options, the explanation, and how many chose each option.
  async quizResults(id, index) {
    const key = await this.ctx.storage.get(`quiz:${id}:${index}`);
    if (!key) return null;
    const votes = Object.values((await this.ctx.storage.get(`votes:${id}:${index}`)) || {});
    return key.map((q, i) => {
      const counts = new Array(q.options).fill(0);
      for (const v of votes) if (Number.isInteger(v[i])) counts[v[i]]++;
      return { correct: q.correct, explain: q.explain, counts };
    });
  }

  async putAsset(id, file, request) {
    const store = this.ctx.storage;
    const key = `${id}/${file}`;
    if (Number(request.headers.get("Content-Length")) > MAX_ASSET_BYTES) return text("file too large", 413);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > MAX_ASSET_BYTES) return text("file too large", 413);

    const prev = await store.get(`asset:${key}`);
    const used = ((await store.get(`bytes:${id}`)) || 0) - (prev?.size || 0) + bytes.length;
    if (used > MAX_DECK_BYTES) return text("deck too large", 413);

    const chunks = Math.ceil(bytes.length / CHUNK);
    for (let i = 0; i < chunks; i++) await store.put(`chunk:${key}:${i}`, bytes.slice(i * CHUNK, (i + 1) * CHUNK));
    for (let i = chunks; i < (prev?.chunks || 0); i++) await store.delete(`chunk:${key}:${i}`);
    await store.put(`asset:${key}`, { size: bytes.length, chunks });
    await store.put(`bytes:${id}`, used);
    return text("ok");
  }

  async getAsset(id, file, request) {
    const store = this.ctx.storage;
    const key = `${id}/${file}`;
    const meta = await store.get(`asset:${key}`);
    if (!meta) return text("not found", 404);

    const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
    const headers = { ...ASSET_HEADERS, "Content-Type": MIME[ext] || "application/octet-stream" };

    // Range support: Safari will not play video without it.
    let start = 0;
    let end = meta.size - 1;
    let status = 200;
    const r = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("Range") || "");
    if (r && (r[1] || r[2]) && meta.size > 0) {
      if (r[1] === "") {
        start = Math.max(0, meta.size - Number(r[2]));
      } else {
        start = Number(r[1]);
        if (r[2]) end = Math.min(end, Number(r[2]));
      }
      if (start > end) {
        return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${meta.size}` } });
      }
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${meta.size}`;
    }

    const body = new Uint8Array(end - start + 1);
    const first = Math.floor(start / CHUNK);
    const last = Math.floor(end / CHUNK);
    for (let i = first; i <= last; i++) {
      const chunk = await store.get(`chunk:${key}:${i}`);
      const from = i === first ? start - first * CHUNK : 0;
      const to = i === last ? end - last * CHUNK + 1 : chunk.length;
      body.set(chunk.subarray(from, to), i * CHUNK + from - start);
    }
    return new Response(body, { status, headers });
  }

  // Sockets are receive-only: page turns arrive over HTTP with the passcode.
  async webSocketMessage() {}

  async webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {}
    this.sendCount(ws);
  }

  async webSocketError(ws) {
    this.sendCount(ws);
  }

  broadcast(msg) {
    this.broadcastRaw(JSON.stringify(msg));
  }

  broadcastRaw(data, tag) {
    for (const s of this.ctx.getWebSockets(tag)) {
      try {
        s.send(data);
      } catch {}
    }
  }

  sendCount(leaving) {
    const students = this.ctx.getWebSockets("student").filter((s) => s !== leaving).length;
    const data = JSON.stringify({ type: "count", students });
    for (const s of this.ctx.getWebSockets("instructor")) {
      if (s === leaving) continue;
      try {
        s.send(data);
      } catch {}
    }
  }
}

// Checks the answer key uploaded with a page. Returns [] for a page without a quiz, null if malformed.
function quizKey(quiz) {
  if (quiz === undefined) return [];
  if (!Array.isArray(quiz) || quiz.length > MAX_QUIZZES) return null;
  const key = [];
  for (const q of quiz) {
    const n = q?.options;
    if (!Number.isInteger(n) || n < 1 || n > MAX_OPTIONS || !Array.isArray(q.correct)) return null;
    if (q.correct.some((c) => !Number.isInteger(c) || c < 0 || c >= n)) return null;
    key.push({ options: n, correct: q.correct, explain: String(q.explain || "").slice(0, 20_000) });
  }
  return key;
}

// Compare via digests so timing does not leak how much of the passcode matched.
async function isInstructor(request, env) {
  if (!env.INSTRUCTOR_KEY) return false;
  const given = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(env.INSTRUCTOR_KEY)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

const courseStub = (env, code) => env.COURSE.get(env.COURSE.idFromName(code));
const directory = (env) => env.DIRECTORY.get(env.DIRECTORY.idFromName("all"));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/courses(?:\/([A-Za-z0-9]{6})(\/.*)?)?$/);
    if (!m) return env.ASSETS.fetch(request);
    const code = m[1]?.toUpperCase();
    const sub = m[2] || "/";

    const instructor = await isInstructor(request, env);
    // Students may read, and answer the quiz on the live page. Everything else, and the course
    // list, needs the instructor passcode.
    const answering = Boolean(code) && request.method === "POST" && sub === "/answer";
    if ((request.method !== "GET" && !answering) || !code) {
      // Fails closed: without a configured passcode nobody can manage courses.
      if (!env.INSTRUCTOR_KEY) return text("INSTRUCTOR_KEY is not configured", 503);
      if (!instructor) return text("wrong passcode", 401);
    }

    if (!code) {
      if (request.method === "GET") return directory(env).fetch("https://directory/");
      if (request.method !== "POST") return text("method not allowed", 405);
      const title = String((await request.json().catch(() => ({}))).title || "").trim().slice(0, 120);
      if (!title) return text("a course needs a title", 400);
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = [...crypto.getRandomValues(new Uint8Array(6))].map((n) => CODE_ALPHABET[n % 32]).join("");
        const res = await courseStub(env, candidate).fetch("https://course/init", { method: "POST", body: JSON.stringify({ title }) });
        if (!res.ok) continue;
        const course = { code: candidate, title, created: Date.now() };
        await directory(env).fetch("https://directory/", { method: "POST", body: JSON.stringify(course) });
        return Response.json(course);
      }
      return text("could not allocate a course code", 503);
    }

    if (sub === "/ws" && request.headers.get("Upgrade") !== "websocket") return text("expected websocket", 426);
    const forwarded = new Request("https://course" + sub + url.search, request);
    forwarded.headers.delete("X-Instructor");
    if (instructor) forwarded.headers.set("X-Instructor", "1");
    return courseStub(env, code).fetch(forwarded);
  },
};
