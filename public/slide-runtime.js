// Turns a deck HTML file into standalone per-page documents, and prepares stored
// pages for display. Each page document = base styles + the deck's own <head> +
// one <section> + the knowledge-point runtime.

// Stored pages carry this placeholder instead of a real URL, so decks keep working
// if the site moves to another domain. fillAssets() swaps it in at display time.
export const ASSET_PLACEHOLDER = "%%UNPAGED_ASSETS%%";

export function fillAssets(html, code, deckId) {
  return html.replaceAll(ASSET_PLACEHOLDER, `${location.origin}/api/courses/${code}/decks/${deckId}/assets/`);
}

// Default look for pages, following the Social Shields style guide. Decks can override all of it.
const BASE_CSS = `
@import url("https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700..800&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Serif:wght@500;600&display=swap");
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{font-family:"IBM Plex Sans","Helvetica Neue",Arial,system-ui,sans-serif;background:#f8f8f8;color:#1b1b1b;line-height:1.6;-webkit-font-smoothing:antialiased}
.slide{min-height:100%;padding:clamp(20px,5vw,72px);display:flex;flex-direction:column;justify-content:center;gap:clamp(12px,2.2vw,28px)}
h1,h2{font-family:"Bricolage Grotesque","Arial Black","Helvetica Neue",Arial,sans-serif;font-weight:800;letter-spacing:-.02em;color:#006456;margin:0;text-wrap:balance}
h1{font-size:clamp(34px,6.4vw,76px);line-height:1}
h2{font-size:clamp(26px,3.8vw,44px);line-height:1.1}
h3{font:600 clamp(17px,2vw,22px)/1.35 "IBM Plex Serif",Georgia,serif;color:#070707;margin:0}
p,li{font-size:clamp(16px,1.9vw,22px);margin:0}
img,video{max-width:100%}
::selection{background:#ffba00;color:#070707}
.kps{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:16px}
.kp{cursor:pointer;border:1px solid rgba(7,7,7,.1);border-radius:14px;padding:18px 20px;background:#fdfdfd;display:flex;flex-direction:column;gap:6px;transition:transform .2s cubic-bezier(.2,.8,.2,1),border-color .2s}
.kp:hover,.kp:focus-visible{border-color:#006f71;transform:translateY(-2px)}
.kp:focus-visible{outline:2px solid #006f71;outline-offset:2px}
.kp::after{content:"View details →";font-size:14px;font-weight:600;color:#006456;margin-top:auto;padding-top:6px}
.kp>.detail{display:none}
.fb-overlay{position:fixed;inset:0;background:rgba(7,7,7,.5);display:flex;align-items:center;justify-content:center;padding:16px;z-index:9999}
.fb-panel{position:relative;background:#fdfdfd;border-radius:22px;width:min(760px,100%);max-height:88vh;overflow:auto;padding:clamp(20px,4vw,36px);display:flex;flex-direction:column;gap:12px}
.fb-close{position:absolute;top:8px;right:10px;width:44px;height:44px;border:0;border-radius:999px;background:none;font-size:26px;line-height:1;cursor:pointer;color:#585858}
.fb-close:hover{background:#e4e4e4;color:#070707}
.fb-close:focus-visible{outline:2px solid #006f71;outline-offset:2px}
.quiz{display:grid;gap:10px;max-width:820px}
.option{display:flex;align-items:center;justify-content:space-between;gap:8px 14px;flex-wrap:wrap;width:100%;min-height:52px;padding:12px 18px;text-align:left;font:inherit;font-size:clamp(16px,1.9vw,22px);color:#1b1b1b;border:1px solid rgba(7,7,7,.1);border-radius:14px;background:#fdfdfd linear-gradient(to right,rgba(0,100,86,.13) var(--fb-share,0%),transparent 0);cursor:pointer;transition:border-color .2s}
.option:hover{border-color:#006f71}
.option:focus-visible{outline:2px solid #006f71;outline-offset:2px}
.option.fb-selected{border-color:#006456;box-shadow:inset 0 0 0 1px #006456}
.fb-revealed .option{cursor:default}
.fb-revealed .option:hover{border-color:rgba(7,7,7,.1)}
.fb-revealed .option.fb-selected:hover,.fb-revealed .option.fb-correct,.fb-revealed .option.fb-correct:hover{border-color:#006456}
.fb-revealed .option.fb-selected:not(.fb-correct),.fb-revealed .option.fb-selected:not(.fb-correct):hover{border-color:#9b2c1b;box-shadow:inset 0 0 0 1px #9b2c1b}
.fb-notes{display:flex;align-items:center;gap:8px;margin-left:auto;font-size:14px;font-weight:600;white-space:nowrap}
.fb-notes:empty{display:none}
.fb-tag{padding:3px 10px;border-radius:999px;border:1px solid rgba(7,7,7,.1);background:#fdfdfd;color:#585858}
.fb-tag.fb-right{background:#006456;border-color:#006456;color:#fff}
.fb-tag.fb-miss{border-color:#9b2c1b;color:#9b2c1b}
.fb-count{color:#585858;font-variant-numeric:tabular-nums}
.fb-explain{border-top:1px solid rgba(7,7,7,.1);padding-top:12px}
.fb-explain:empty{display:none}
@media (prefers-reduced-motion:reduce){.kp,.option{transition:none}}
`;

