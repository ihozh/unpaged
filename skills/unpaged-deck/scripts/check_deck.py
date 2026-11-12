#!/usr/bin/env python3
"""Check an Unpaged deck folder and package it as a zip.

Usage: python3 check_deck.py path/to/deck-folder [--no-zip]

Errors are things Unpaged will drop, reject or break on. Warnings need a look.
Exits 1 if there are errors; otherwise writes <folder>.zip next to the folder.
"""
import os
import re
import sys
import zipfile
from html.parser import HTMLParser

MAX_PAGE_CHARS = 900_000
MAX_ASSET = 25 * 1024 * 1024
MAX_DECK = 200 * 1024 * 1024
MAX_PAGES = 500
BASE_OVERHEAD = 9_000  # Unpaged's own styles and script, added to every page
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}


class Deck(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []          # open tags: (tag, classes)
        self.head_chars = 0
        self.title = ""
        self.pages = []          # dicts
        self.page = None
        self.quiz = None
        self.stray = []          # body content outside sections
        self.refs = []           # (attr value, line)
        self.errors = []
        self.warnings = []

    def inside(self, tag=None, cls=None):
        return any((tag is None or t == tag) and (cls is None or cls in c) for t, c in self.stack)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        classes = (a.get("class") or "").split()
        line = self.getpos()[0]
        in_body = self.inside("body")
        if tag == "section" and "slide" in classes and not self.page:
            if self.stack and self.stack[-1][0] != "body":
                self.warnings.append(f"line {line}: this slide is nested inside <{self.stack[-1][0]}>; the wrapper is dropped. Put sections directly in <body>.")
            self.page = {"line": line, "start": self.getpos(), "heading": None, "quizzes": 0, "kps": 0, "depth": len(self.stack)}
        elif in_body and not self.page and tag not in ("section",):
            self.stray.append((tag, line))
        if self.page:
            if "quiz" in classes:
                self.quiz = {"line": line, "options": 0, "correct": 0, "explain": 0, "depth": len(self.stack)}
                self.page["quizzes"] += 1
            if self.quiz and "option" in classes:
                self.quiz["options"] += 1
                if "data-correct" in a:
                    self.quiz["correct"] += 1
            if self.quiz and "explain" in classes:
                self.quiz["explain"] += 1
            if not self.quiz and "option" in classes:
                self.warnings.append(f"line {line}: .option outside a .quiz is not clickable as a quiz answer.")
            if "data-correct" in a and "option" not in classes:
                self.errors.append(f"line {line}: data-correct belongs on a .option element.")
            if "kp" in classes:
                self.page["kps"] += 1
            if "detail" in classes and not self.inside(cls="kp"):
                self.warnings.append(f"line {line}: .detail outside a .kp is never shown.")
            if tag in ("h1", "h2", "h3") and self.page["heading"] is None and not self.inside(cls="detail"):
                self.page["heading"] = ""
                self.page["_h"] = True
            if tag == "iframe":
                self.warnings.append(f"line {line}: embedded frames (YouTube and similar) may not play in Unpaged. Use a video file.")
            if tag == "a" and a.get("href", "").startswith(("http", "//")):
                self.warnings.append(f"line {line}: links do not open from an Unpaged page. Show the URL as text.")
        for name in ("src", "href", "poster", "data"):
            v = a.get(name)
            if v and not (tag == "a"):
                self.refs.append((v, line))
        for c in classes:
            if c.startswith("fb-"):
                self.errors.append(f"line {line}: class '{c}' is reserved for Unpaged.")
        if tag not in VOID:
            self.stack.append((tag, classes))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID and self.stack and self.stack[-1][0] == tag:
            self.stack.pop()

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break
        depth = len(self.stack)
        if self.page:
            self.page.pop("_h", None) if tag in ("h1", "h2", "h3") else None
            if self.quiz and depth <= self.quiz["depth"]:
                q = self.quiz
                if q["options"] < 2:
                    self.errors.append(f"line {q['line']}: quiz has {q['options']} .option element(s); it needs at least 2.")
                if q["options"] > 12:
                    self.errors.append(f"line {q['line']}: quiz has {q['options']} options; the limit is 12.")
                if q["correct"] == 0:
                    self.errors.append(f"line {q['line']}: no option is marked data-correct.")
                if q["correct"] > 1:
                    self.warnings.append(f"line {q['line']}: {q['correct']} options are marked data-correct. Students select one; keep this only if each is acceptable.")
                if q["explain"] == 0:
                    self.warnings.append(f"line {q['line']}: quiz has no .explain. Add one so the reveal says why.")
                self.quiz = None
            if tag == "section" and depth <= self.page["depth"]:
                self.page["end"] = self.getpos()
                self.pages.append(self.page)
                self.page = None

    def handle_data(self, data):
        if self.inside("title") and not self.inside("body"):
            self.title += data
        if self.page and self.page.get("_h"):
            self.page["heading"] += data
        elif self.inside("body") and not self.page and data.strip() and not self.inside("script") and not self.inside("style"):
            self.stray.append(("text", self.getpos()[0]))


def offset(text_lines, pos):
    return sum(len(l) for l in text_lines[: pos[0] - 1]) + pos[1]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 1 or not os.path.isdir(args[0]):
        sys.exit(__doc__)
    folder = os.path.abspath(args[0])
    htmls = [f for f in os.listdir(folder) if f.lower().endswith((".html", ".htm"))]
    if not htmls:
        sys.exit("error: no .html file in the folder")
    name = "index.html" if "index.html" in htmls else htmls[0]
    errors, warnings = [], []
    if len(htmls) > 1 and "index.html" not in htmls:
        errors.append(f"several HTML files and none is named index.html: {', '.join(sorted(htmls))}")
    elif name != "index.html":
        warnings.append(f"the deck is named {name}; index.html is the convention.")

    text = open(os.path.join(folder, name), encoding="utf-8").read()
    d = Deck()
    d.feed(text)
    errors += d.errors
    warnings += d.warnings
    lines = text.splitlines(keepends=True)

    if not d.pages:
        errors.append('no <section class="slide"> found.')
    if len(d.pages) > MAX_PAGES:
        errors.append(f"{len(d.pages)} pages; the limit is {MAX_PAGES}.")
    if not d.title.strip():
        warnings.append("no <title>; it is used as the deck title.")

    stray_scripts = [l for t, l in d.stray if t == "script"]
    if stray_scripts:
        errors.append(f"<script> in <body> outside a section (line {stray_scripts[0]}) is discarded. Move it into <head>.")
    stray_other = sorted({l for t, l in d.stray if t not in ("script", "text")})
    stray_text = [l for t, l in d.stray if t == "text"]
    if stray_other or stray_text:
        warnings.append(f"content in <body> outside the sections is discarded (first at line {(stray_other + stray_text)[0]}).")

    m = re.search(r"<head[^>]*>(.*?)</head>", text, re.S | re.I)
    head = m.group(1) if m else ""
    if re.search(r"\b(localStorage|sessionStorage|document\.cookie)\b", text):
        errors.append("localStorage, sessionStorage and cookies are not available in an Unpaged page.")
    if re.search(r"querySelectorAll\(\s*['\"](section|\.slide|section\.slide)['\"]", text):
        warnings.append("a script collects all slides. Each page holds one section, so deck-wide navigation or counters will not work; remove them.")
    if re.search(r"data:(image|video|audio|font)/[\w.+-]+;base64,", text):
        warnings.append("base64-embedded media found. Save it as a file in media/ instead; it inflates every page.")

    titles = {}
    for i, p in enumerate(d.pages, 1):
        size = offset(lines, p["end"]) - offset(lines, p["start"]) + len(head) + BASE_OVERHEAD
        if size > MAX_PAGE_CHARS:
            errors.append(f"page {i} (line {p['line']}) is about {size // 1000} KB with the shared <head>; the limit is {MAX_PAGE_CHARS // 1000} KB.")
        h = (p["heading"] or "").strip()
        if not h:
            warnings.append(f"page {i} (line {p['line']}) has no heading; it will be listed as 'Page {i}'.")
        else:
            titles.setdefault(h, []).append(i)
        if re.search(r":\s*answer\s*$", h, re.I):
            warnings.append(f"page {i} '{h}' looks like a separate answer page. Merge it into the quiz as .explain.")
    for h, pages in titles.items():
        if len(pages) > 1:
            warnings.append(f"pages {', '.join(map(str, pages))} share the heading '{h}'; distinct headings are easier to navigate.")

    # Media
    files, total = [], 0
    for root, dirs, names in os.walk(folder):
        dirs[:] = [x for x in dirs if not x.startswith(".") and x != "__MACOSX"]
        for n in names:
            if n.startswith("."):
                continue
            full = os.path.join(root, n)
            rel = os.path.relpath(full, folder).replace(os.sep, "/")
            if rel == name or rel.lower().endswith((".html", ".htm")):
                if rel != name:
                    warnings.append(f"{rel}: other HTML files are ignored by Unpaged.")
                    continue
            files.append((full, rel))
            if rel != name:
                size = os.path.getsize(full)
                total += size
                if size > MAX_ASSET:
                    errors.append(f"{rel} is {size / 1048576:.1f} MB; the limit per file is 25 MB.")
    if total > MAX_DECK:
        errors.append(f"media adds up to {total / 1048576:.1f} MB; the limit is 200 MB.")
    have = {rel for _, rel in files}
    css_refs = [(u, 0) for u in re.findall(r"url\(\s*['\"]?([^'\")]+)", text)]
    for ref, line in d.refs + css_refs:
        ref = ref.strip()
        if not ref or ref.startswith(("http:", "https:", "//", "data:", "#", "mailto:", "blob:", "javascript:")):
            continue
        where = f"line {line}: " if line else ""
        if ref.startswith("/") or ref.startswith("../") or re.match(r"^[a-zA-Z]:\\|^file:", ref):
            errors.append(f"{where}'{ref}' must be a relative path inside the deck folder.")
        elif ref.split("?")[0].split("#")[0] not in have:
            errors.append(f"{where}'{ref}' is referenced but the file is not in the folder.")

    quizzes = sum(p["quizzes"] for p in d.pages)
    cards = sum(p["kps"] for p in d.pages)
    print(f"{name}: {len(d.pages)} pages, {quizzes} quiz question(s), {cards} card(s), {len(files) - 1} media file(s) ({total / 1048576:.1f} MB)")
    for w in warnings:
        print("warning:", w)
    for e in errors:
        print("ERROR:", e)
    if errors:
        print(f"\n{len(errors)} error(s). Fix them and run again.")
        sys.exit(1)
    if "--no-zip" not in sys.argv:
        out = folder.rstrip("/") + ".zip"
        base = os.path.basename(folder)
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for full, rel in files:
                z.write(full, f"{base}/{rel}")
        print(f"\nOK. Packaged: {out}")
    else:
        print("\nOK.")


if __name__ == "__main__":
    main()
