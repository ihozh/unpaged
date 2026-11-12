# Freeboard

A Social Shields project. Interactive HTML decks in place of PDF slides, organized by course.

- An instructor creates a course and adds decks to it.
- During a class the instructor turns the pages and every student's screen follows. Students can explore the current page but cannot change pages.
- When the instructor ends the class, the deck opens to students, who can come back at any time and browse it on their own.

## Run

```sh
npm install
npm run dev      # local: http://localhost:8787
npm run deploy   # deploy to Cloudflare (asks you to log in the first time)
```

Set the instructor passcode once (use a long random one): `npx wrangler secret put INSTRUCTOR_KEY`. For local development it is read from `.dev.vars` (`INSTRUCTOR_KEY=...`). Without it, nobody can manage courses.

- Instructors: `/instructor` (sign in, create a course, add decks, teach). The guide at `/guide` covers deck format and preparing a class.
- Students: enter the course code on the home page, or open `/?c=CODE`.

## Deck format

One HTML file, optionally with media files next to it. Each page is a `<section class="slide">`. A clickable knowledge point is a `.kp`; its details go in a nested `.detail`, which opens in a dialog on click. A quiz is a `.quiz` holding `.option` elements, the right one marked `data-correct`, with an optional `.explain`. Media is referenced by relative path. Add a deck as a single `.html`, a `.zip`, or a folder. `public/guide.html` has the full description and `public/sample-deck.html` is a working example.

## Generating decks with Claude

`skills/freeboard-deck/` is a Claude skill that writes decks in this format and checks them before packaging. In Claude Code, copy the folder to `~/.claude/skills/`. In the Claude apps, upload `skills/freeboard-deck.skill`. To check a deck by hand: `python3 skills/freeboard-deck/scripts/check_deck.py path/to/deck-folder`.

## How it works

- `src/worker.js`: a Cloudflare Worker and two Durable Object classes.
  - `Course`, one per course code, stores the course's decks (each page as its own HTML document, media in 1 MB chunks) and runs the live class over WebSockets.
  - `Directory` keeps the list of courses for the instructor page.
- Deck status goes `draft` → `live` → `released`. Students can fetch a deck's pages only once it is `released`. While it is `live` they are sent the current page and nothing else.
- Students only read, with one exception: answering a quiz on the live page. Every other write, including page turns, is an HTTP request carrying the instructor passcode, which the Worker checks before anything reaches a Durable Object.
- Quiz answers are taken out of the page when a deck is added and stored apart from it. Students receive them when the instructor shows the answers, or once the deck is released. Answers are counted per anonymous browser id; the instructor's screen shows only how many have answered until the reveal.
- The instructor's browser splits a deck into pages before uploading. Pages are shown in a sandboxed iframe, so deck scripts cannot touch the surrounding app.
- The app chrome uses the shared Social Shields stylesheet (`https://socialshields.org/brand.css`).

## Limits

25 MB per media file, 200 MB of media per deck, about 900 KB of HTML per page, one live class per course at a time. Storage is the Durable Objects allowance of the Cloudflare account.