// Runs inside each page iframe.
const RUNTIME_JS = `
(function(){
  var overlay=null,opener=null;
  function close(){ if(!overlay)return; overlay.remove(); overlay=null; if(opener)opener.focus(); }
  function open(kp){
    var d=kp.querySelector(':scope > .detail'); if(!d)return;
    close(); opener=kp;
    overlay=document.createElement('div'); overlay.className='fb-overlay';
    var panel=document.createElement('div'); panel.className='fb-panel';
    panel.setAttribute('role','dialog'); panel.setAttribute('aria-modal','true');
    panel.innerHTML='<button class="fb-close" aria-label="Close">×</button>'+d.innerHTML;
    overlay.appendChild(panel); document.body.appendChild(overlay);
    panel.querySelector('.fb-close').focus();
  }
  document.querySelectorAll('.kp').forEach(function(kp){
    kp.tabIndex=0; kp.setAttribute('role','button');
  });
  // Quizzes. The page never holds the answers: the app around it says what is selected and,
  // once the answers are shown, which options are correct and how the class answered.
  var quizzes=[].slice.call(document.querySelectorAll('.quiz')).map(function(q){
    var opts=[].slice.call(q.querySelectorAll('.option'));
    opts.forEach(function(o){
      if(o.tagName!=='BUTTON'){ o.tabIndex=0; o.setAttribute('role','button'); }
      var n=document.createElement('span'); n.className='fb-notes'; o.appendChild(n);
    });
    var ex=document.createElement('div'); ex.className='fb-explain'; q.appendChild(ex);
    return {el:q,opts:opts,explain:ex,done:false};
  });
  function tag(cls,text){ return '<span class="fb-tag '+cls+'">'+text+'</span>'; }
  function paint(state){
    quizzes.forEach(function(q,i){
      var sel=state.selected?state.selected[i]:null, res=state.results?state.results[i]:null;
      q.done=!!res; q.el.classList.toggle('fb-revealed',q.done);
      var total=res&&res.counts?res.counts.reduce(function(a,b){return a+b;},0):0;
      q.opts.forEach(function(o,j){
        var mine=sel===j, right=!!res&&res.correct.indexOf(j)>=0;
        o.classList.toggle('fb-selected',mine); o.classList.toggle('fb-correct',right);
        o.setAttribute('aria-pressed',String(mine));
        if(q.done) o.setAttribute('aria-disabled','true'); else o.removeAttribute('aria-disabled');
        var html='';
        if(res&&res.counts){ var c=res.counts[j]||0, pct=total?Math.round(c*100/total):0; o.style.setProperty('--fb-share',pct+'%'); html+='<span class="fb-count">'+c+' · '+pct+'%</span>'; }
        else o.style.removeProperty('--fb-share');
        if(right) html+=tag('fb-right','Correct');
        if(mine) html+=tag(res&&!right?'fb-miss':'','Your answer');
        o.querySelector('.fb-notes').innerHTML=html;
      });
      q.explain.innerHTML=res&&res.explain?res.explain:'';
    });
  }
  function choose(o){
    for(var i=0;i<quizzes.length;i++){
      var j=quizzes[i].opts.indexOf(o);
      if(j>=0){ if(!quizzes[i].done) parent.postMessage({unpagedAnswer:{quiz:i,option:j}},'*'); return; }
    }
  }
  window.addEventListener('message',function(e){
    if(e.source===parent&&e.data&&e.data.unpagedQuiz) paint(e.data.unpagedQuiz);
  });
  if(quizzes.length) parent.postMessage({unpagedReady:true},'*');
  document.addEventListener('click',function(e){
    var opt=e.target.closest('.option'); if(opt&&!overlay){ choose(opt); return; }
    if(overlay){ if(e.target===overlay||e.target.closest('.fb-close')) close(); return; }
    var kp=e.target.closest('.kp'); if(kp) open(kp);
  });
  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'){ close(); return; }
    if((e.key==='Enter'||e.key===' ')&&e.target.classList&&e.target.classList.contains('option')&&e.target.tagName!=='BUTTON'){ e.preventDefault(); choose(e.target); return; }
    if((e.key==='Enter'||e.key===' ')&&e.target.classList&&e.target.classList.contains('kp')){ e.preventDefault(); open(e.target); return; }
    // Let the surrounding app turn pages while focus is inside the page.
    if(!overlay&&['ArrowLeft','ArrowRight','PageUp','PageDown'].indexOf(e.key)>=0)
      parent.postMessage({unpagedKey:e.key},'*');
  });
})();
`;

