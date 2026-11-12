---
name: unpaged-deck
description: Create or convert lecture slides into an Unpaged deck, the interactive HTML slide format used in class in place of PowerPoint or PDF. Use this skill whenever the user asks for slides, a deck, courseware, a lecture or lesson for Unpaged, wants a PPT, PDF, chapter or notes turned into an interactive HTML deck, or asks to add knowledge-point cards, quiz questions, animation or media to a deck that will be shown in Unpaged, even if they only say "make the slides for module 5" in a project that uses Unpaged.
---

# Unpaged deck

Unpaged shows an HTML deck in class. The instructor turns the pages and every student's
screen follows; students interact with the current page on their own device, and can browse
the whole deck after class. Your job is to produce a deck that Unpaged can load and that
uses its interactions well.

A deck is **one HTML file plus optional media files**, delivered as a folder and a `.zip` of it.

## How Unpaged loads a deck (this explains most of the rules)

When a deck is added, Unpaged splits it. Each page becomes its own small document made of:
Unpaged's base stylesheet, then the deck's whole `<head>`, then **one** `<section>`, then
Unpaged's script for cards and quizzes. That document runs in a sandboxed frame.

Consequences:

- **Only `<head>` and the sections survive.** Anything in `<body>` outside a
  `<section class="slide">` (a wrapper div, a script at the end of the body, a nav bar) is
  thrown away. Put shared CSS and JavaScript in `<head>`. A `<script>` inside a section is
  kept and runs only on that page.
- **A page never sees the other pages.** Scripts must work when the document holds a single
  section: wait for `DOMContentLoaded`, and check that an element exists before using it.
  Do not write slide navigation, keyboard paging, progress bars or "slide 3 of 20" logic.
  Unpaged does the paging. A page number, if wanted, is plain text in the section.
- **Nothing carries over between pages**, and `localStorage`, `sessionStorage` and cookies
  are not available in the sandbox. Each page starts fresh every time it is opened.
- **Links do not leave the page.** Popups and top-level navigation are blocked, so write a
  URL out as text rather than relying on a clickable link.
- **Only page turns and quiz results are synchronised.** A video, an animation or a custom
  interaction plays separately on each student's device.

## Structure

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Deck title</title>
  <style>/* optional: applies to every page */</style>
</head>
<body>

<section class="slide">
  <h1>Deck title</h1>
  <p>One line on what this lesson covers.</p>
</section>

<section class="slide">
  <h2>Page heading</h2>
  ...
</section>

</body>
</html>
```

- Every page is a `<section class="slide">` directly in `<body>`, in presentation order.
- The first heading in a section names the page in the instructor's page list, so give every
  page a distinct, meaningful heading.
- `<title>` becomes the suggested deck title.

`assets/template.html` is a working starting point with one page of each kind. Copy it
rather than writing the skeleton from memory.

## Knowledge-point cards

Use a card when a page lists a few ideas and each has detail worth reading but not worth a
page of its own. The card shows a title and a one-line summary; selecting it opens the
detail in a dialog.

```html
<div class="kps">
  <div class="kp">
    <h3>Fail-secure</h3>
    <p>Stays locked when power is lost</p>
    <div class="detail">
      <h2>Fail-secure</h2>
      <p>Used where protecting the asset outweighs free exit, such as a server room.</p>
    </div>
  </div>
  <!-- more .kp -->
</div>
```

- `.kps` lays the cards out in a grid. Two to six cards per page reads well.
- `.detail` can hold anything: text, an image, a video, a worked example.
- The card's visible text should make sense on its own, because not every student opens it.

## Quiz questions

Unpaged runs multiple-choice questions live: students pick an option, the instructor sees
how many have answered and then shows the answers, and every screen marks the correct
option, the share of students on each option, and the explanation.

```html
<div class="quiz">
  <p>A server-room door must stay locked if power fails. Which lock type is this?</p>
  <button class="option">a. Fail-safe</button>
  <button class="option" data-correct>b. Fail-secure</button>
  <button class="option">c. Fail-open</button>
  <button class="option">d. Fail-soft</button>
  <div class="explain">A fail-secure lock stays locked when power is lost.</div>
