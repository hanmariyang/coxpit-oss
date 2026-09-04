// File viewer/edit backing (owner-only tool). Scoped to the daemon user's home
// directory — reading file *contents* is higher-risk than /api/browse's dir listing,
// so we jail here. All real work (repos, worktrees, sessions, ~/services) lives under ~.
import { readdir, stat, readFile, writeFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve as presolve, dirname as pdirname, join as pjoin, basename as pbasename, extname as pextname } from 'node:path';

const HOME = presolve(homedir());
const MAX_TEXT = 2 * 1024 * 1024;      // read as text up to 2MB
const MAX_WRITE = 512 * 1024;          // edit-save cap (.env etc. are tiny)

export type FileKind = 'md' | 'html' | 'pdf' | 'image' | 'text' | 'binary';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif']);
const MD_EXT = new Set(['.md', '.markdown', '.mdx']);
const HTML_EXT = new Set(['.html', '.htm']);
// recognized text families (default is a NUL-byte sniff, this just short-circuits)
const TEXT_EXT = new Set([
  '.txt', '.env', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg',
  '.log', '.csv', '.tsv', '.xml', '.sql', '.sh', '.bash', '.zsh', '.fish',
  '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.css', '.scss', '.less',
  '.py', '.rb', '.php', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.cc',
  '.swift', '.kt', '.lua', '.pl', '.r', '.dart', '.vue', '.svelte', '.gradle',
  '.gitignore', '.dockerignore', '.editorconfig', '.properties', '.svg',
]);
const TEXT_BASENAME = new Set(['dockerfile', 'makefile', 'readme', 'license', 'procfile', '.env', '.gitignore', '.npmrc', '.prettierrc', '.eslintrc']);

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.ico': 'image/x-icon', '.avif': 'image/avif', '.html': 'text/html', '.htm': 'text/html',
};

function ext(p: string) { return pextname(p).toLowerCase(); }

export function classify(p: string): FileKind {
  const e = ext(p);
  const base = pbasename(p).toLowerCase();
  if (MD_EXT.has(e)) return 'md';
  if (HTML_EXT.has(e)) return 'html';
  if (e === '.pdf') return 'pdf';
  if (e === '.svg') return 'image';       // render, but also text-editable via read()
  if (IMAGE_EXT.has(e)) return 'image';
  if (TEXT_EXT.has(e) || TEXT_BASENAME.has(base) || base.startsWith('.env')) return 'text';
  return 'binary';                        // decided for real in read() via NUL sniff
}

export function mimeFor(p: string): string {
  return MIME[ext(p)] || 'application/octet-stream';
}

// Reject anything that escapes HOME (symlink-safe via realpath on the closest existing ancestor).
async function jail(input?: string): Promise<string> {
  const p = presolve(input && input.startsWith('/') ? input : HOME);
  // realpath the deepest existing ancestor so a missing leaf (new file) still validates its dir
  let probe = p;
  for (;;) {
    try { const rp = await realpath(probe); const rest = p.slice(probe.length); const full = presolve(rp + rest);
      if (full !== HOME && !full.startsWith(HOME + '/')) throw new Error('outside home');
      return full;
    } catch (e: any) {
      if (e && e.message === 'outside home') throw e;
      const parent = pdirname(probe);
      if (parent === probe) { if (p !== HOME && !p.startsWith(HOME + '/')) throw new Error('outside home'); return p; }
      probe = parent;
    }
  }
}

export async function listDir(input?: string) {
  const path = await jail(input);
  const entries: Array<{ name: string; dir: boolean; size: number; kind?: FileKind }> = [];
  let error: string | undefined;
  try {
    const items = await readdir(path, { withFileTypes: true });
    for (const it of items) {
      // hide most dotfiles, but keep .env* visible (the one text file they edit)
      if (it.name.startsWith('.') && !it.name.startsWith('.env')) continue;
      const dir = it.isDirectory();
      let size = 0;
      if (!dir) { try { size = (await stat(pjoin(path, it.name))).size; } catch { size = 0; } }
      entries.push({ name: it.name, dir, size, kind: dir ? undefined : classify(it.name) });
      if (entries.length >= 500) break;
    }
    entries.sort((a, b) => (b.dir ? 1 : 0) - (a.dir ? 1 : 0) || a.name.localeCompare(b.name));
  } catch { error = 'cannot read directory'; }
  return { path, parent: pdirname(path), home: HOME, entries, error };
}