// hasMedia: the deck came with media files, so relative paths need a base to resolve against.
// Sends the quiz state into a page: { selected: [option per quiz], results: [per quiz, or null] }.
export function sendQuiz(frame, state) {
  frame.contentWindow?.postMessage({ unpagedQuiz: state }, "*");
}

// Print version of a deck: every page in one document, one page per sheet, which the browser
// saves as a PDF. Knowledge-point details are laid open, since nothing can be clicked on paper,
// in smaller type so that a page of cards still fits its sheet. A page that is too long anyway
// runs on to the next sheet.
const PRINT_CSS = `
@page{size:13.333in 7.5in;margin:0}
html,body{height:auto!important}
body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
.slide{min-height:99vh;break-after:page;page-break-after:always}
.slide:last-of-type{break-after:auto;page-break-after:auto}
*,*::before,*::after{animation-duration:.001s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition:none!important}
.kps{align-items:start}
.kp{cursor:default;break-inside:avoid}
.kp::after{display:none}
.kp>.detail{display:block;border-top:1px solid rgba(7,7,7,.1);margin-top:6px;padding-top:8px}
.kp>.detail :is(p,li){font-size:clamp(13px,1.35vw,17px)}
.kp>.detail :is(h1,h2,h3){font-size:clamp(17px,1.9vw,24px);line-height:1.2}
.option{cursor:default;break-inside:avoid}
.notes{display:none}
`;

// Runs inside the print document: waits for images and fonts, then opens the print dialog.
const PRINT_JS = `
(function(){
  var done=false;
  function go(){ if(done)return; done=true; setTimeout(function(){ window.print(); },300); }
  window.addEventListener('afterprint',function(){ parent.postMessage({unpagedPrinted:true},'*'); });
  window.addEventListener('load',function(){
    var fonts=document.fonts&&document.fonts.ready; if(fonts) fonts.then(go,go); else go();
  });
  setTimeout(go,8000);
})();
`;

