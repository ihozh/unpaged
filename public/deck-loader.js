// Reads a deck from a .zip or a folder and separates the deck HTML from its media files.

const u16 = (v, o) => v.getUint16(o, true);
const u32 = (v, o) => v.getUint32(o, true);

// Minimal zip reader (stored + deflate, no zip64). Returns Map<path, Blob>.
export async function filesFromZip(blob) {
  const view = new DataView(await blob.arrayBuffer());
  let eocd = -1;
  for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 22 - 65535); i--) {
    if (u32(view, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("This is not a valid .zip file.");

  const count = u16(view, eocd + 10);
  let p = u32(view, eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error("This .zip is too large (zip64 is not supported).");

  const utf8 = new TextDecoder();
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (u32(view, p) !== 0x02014b50) throw new Error("This .zip file is damaged.");
    const method = u16(view, p + 10);
    const compSize = u32(view, p + 20);
    const nameLen = u16(view, p + 28);
    const extraLen = u16(view, p + 30);
    const commentLen = u16(view, p + 32);
    const local = u32(view, p + 42);
    const name = utf8.decode(new Uint8Array(view.buffer, p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;

    const dataStart = local + 30 + u16(view, local + 26) + u16(view, local + 28);
    const raw = blob.slice(dataStart, dataStart + compSize);
    if (method === 0) {
      files.set(name, raw);
    } else if (method === 8) {
      files.set(name, await new Response(raw.stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob());
    } else {
      throw new Error(`"${name}" uses a zip compression method that is not supported.`);
    }
  }
  return files;
}

// From <input type="file" webkitdirectory>.
export function filesFromFolder(fileList) {
  return new Map([...fileList].map((f) => [f.webkitRelativePath || f.name, f]));
}

const isHtml = (path) => /\.html?$/i.test(path);

// Picks the deck HTML (index.html if present, otherwise the shallowest .html) and
// returns the other files next to it as media, keyed by path relative to the deck.
export async function pickDeck(files) {
  const visible = [...files].filter(([path]) => !path.split("/").some((s) => s.startsWith(".") || s === "__MACOSX"));
  const depth = (path) => path.split("/").length;
  const htmls = visible.filter(([path]) => isHtml(path)).sort((a, b) => depth(a[0]) - depth(b[0]));
  if (!htmls.length) throw new Error("No .html file found. The deck needs one HTML file.");

  const top = htmls.filter(([path]) => depth(path) === depth(htmls[0][0]));
  const deck = top.find(([path]) => /(^|\/)index\.html?$/i.test(path)) || (top.length === 1 ? top[0] : null);
  if (!deck) throw new Error("Found several .html files. Name the deck index.html so it can be picked.");

  const dir = deck[0].slice(0, deck[0].lastIndexOf("/") + 1);
  const assets = new Map();
  for (const [path, blob] of visible) {
    // Other HTML files are never uploaded, so a second deck in the folder stays private.
    if (!path.startsWith(dir) || isHtml(path)) continue;
    assets.set(path.slice(dir.length).normalize("NFC"), blob);
  }
  return { text: await deck[1].text(), assets };
}
