# Unpaged

A Social Shields project. Interactive HTML decks in place of PDF slides, organized by course.

- Instructors each have an account. An instructor creates a course and adds decks to it.
- During a class the instructor turns the pages and every student's screen follows. Students can explore the current page but cannot change pages.
- When the instructor ends the class, the deck opens to students, who can come back at any time and browse it on their own.

## Run

```sh
npm install
npm run dev      # local: http://localhost:8787
npm run deploy   # deploy to Cloudflare (asks you to log in the first time)
```

Set the site owner's key once (use a long random one, and keep it to yourself): `npx wrangler secret put INSTRUCTOR_KEY`. For local development it is read from `.dev.vars` (`INSTRUCTOR_KEY=...`). Without it nobody can create an account.

- Instructors: `/instructor` (create an account or sign in, create a course, add decks, teach). The guide at `/guide` covers deck format and preparing a class.
- Students: enter the course code on the home page, or open `/?c=CODE`.

## Instructor accounts

The site owner creates the first account: open `/instructor`, choose **Create an account**, and enter `INSTRUCTOR_KEY` as the invitation code. That account also owns the courses created before accounts existed.

Other instructors join with an invitation code. The site owner creates codes under **Account > Invitation codes** on the course list, with a note on who each is for, and sends the instructor the link (**Copy link**) or the code. Each code makes one account. The list shows which codes have been used and by whom; a code that has not been used can be withdrawn.

With the link open, the instructor chooses a name and a password. From then on they manage their own courses without anyone's help. Each instructor sees and can change only their own courses.

There is no email, so a forgotten password is reset by the site owner:

```sh
curl -X POST https://YOUR-SITE/api/account/password \
  -d '{"name":"their-name","password":"a-new-password","key":"YOUR_INSTRUCTOR_KEY"}'
```

`INSTRUCTOR_KEY` also works by itself as a credential for the API (`Authorization: Bearer ...`), with access to every course in the Worker.

## An instructor with their own Worker

By default every instructor's courses are stored in this Worker. An instructor who wants their decks in their own Cloudflare account can arrange it without the site owner:

1. Deploy this repository to their own account (`npm install`, `npm run deploy`) and set its `INSTRUCTOR_KEY` (`npx wrangler secret put INSTRUCTOR_KEY`).
2. On this site, under **Account** on the course list, open **Keep my courses in my own Worker** and enter that Worker's address and its `INSTRUCTOR_KEY`.

Courses they create from then on are stored in their Worker, and the courses already in it are listed too. Courses created here earlier stay here. Students and the instructor keep using this site's address: this Worker passes requests for those courses along. The instructor's key is kept with their account here, since this Worker needs it to act for them. Requests still pass through this Worker and count toward this account's request limits; the storage is theirs. Their copy should be kept at the same version as this one, because the pages everyone loads come from here.

## Deck format

One HTML file, optionally with media files next to it. Each page is a `<section class="slide">`. A clickable knowledge point is a `.kp`; its details go in a nested `.detail`, which opens in a dialog on click. A quiz is a `.quiz` holding `.option` elements, the right one marked `data-correct`, with an optional `.explain`. Speaker notes for a page go in an `<aside class="notes">`. Media is referenced by relative path. Add a deck as a single `.html`, a `.zip`, or a folder. `public/guide.html` has the full description and `public/sample-deck.html` is a working example.

## Generating decks with Claude

`skills/unpaged-deck/` is a Claude skill that writes decks in this format and checks them before packaging. In Claude Code, copy the folder to `~/.claude/skills/`. In the Claude apps, upload `skills/unpaged-deck.skill`. To check a deck by hand: `python3 skills/unpaged-deck/scripts/check_deck.py path/to/deck-folder`.

## How it works

- `src/worker.js`: a Cloudflare Worker and two Durable Object classes.
  - `Course`, one per course code, stores the course's decks (each page as its own HTML document, media in 1 MB chunks) and runs the live class over WebSockets.
  - `Directory` keeps the instructor accounts, their sign-in sessions, and the list of courses with the owner of each.
- Deck status goes `draft` → `live` → `released`. Students can fetch a deck's pages only once it is `released`. While it is `live` they are sent the current page and nothing else.
- Students only read, with one exception: answering a quiz on the live page. Every other write, including page turns, is an HTTP request carrying the instructor's session. The Worker checks who is signed in, and the course checks that it belongs to them.
- Quiz answers are taken out of the page when a deck is added and stored apart from it. Students receive them when the instructor shows the answers, or once the deck is released. Answers are counted per anonymous browser id; the instructor's screen shows only how many have answered until the reveal.
- A deck can ask for RAM IDs (**Ask for RAM ID** on the deck's row; it cannot be changed during a class). While that deck is live, a student gets the pages only after entering their RAM ID, the letter R and 8 digits, which the browser then remembers. The first page each ID receives is recorded as its sign-in, and quiz answers are kept under the ID in place of the anonymous browser id. Only the course's instructor can read them: **Sign-in sheet** downloads a CSV with one row per ID, when it signed in and what it answered. Students see the same totals as before, never who answered what. The sheet covers the last class of the deck and is cleared when the deck is taught again. Once the class ends, nothing is asked for. An ID is checked for its form only; Unpaged cannot tell whose it is.
- Speaker notes (`<aside class="notes">`) are taken out of the page in the same way. Only the course's instructor can fetch them, whatever the deck's status, and they are shown beside the page while teaching. **Present** on the teaching screen goes full screen with the page only, for when the instructor's screen is the one projected; the notes come back beside the page there only when asked for (**N**). **Projector window** opens the page alone in a second window for a separate display, leaving the notes on the first. Every window an instructor has open on a live class follows the others' page turns, so a phone can serve as a remote with the notes on it.
- A live class ends when the instructor selects **End class**, or chooses to end it on leaving the teaching screen. It also ends by itself: the `Course` sets an alarm when the last instructor window disconnects during a class, and ends the class three minutes later unless one has connected again. Signing out ends any class left live.
- Deleting a course (`DELETE /api/courses/CODE`, the course's instructor only, not while a class is live) empties its `Course` and takes its code off the `Directory`. For a course kept in an instructor's own Worker the request is passed on to that Worker, which must run a version that has this.
- The instructor's browser splits a deck into pages before uploading. Pages are shown in a sandboxed iframe, so deck scripts cannot touch the surrounding app.
- The app chrome uses the shared Social Shields stylesheet (`https://socialshields.org/brand.css`).

## Limits

25 MB per media file, 200 MB of media per deck, about 900 KB of HTML per page, one live class per course at a time. Storage is the Durable Objects allowance of the Cloudflare account.