// pages: [{ html, key }], where html is a stored page (assets filled in) and key is its quiz
// answer key, if the reader is allowed to have it. Returns one HTML document.
export function printDeck(title, pages) {
  const parser = new DOMParser();
  let head = "";
  const slides = pages.map(({ html, key }, i) => {
    const doc = parser.parseFromString(html, "text/html");
    if (i === 0) {
      doc.head.querySelectorAll("title").forEach((t) => t.remove());
      head = doc.head.innerHTML;
    }
    const slide = doc.body.querySelector("section");
    if (!slide) return "";
    slide.querySelectorAll("[loading]").forEach((el) => el.removeAttribute("loading"));
    slide.querySelectorAll(".quiz").forEach((quiz, q) => {
      const answer = key?.[q];
      if (!answer) return;
      quiz.classList.add("fb-revealed");
      quiz.querySelectorAll(".option").forEach((o, j) => {
        if (!answer.correct.includes(j)) return;
        o.classList.add("fb-correct");
        o.insertAdjacentHTML("beforeend", `<span class="fb-notes"><span class="fb-tag fb-right">Correct</span></span>`);
      });
      if (answer.explain) quiz.insertAdjacentHTML("beforeend", `<div class="fb-explain">${answer.explain}</div>`);
    });
    return slide.outerHTML;
  });
  const name = document.createElement("title");
  name.textContent = title;
  return (
    `<!doctype html><html lang="en"><head>${head}${name.outerHTML}<style>${PRINT_CSS}</style></head>` +
    `<body>${slides.join("")}<script>${PRINT_JS}</` + `script></body></html>`
  );
}

export function parseDeck(text, hasMedia = false) {
  const doc = new DOMParser().parseFromString(text, "text/html");
  let sections = [...doc.querySelectorAll("section.slide")];
  if (!sections.length) sections = [...doc.querySelectorAll("body > section")];
  const head = doc.head.innerHTML;
  const base = hasMedia ? `<base href="${ASSET_PLACEHOLDER}">` : "";

  // Take the answers out of each quiz. They are stored apart from the page, so a student
  // cannot find them in the page source before the instructor shows them.
  const takeKey = (root) =>
    [...root.querySelectorAll(".quiz")].map((quiz) => {
      const options = [...quiz.querySelectorAll(".option")];
      const correct = options.flatMap((o, i) => (o.hasAttribute("data-correct") ? [i] : []));
      options.forEach((o) => o.removeAttribute("data-correct"));
      const explain = quiz.querySelector(".explain");
      explain?.remove();
      return { options: options.length, correct, explain: explain?.innerHTML.trim() || "" };
    });
  const keys = sections.length ? sections.map(takeKey) : [takeKey(doc.body)];

  // Speaker notes leave the page the same way: they are stored apart from it and only the
  // instructor can fetch them.
  const takeNotes = (root) =>
    [...root.querySelectorAll("aside.notes")]
      .map((n) => {
        n.remove();
        return n.innerHTML.trim();
      })
      .filter(Boolean)
      .join("\n");
  const notes = sections.length ? sections.map(takeNotes) : [takeNotes(doc.body)];

  const bodies = sections.length
    ? sections.map((s) => {
        s.classList.add("slide");
        return s.outerHTML;
      })
    : [`<section class="slide">${doc.body.innerHTML}</section>`];

  return {
    title: doc.title.trim(),
    pages: bodies.map((body, i) => ({
      title: sections[i]?.querySelector("h1, h2, h3")?.textContent.trim() || `Page ${i + 1}`,
      quiz: keys[i].length ? keys[i] : undefined,
      notes: notes[i] || undefined,
      html:
        `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1">` +
        `${base}<style>${BASE_CSS}</style>${head}</head><body>${body}` +
        `<script>${RUNTIME_JS}</` + `script></body></html>`,
    })),
  };
}