</div>
```

- Mark the right option with `data-correct`. Students select one option, so mark exactly one
  unless two options are both acceptable.
- **Do not add a separate "Answer" page** after a quiz. The reveal shows the answer and the
  `.explain` on the same page; a following answer page repeats it. When converting slides
  that have question/answer page pairs, merge each pair into one quiz page.
- Only multiple choice is supported. Rewrite a fill-in-the-blank or short-answer question as
  multiple choice with plausible distractors, or, if it must stay open-ended, make it a
  discussion page (question as text, a hint in a `.kp` card).
- Two to twelve options; four is typical. Up to 20 quizzes on a page, though one per page is
  clearest, since the instructor reveals a whole page at once.
- Unpaged removes `data-correct` and `.explain` from what students receive until the
  reveal. Do not repeat the answer elsewhere on the page (a hidden span, a comment, a script
  variable), or students can find it.
- Put a quiz after every block of new material, roughly every 6 to 10 pages, unless the user
  asks for a different rhythm.

## Styling

Unpaged's base stylesheet already styles `h1`, `h2`, `h3`, `p`, `li`, `.kps`, `.kp`,
`.quiz`, `.option` and the dialog, in the Social Shields look (green headings, neutral
surfaces). A deck with no CSS at all looks finished, so start there and add CSS only for
what the lesson needs: a diagram layout, a formula block, a two-column page.

- Pages are seen on a projector and on phones. Use fluid sizes (`clamp()`, `%`, `vw`,
  `flex-wrap`, `grid` with `auto-fit`) rather than fixed pixel canvases. Aim for one screen
  of content per page at projector size; a page may scroll on a phone.
- If you do build a fixed-size slide canvas, size everything in the deck, including
  `.option`, `.fb-notes` and `.fb-explain`, in the same units, or the quiz will look
  mismatched.
- Class names starting with `fb-` belong to Unpaged. Do not define your own.
- Respect `prefers-reduced-motion` for animation.

## Media and animation

```
my-lesson/
  index.html
  media/
    cell.svg
    demo.mp4
```

```html
<img src="media/cell.svg" alt="A plant cell">
<video src="media/demo.mp4" controls></video>
```

- Reference media by relative path. Name the deck `index.html`.
- Do not embed images as base64: a page, including its copy of the `<head>`, must stay under
  about 900 KB.
- Prefer SVG for diagrams (draw them yourself when there is no source image) and CSS for
  simple animation; neither needs extra files. Use video files rather than YouTube embeds,
  which may not play in the sandbox.
- Limits: 25 MB per media file, 200 MB per deck, 500 pages.
- Speaker notes can go in `<aside class="notes">` with `.notes{display:none}`. They are sent
  to students along with the page, so never put quiz answers in them.

## Workflow

1. **Get the content.** Use the material the user provides (slides, a chapter, notes). When
   converting an existing deck, keep its content and order; change structure only where the
   format requires it (merging answer pages into quizzes, removing navigation scripts).
2. **Plan the pages**: a title page, then for each idea either a plain page, a page of
   cards, or a quiz. State the plan briefly if the deck is long.
3. **Write** `index.html` in a new folder, with media in `media/`.
4. **Check and package** with the bundled script. It verifies the rules above and writes the
   zip next to the folder:

   ```
   python3 scripts/check_deck.py path/to/my-lesson
   ```

   Fix every error it reports and rerun until it passes. Warnings are judgment calls; read
   them.
5. **Hand over** the path of the zip, the page count and the number of quizzes, and tell the
   user to add the zip under "Add a deck" on the course's instructor page. Mention anything
   you changed from the source, such as questions rewritten as multiple choice.