// Recursive filename search under a folder (bounded). For the picker's search box.
const FIND_SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'venv', '.venv', '__pycache__', '.turbo', 'coverage', '.gradle', 'target']);
export async function findFiles(input: string | undefined, q: string, limit = 300) {
  const root = await jail(input);
  const needle = (q || '').trim().toLowerCase();
  if (needle.length < 2) return { root, q: needle, results: [] as any[], error: 'query too short (min 2 chars)' };
  const out: Array<{ path: string; rel: string; name: string; size: number; kind: FileKind }> = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (out.length >= limit || depth > 6) return;
    let items;
    try { items = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (out.length >= limit) return;
      if (it.name.startsWith('.') && !it.name.startsWith('.env')) continue;
      const full = pjoin(dir, it.name);
      if (it.isDirectory()) { if (!FIND_SKIP.has(it.name)) await walk(full, depth + 1); continue; }
      if (it.name.toLowerCase().includes(needle)) {
        let size = 0; try { size = (await stat(full)).size; } catch { /* skip */ }
        out.push({ path: full, rel: full.slice(root.length + 1), name: it.name, size, kind: classify(it.name) });
      }
    }
  }
  await walk(root, 0);
  const truncated = out.length >= limit;
  out.sort((a, b) => a.rel.length - b.rel.length || a.rel.localeCompare(b.rel));
  return { root, q: needle, results: out, truncated };
}

export async function readForView(input?: string) {
  const path = await jail(input);
  const st = await stat(path);
  if (st.isDirectory()) throw new Error('is a directory');
  const name = pbasename(path);
  let kind = classify(path);
  const size = st.size;

  // For pdf/image/html the client fetches /api/fs/raw; no body needed here.
  if (kind === 'pdf' || kind === 'image' || kind === 'html') {
    return { path, name, kind, size, editable: false };
  }

  // text / md / unknown → try to read as text (NUL sniff decides 'binary')
  if (size > MAX_TEXT) return { path, name, kind: 'binary' as FileKind, size, editable: false, note: 'too large to preview' };
  const buf = await readFile(path);
  if (buf.includes(0)) return { path, name, kind: 'binary' as FileKind, size, editable: false };
  const text = buf.toString('utf8');
  if (kind === 'binary') kind = 'text';   // unknown ext but no NUL → treat as text
  const editable = (kind === 'text' || kind === 'md') && size <= MAX_WRITE;
  return { path, name, kind, size, editable, text };
}

// Raw bytes with correct content-type — this is what makes PDFs/images/html render.
export async function readRaw(input?: string) {
  const path = await jail(input);
  const st = await stat(path);
  if (st.isDirectory()) throw new Error('is a directory');
  return { path, name: pbasename(path), mime: mimeFor(path), buf: await readFile(path) };
}

export async function writeText(input: string, content: string) {
  const path = await jail(input);
  const st = await stat(path).catch(() => null);
  if (st && st.isDirectory()) throw new Error('is a directory');
  if (st && st.size > MAX_WRITE) throw new Error('file too large to edit here');
  if (Buffer.byteLength(content, 'utf8') > MAX_WRITE) throw new Error('content exceeds edit cap (512KB)');
  const kind = classify(path);
  if (kind === 'pdf' || kind === 'image' || kind === 'binary') throw new Error('not an editable text file');
  await writeFile(path, content, 'utf8');
  return { path, name: pbasename(path), size: Buffer.byteLength(content, 'utf8') };
}
