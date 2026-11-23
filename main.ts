// mend — one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none.
//
// Usage: node main.ts [options] [PATCH]
//   PATCH        path to a patch file; when omitted, the patch is read from stdin.
//   --strict     only tier 0 (exact) matching; fail anything that needs a
//                looser tier.
//   --dry-run    resolve and report everything, but write no files.
//   --help       print usage.
//   --version    print the version.
//
// Matching tiers, tried in order for every edit; the first tier that finds
// exactly one place wins:
//   tier 0  exact lines, byte for byte.
//   tier 1  whitespace-normalised: leading/trailing whitespace ignored and
//           runs of whitespace inside a line collapsed to one space.
//   tier 2  whitespace-insensitive: all whitespace ignored; the replacement
//           is re-indented to the indentation the file actually has.
//
// Node 22, standard library only. Deterministic: no times, no randomness.
// Written in erasable TypeScript so Node 22 runs it with type stripping.

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, statSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// SPEC surface (adapted to SPEC.md when the kit lands; the engine below the
// line does not depend on these strings).
// ---------------------------------------------------------------------------

const USAGE = `mend ${VERSION} — one patch tool for every AI edit format
usage: mend [options] [PATCH]
  PATCH        patch file to apply (default: read from stdin)
options:
  --strict     exact matching only (tier 0)
  --dry-run    check the patch without writing any file
  --help       show this help
  --version    show the version
`;

function fail(message) {
  return { ok: false, message };
}

// ---------------------------------------------------------------------------
// Small line helpers
// ---------------------------------------------------------------------------

// Split text into lines, remembering whether it ended with a newline and
// whether it used CRLF, so writes round-trip the file's own style.
function splitLines(text) {
  const crlf = text.includes("\r\n");
  const clean = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const endsWithNewline = clean.endsWith("\n");
  let lines = clean.split("\n");
  if (endsWithNewline) lines = lines.slice(0, -1);
  return { lines, endsWithNewline, crlf };
}

function joinLines(lines, endsWithNewline, crlf) {
  const eol = crlf ? "\r\n" : "\n";
  let out = lines.join(eol);
  if (endsWithNewline && lines.length > 0) out += eol;
  if (lines.length === 0) out = "";
  return out;
}

function leadingWs(line) {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : "";
}

// Tier normalisations.
function normTier1(line) {
  return line.trim().replace(/[ \t]+/g, " ");
}
function normTier2(line) {
  return line.replace(/\s+/g, "");
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

// Find needle (array of lines) inside haystack at the given tier.
// Returns { index } on a unique match, { ambiguous: true } when more than
// one place matches, or null when nothing matches.
function findBlock(haystack, needle, tier) {
  if (needle.length === 0) return null;
  if (needle.length > haystack.length) return null;
  const norm = tier === 0 ? (s) => s : tier === 1 ? normTier1 : normTier2;
  const nNeedle = needle.map(norm);
  // A needle of only blank lines matches everywhere; refuse it.
  if (nNeedle.every((l) => l === "")) return null;
  let found = -1;
  let count = 0;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (norm(haystack[i + j]) !== nNeedle[j]) continue outer;
    }
    count++;
    if (count > 1) return { ambiguous: true };
    found = i;
  }
  if (count === 0) return null;
  return { index: found };
}

// First match of needle in haystack at or after `from`, at one tier.
function findBlockFrom(haystack, needle, tier, from) {
  if (needle.length === 0) return null;
  const norm = tier === 0 ? (s) => s : tier === 1 ? normTier1 : normTier2;
  const nNeedle = needle.map(norm);
  if (nNeedle.every((l) => l === "")) return null;
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (norm(haystack[i + j]) !== nNeedle[j]) continue outer;
    }
    return i;
  }
  return null;
}

// The anchor line: the first line at or after `from` that starts with the
// anchor text, at one tier.
function findAnchorLine(haystack, anchor, tier, from) {
  const norm = tier === 0 ? (s) => s : tier === 1 ? normTier1 : normTier2;
  const nAnchor = norm(anchor);
  if (nAnchor === "") return null;
  for (let i = from; i < haystack.length; i++) {
    if (norm(haystack[i]).startsWith(nAnchor)) return i;
  }
  return null;
}

// Try tiers in order; the first tier with a unique match wins.
function findAtFirstTier(haystack, needle, maxTier) {
  for (let tier = 0; tier <= maxTier; tier++) {
    const r = findBlock(haystack, needle, tier);
    if (r && !r.ambiguous) return { index: r.index, tier };
    if (r && r.ambiguous) return { ambiguous: true, tier };
  }
  return null;
}

// --- Text (substring) matching, for JSON edits whose old text need not
// span whole lines. Tiers mirror the line tiers on raw text. ---

// Normalise text for a tier and keep, for every normalised character, the
// index of the original character it came from.
function normaliseText(text, tier) {
  if (tier === 0) return { norm: text, map: null };
  const chars = [];
  const map = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (tier === 1) {
        chars.push(" ");
        map.push(i);
        while (i < text.length && /\s/.test(text[i])) i++;
      } else {
        i++; // tier 2: drop whitespace entirely
      }
    } else {
      chars.push(ch);
      map.push(i);
      i++;
    }
  }
  return { norm: chars.join(""), map };
}

// Find needle in haystack at one tier. Returns { start, end } character
// offsets, { ambiguous: true }, or null.
function findTextSpan(haystack, needle, tier) {
  const h = normaliseText(haystack, tier);
  const n = normaliseText(needle, tier);
  if (n.norm === "") return null;
  let found = -1;
  let count = 0;
  let from = 0;
  while (true) {
    const at = h.norm.indexOf(n.norm, from);
    if (at === -1) break;
    count++;
    if (count > 1) return { ambiguous: true };
    found = at;
    from = at + 1;
  }
  if (count === 0) return null;
  if (tier === 0) return { start: found, end: found + needle.length };
  const start = h.map[found];
  const lastNorm = found + n.norm.length - 1;
  const end = h.map[lastNorm] + 1;
  return { start, end };
}

function findTextAtFirstTier(haystack, needle, maxTier) {
  for (let tier = 0; tier <= maxTier; tier++) {
    const r = findTextSpan(haystack, needle, tier);
    if (r && !r.ambiguous) return { start: r.start, end: r.end, tier };
    if (r && r.ambiguous) return { ambiguous: true, tier };
  }
  return null;
}

// Re-indent replacement lines so they sit at the indentation the file
// actually has where the match was found. Lines that line up with an old
// line (same position in the block) take that found line's indent, keeping
// any extra indent the replacement added; extra lines keep their indent
// relative to the replacement's first line, hung off the found block.
function reindent(newLines, oldLines, foundLines) {
  const firstNew = newLines.find((l) => l.trim() !== "");
  const firstFound = foundLines.find((l) => l.trim() !== "");
  const newBase = firstNew === undefined ? "" : leadingWs(firstNew);
  const foundBase = firstFound === undefined ? "" : leadingWs(firstFound);
  return newLines.map((line, j) => {
    if (line.trim() === "") return line;
    const cur = leadingWs(line);
    const rest = line.slice(cur.length);
    if (j < oldLines.length && j < foundLines.length) {
      const oldInd = leadingWs(oldLines[j]);
      const foundInd = leadingWs(foundLines[j]);
      if (cur.startsWith(oldInd)) return foundInd + cur.slice(oldInd.length) + rest;
      return foundInd + cur + rest;
    }
    if (cur.startsWith(newBase)) return foundBase + cur.slice(newBase.length) + rest;
    return line;
  });
}

// ---------------------------------------------------------------------------
// Patch model: every format parses to a list of file edits.
//   { file, create, remove, hunks: [{ oldLines, newLines }] }
// ---------------------------------------------------------------------------

function newFileEdit(file) {
  if (file.startsWith("./")) file = file.slice(2);
  return { file, create: false, remove: false, hunks: [] };
}

function stripABPrefix(p) {
  if (p === "/dev/null") return null;
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

// A ---/+++ header line: path, optionally followed by a tab and a timestamp
// (or a space and a date). Returns the path part.
function headerPath(line) {
  const rest = line.slice(4).trim();
  const tab = rest.indexOf("\t");
  if (tab !== -1) return rest.slice(0, tab);
  const date = rest.search(/ \d{4}-\d{2}-\d{2}[T ]/);
  if (date !== -1) return rest.slice(0, date);
  return rest;
}

// --- Unified diff ----------------------------------------------------------

function parseUnified(text) {
  const { lines } = splitLines(text);
  const edits = [];
  let cur = null;
  let curPushed = false;
  let pendingNew = false;
  let pendingDel = false;
  let pendingRenameFrom = null;
  let pendingRenameTo = null;
  let i = 0;
  let sawAny = false;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      sawAny = true;
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      // The ---/+++ pair that follows owns the edit; keep this only as a
      // fallback for diffs whose hunks come with no ---/+++ headers.
      cur = m ? newFileEdit(m[2]) : null;
      curPushed = false;
      pendingNew = false;
      pendingDel = false;
      pendingRenameFrom = null;
      pendingRenameTo = null;
      i++;
      continue;
    }
    if (line.startsWith("rename from ")) {
      pendingRenameFrom = line.slice("rename from ".length).trim();
      i++;
      continue;
    }
    if (line.startsWith("rename to ")) {
      pendingRenameTo = line.slice("rename to ".length).trim();
      i++;
      continue;
    }
    if (line.startsWith("new file mode")) {
      pendingNew = true;
      i++;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      pendingDel = true;
      i++;
      continue;
    }
    if (line.startsWith("--- ")) {
      sawAny = true;
      const oldPath = stripABPrefix(headerPath(line));
      // The +++ line must follow (possibly after index/new-file lines).
      let j = i + 1;
      let newPath = null;
      let isNew = false;
      let isDel = false;
      while (j < lines.length && !lines[j].startsWith("+++ ")) {
        if (lines[j].startsWith("new file mode")) isNew = true;
        if (lines[j].startsWith("deleted file mode")) isDel = true;
        if (lines[j].startsWith("diff --git ") || lines[j].startsWith("@@ ")) break;
        j++;
      }
      if (j < lines.length && lines[j].startsWith("+++ ")) {
        newPath = stripABPrefix(headerPath(lines[j]));
        const file = newPath !== null ? newPath : oldPath;
        if (file === null) return fail("invalid patch: ---/+++ without a file");
        cur = newFileEdit(file);
        cur.create = oldPath === null || isNew || pendingNew;
        cur.remove = newPath === null || isDel || pendingDel;
        if (pendingRenameFrom && pendingRenameTo && file === pendingRenameTo) {
          cur.renameFrom = pendingRenameFrom;
        }
        curPushed = true;
        edits.push(cur);
        pendingNew = false;
        pendingDel = false;
        pendingRenameFrom = null;
        pendingRenameTo = null;
        i = j + 1;
        continue;
      }
      return fail("invalid patch: --- without +++");
    }
    if (line.startsWith("+++ ")) {
      // +++ without a preceding ---: ignore (should not happen).
      i++;
      continue;
    }
    if (line.startsWith("@@ ")) {
      sawAny = true;
      if (!cur) return fail("invalid patch: hunk without a file");
      if (!curPushed) {
        cur.create = cur.create || pendingNew;
        cur.remove = cur.remove || pendingDel;
        curPushed = true;
        edits.push(cur);
        pendingNew = false;
        pendingDel = false;
      }
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) return fail("invalid patch: bad hunk header");
      // The hunk's line counts say where it ends: without them a following
      // "--- <file>" header looks like a removed line. Counts may be
      // wrong (models drift them), so after the counts run out, hunk lines
      // keep being consumed until a header line appears.
      let oldNeed = m[2] === undefined ? 1 : parseInt(m[2], 10);
      let newNeed = m[4] === undefined ? 1 : parseInt(m[4], 10);
      const oldLines = [];
      const newLines = [];
      // "\ No newline at end of file" describes the line just read: after
      // a + or context line the NEW file ends without a newline; after a
      // - line the OLD file did, and the new file ends WITH one.
      let lastKind = null;
      let markerKind = null;
      let trailingContext = 0;
      i++;
      const isHeaderLine = (l) =>
        l.startsWith("@@ ") || l.startsWith("diff --git ") || l.startsWith("--- ") || l.startsWith("+++ ");
      let hunkDone = false;
      while (i < lines.length && !hunkDone) {
        const hl = lines[i];
        if (oldNeed <= 0 && newNeed <= 0) {
          // Counts are spent: only keep consuming clear hunk lines, and
          // stop at anything that could be a header. A "\ No newline"
          // marker still belongs to this hunk.
          if (hl.startsWith("\\")) {
            markerKind = lastKind;
            i++;
            continue;
          }
          if (isHeaderLine(hl)) {
            hunkDone = true;
            continue;
          }
          if (!(hl.startsWith(" ") || hl === "" || hl.startsWith("-") || hl.startsWith("+"))) {
            hunkDone = true;
            continue;
          }
        } else if (isHeaderLine(hl)) {
          hunkDone = true;
          continue;
        }
        if (hl.startsWith(" ") || hl === "") {
          const content = hl.startsWith(" ") ? hl.slice(1) : "";
          oldLines.push(content);
          newLines.push(content);
          lastKind = "context";
          markerKind = null;
          trailingContext++;
          oldNeed--;
          newNeed--;
          i++;
        } else if (hl.startsWith("-")) {
          oldLines.push(hl.slice(1));
          lastKind = "minus";
          markerKind = null;
          trailingContext = 0;
          oldNeed--;
          i++;
        } else if (hl.startsWith("+")) {
          newLines.push(hl.slice(1));
          lastKind = "plus";
          markerKind = null;
          trailingContext = 0;
          newNeed--;
          i++;
        } else if (hl.startsWith("\\")) {
          markerKind = lastKind;
          i++;
        } else {
          hunkDone = true;
        }
      }
      cur.hunks.push({
        oldLines,
        newLines,
        noTrailingNewline: markerKind === "plus" || markerKind === "context",
        endsWithNewline: markerKind === "minus",
        trailingContext,
      });
      continue;
    }
    if (
      line.startsWith("index ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line === "" ||
      line.startsWith("Binary files ")
    ) {
      i++;
      continue;
    }
    return fail("invalid patch: unexpected line in unified diff");
  }
  if (!sawAny) return fail("invalid patch: not a unified diff");
  return { ok: true, edits };
}

// --- SEARCH/REPLACE (Aider-style blocks) -----------------------------------

function parseSearchReplace(text) {
  const { lines } = splitLines(text);
  const edits = [];
  let i = 0;
  let sawAny = false;
  // Optional leading "path" line directly before a block names the file.
  let pendingPath = null;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "<<<<<<< SEARCH") {
      sawAny = true;
      if (!pendingPath) return fail("invalid patch: SEARCH/REPLACE block without a file");
      const cur = newFileEdit(pendingPath);
      edits.push(cur);
      pendingPath = null;
      const oldLines = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "=======") {
        oldLines.push(lines[i]);
        i++;
      }
      if (i >= lines.length) return fail("invalid patch: SEARCH block without =======");
      i++; // skip =======
      const newLines = [];
      while (i < lines.length && lines[i].trim() !== ">>>>>>> REPLACE") {
        newLines.push(lines[i]);
        i++;
      }
      if (i >= lines.length) return fail("invalid patch: REPLACE block without >>>>>>> REPLACE");
      i++; // skip >>>>>>> REPLACE
      cur.hunks.push({ oldLines, newLines });
      continue;
    }
    if (line.trim() !== "" && !line.startsWith("#")) {
      // A bare non-empty line outside a block is a file path for the next block.
      pendingPath = line.trim();
    }
    i++;
  }
  if (!sawAny) return fail("invalid patch: no SEARCH/REPLACE block");
  return { ok: true, edits };
}

// --- V4A (Codex apply_patch) ------------------------------------------------
//   *** Begin Patch
//   *** Add File: <path>        (+ lines only: the new file's content)
//   *** Delete File: <path>
//   *** Update File: <path>     (optional "*** Move to: <new>" after it)
//   *** <path>                  (bare header: an update)
//   @@ [anchor]                 (hunk; the anchor text names the line the
//                                hunk starts at or just after)
//    <context>  -<old>  +<new>   (hunk lines, space/-/+, as in a unified diff)
//   *** End of File             (following hunks apply at the file's end)
//   *** End Patch
// A hunk's old block is matched from the anchor line downwards, first match
// wins per tier; hunks run top to bottom, so each hunk searches from where
// the previous one ended.

function parseV4a(text) {
  const { lines } = splitLines(text);
  const edits = [];
  let cur = null;
  let i = 0;
  let sawAny = false;
  let atEof = false;
  const finishFile = () => {
    cur = null;
    atEof = false;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line === "*** Begin Patch" || line === "*** End Patch") {
      sawAny = true;
      i++;
      continue;
    }
    if (line === "*** End of File") {
      sawAny = true;
      atEof = true;
      i++;
      continue;
    }
    let m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) {
      sawAny = true;
      finishFile();
      cur = newFileEdit(m[2].trim());
      if (m[1] === "Add") cur.create = true;
      if (m[1] === "Delete") cur.remove = true;
      edits.push(cur);
      i++;
      continue;
    }
    m = /^\*\*\* Move to: (.+)$/.exec(line);
    if (m) {
      sawAny = true;
      if (!cur || cur.remove || cur.create) return fail("invalid patch: *** Move to: without an update");
      cur.moveTo = m[1].trim();
      i++;
      continue;
    }
    m = /^\*\*\* (.+)$/.exec(line);
    if (m && !m[1].startsWith("Begin") && !m[1].startsWith("End")) {
      // Bare "*** <path>" header: an update of that file.
      sawAny = true;
      finishFile();
      cur = newFileEdit(m[1].trim());
      edits.push(cur);
      i++;
      continue;
    }
    if (line.startsWith("@@") || (cur && !cur.remove && !cur.create && (line.startsWith(" ") || line.startsWith("-") || line.startsWith("+")))) {
      sawAny = true;
      if (!cur) return fail("invalid patch: V4A hunk without a file");
      const anchor = line.startsWith("@@") ? line.slice(2).replace(/^ /, "") : "";
      const oldLines = [];
      const newLines = [];
      let trailingContext = 0;
      if (line.startsWith("@@")) i++;
      while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("***")) {
        const hl = lines[i];
        if (hl.startsWith(" ") || hl === "") {
          const content = hl.startsWith(" ") ? hl.slice(1) : "";
          oldLines.push(content);
          newLines.push(content);
          trailingContext++;
        } else if (hl.startsWith("-")) {
          oldLines.push(hl.slice(1));
          trailingContext = 0;
        } else if (hl.startsWith("+")) {
          newLines.push(hl.slice(1));
          trailingContext = 0;
        } else {
          return fail("invalid patch: bad line in V4A hunk");
        }
        i++;
      }
      cur.hunks.push({ oldLines, newLines, anchor, atEof, trailingContext });
      continue;
    }
    if (line.startsWith("+") && cur && cur.create) {
      // Add-file content without an @@ hunk: bare + lines.
      sawAny = true;
      const newLines = [];
      while (i < lines.length && lines[i].startsWith("+")) {
        newLines.push(lines[i].slice(1));
        i++;
      }
      cur.hunks.push({ oldLines: [], newLines });
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    return fail("invalid patch: unexpected line in V4A patch");
  }
  if (!sawAny) return fail("invalid patch: not a V4A patch");
  return { ok: true, edits };
}

// --- JSON edits ------------------------------------------------------------
// Accepts, defensively, the shapes a JSON tool call can take:
//   [ {file|path, old|old_text|search, new|new_text|replace}, ... ]
//   { "edits": [ ... ] }
//   { "file"|"path": ..., "edits": [...] }
//   { "tool": "edit"|"str_replace", "file"|"path": ..., "old_text": ..., "new_text": ... }

function parseJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return fail("invalid patch: not valid JSON");
  }
  // Unwrap the shapes a JSON tool call can take: a bare list, an object
  // with edits/tool_calls/calls/operations, a single call, an OpenAI-style
  // call with arguments (string or object), or an Anthropic-style call
  // with an input object.
  const unwrap = (obj) => {
    if (!obj || typeof obj !== "object") return obj;
    if (typeof obj.arguments === "string") {
      try {
        return unwrap(JSON.parse(obj.arguments));
      } catch {
        return obj;
      }
    }
    if (obj.arguments && typeof obj.arguments === "object") return unwrap(obj.arguments);
    if (obj.input && typeof obj.input === "object") return unwrap(obj.input);
    return obj;
  };
  let list = null;
  let file = null;
  if (Array.isArray(data)) {
    list = data;
  } else if (data && typeof data === "object") {
    const arr = data.edits || data.tool_calls || data.calls || data.operations;
    if (Array.isArray(arr)) {
      list = arr;
      file = data.file || data.path || null;
    } else if (data.file || data.path) {
      list = [data];
    } else if (data.tool || data.name || data.function) {
      list = [data];
    }
  }
  if (!list) return fail("invalid patch: JSON has no edits");
  const edits = [];
  for (let item of list) {
    item = unwrap(item);
    if (!item || typeof item !== "object") return fail("invalid patch: bad JSON edit");
    const f = item.file || item.path || item.filepath || file;
    if (!f || typeof f !== "string") return fail("invalid patch: JSON edit without a file");
    const oldText = item.old_text ?? item.old_str ?? item.old_string ?? item.old ?? item.search ?? item.search_text;
    const newText = item.new_text ?? item.new_str ?? item.new_string ?? item.new ?? item.replace ?? item.replace_text;
    if (typeof oldText !== "string" || typeof newText !== "string") {
      return fail("invalid patch: JSON edit without old/new text");
    }
    let cur = edits.find((e) => e.file === f && !e.create && !e.remove);
    if (!cur) {
      cur = newFileEdit(f);
      edits.push(cur);
    }
    cur.hunks.push({ kind: "text", oldText, newText });
  }
  if (edits.length === 0) return fail("invalid patch: JSON has no edits");
  return { ok: true, edits };
}

// --- Format detection ------------------------------------------------------

function looksLikeV4a(text) {
  // Markers must start a line: a patch that ADDS a line containing one
  // (e.g. "+*** Begin Patch") is not a V4A patch.
  return /(^|\n)\*\*\* (Begin Patch|Update File:|Add File:|Delete File:|Move to:)/.test(text);
}

function detectFormat(text) {
  const t = text.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) return "json";
  if (/(^|\n)<<<<<<< SEARCH/.test(text)) return "search_replace";
  if (looksLikeV4a(text)) return "v4a";
  if (t.startsWith("diff --git ") || t.startsWith("--- ")) return "unified";
  return null;
}

function parsePatch(text) {
  const fmt = detectFormat(text);
  if (!fmt) return fail("invalid patch: unrecognised format");
  if (fmt === "unified") return parseUnified(text);
  if (fmt === "search_replace") return parseSearchReplace(text);
  if (fmt === "json") return parseJson(text);
  return parseV4a(text);
}

// ---------------------------------------------------------------------------
// Apply (transactional: every change or none)
// ---------------------------------------------------------------------------

function pathIsSafe(file) {
  if (file.startsWith("/") || file.startsWith("\\")) return false;
  const parts = file.split(/[\\/]/);
  if (parts.includes("..")) return false;
  return file.length > 0;
}

function applyEdits(edits, maxTier) {
  // Resolve everything in memory first; write only when all edits resolve.
  // Edits to the same file share one in-memory copy, so later edits see
  // earlier ones (the write happens once, at the end).
  const plan = []; // { file, action: "write"|"delete", content }
  const changed = [];
  const state = new Map(); // file -> { exists, deleted, raw, crlf }
  for (const edit of edits) {
    if (!pathIsSafe(edit.file)) return fail(`invalid patch: unsafe path ${edit.file}`);
    if (edit.renameFrom && !existsSync(resolve(edit.renameFrom))) {
      return fail(`file not found: ${edit.renameFrom}`);
    }
    let st = state.get(edit.file);
    if (!st) {
      const abs = resolve(edit.file);
      // A rename's hunks describe the old file's content, not the target's.
      const src = edit.renameFrom && existsSync(resolve(edit.renameFrom)) ? resolve(edit.renameFrom) : abs;
      const exists = existsSync(src);
      st = { exists, deleted: false, raw: exists ? readFileSync(src, "utf8") : null, crlf: false, bom: false };
      if (exists) {
        st.crlf = st.raw.includes("\r\n");
        if (st.raw.startsWith("\uFEFF")) {
          st.bom = true;
          st.raw = st.raw.slice(1);
        }
      }
      state.set(edit.file, st);
    }
    if (edit.moveTo) {
      if (!pathIsSafe(edit.moveTo)) return fail(`invalid patch: unsafe path ${edit.moveTo}`);
      if (existsSync(resolve(edit.moveTo))) return fail(`file already exists: ${edit.moveTo}`);
      st.moveTo = edit.moveTo;
    }
    if (edit.renameFrom) {
      if (!pathIsSafe(edit.renameFrom)) return fail(`invalid patch: unsafe path ${edit.renameFrom}`);
      st.renameFrom = edit.renameFrom;
    }
    const abs = resolve(edit.file);
    if (edit.remove) {
      if (!st.exists) return fail(`file not found: ${edit.file}`);
      st.exists = false;
      st.deleted = true;
      st.raw = null;
      continue;
    }
    if (edit.create) {
      if (st.exists) return fail(`file already exists: ${edit.file}`);
      let lines = [];
      for (const hunk of edit.hunks) {
        if (hunk.kind === "text" || hunk.oldLines.length > 0) {
          return fail(`invalid patch: new file ${edit.file} has old lines`);
        }
        lines = lines.concat(hunk.newLines);
      }
      st.exists = true;
      st.deleted = false;
      const noNL = edit.hunks.length > 0 && edit.hunks[edit.hunks.length - 1].noTrailingNewline;
      st.raw = joinLines(lines, !noNL, false);
      st.crlf = false;
      continue;
    }
    if (!st.exists) return fail(`file not found: ${edit.file}`);
    const { lines, endsWithNewline, crlf } = splitLines(st.raw);
    let cur = lines.slice();
    let endsNL = endsWithNewline;
    for (const hunk of edit.hunks) {
      if (hunk.kind === "text") {
        if (hunk.oldText === "") {
          return fail(`invalid patch: empty search in ${edit.file}`);
        }
        let text = joinLines(cur, endsNL, false);
        const found = findTextAtFirstTier(text, hunk.oldText, maxTier);
        if (!found) return fail(`no match in ${edit.file}`);
        if (found.ambiguous) return fail(`ambiguous match in ${edit.file}`);
        let replacement = hunk.newText;
        if (found.tier > 0) {
          const atLineStart = found.start === 0 || text[found.start - 1] === "\n";
          if (atLineStart) {
            const matched = text.slice(found.start, found.end);
            replacement = joinLines(
              reindent(splitLines(replacement).lines, splitLines(hunk.oldText).lines, splitLines(matched).lines),
              splitLines(replacement).endsWithNewline,
              false,
            );
          }
        }
        text = text.slice(0, found.start) + replacement + text.slice(found.end);
        const sp = splitLines(text);
        cur = sp.lines;
        endsNL = sp.endsWithNewline;
        continue;
      }
      if (hunk.oldLines.length === 0 && hunk.anchor === undefined) {
        return fail(`invalid patch: empty search in ${edit.file}`);
      }
      if (hunk.anchor !== undefined) {
        // V4A hunk: anchor-aware, top-to-bottom. The cursor is where the
        // previous hunk of this file ended.
        if (st.cursor === undefined) st.cursor = 0;
        let regionStart = st.cursor;
        if (hunk.atEof) {
          regionStart = cur.length;
        } else if (hunk.anchor !== "") {
          let anchorAt = null;
          for (let tier = 0; tier <= maxTier; tier++) {
            anchorAt = findAnchorLine(cur, hunk.anchor, tier, st.cursor);
            if (anchorAt !== null) break;
          }
          if (anchorAt === null) return fail(`no match in ${edit.file}`);
          regionStart = anchorAt;
        }
        if (hunk.oldLines.length === 0) {
          const insertPos = hunk.atEof ? cur.length : hunk.anchor !== "" ? regionStart + 1 : regionStart;
          let replacement = hunk.newLines;
          if (regionStart < cur.length) {
            replacement = reindent(replacement, [], cur.slice(regionStart, regionStart + 1));
          }
          cur = cur.slice(0, insertPos).concat(replacement, cur.slice(insertPos));
          st.cursor = insertPos + replacement.length;
          continue;
        }
        if (hunk.atEof) {
          // The block must be the file's tail.
          const start = cur.length - hunk.oldLines.length;
          if (start < 0) return fail(`no match in ${edit.file}`);
          let matchedTier = -1;
          for (let tier = 0; tier <= maxTier; tier++) {
            if (findBlockFrom(cur, hunk.oldLines, tier, start) === start) {
              matchedTier = tier;
              break;
            }
          }
          if (matchedTier === -1) return fail(`no match in ${edit.file}`);
          let replacement = hunk.newLines;
          if (matchedTier > 0) {
            replacement = reindent(replacement, hunk.oldLines, cur.slice(start, start + hunk.oldLines.length));
          }
          cur = cur.slice(0, start).concat(replacement);
          if (hunk.noTrailingNewline) endsNL = false;
          else if (hunk.endsWithNewline) endsNL = true;
          st.cursor = cur.length;
          continue;
        }
        let pos = null;
        let posTier = 0;
        for (let tier = 0; tier <= maxTier; tier++) {
          pos = findBlockFrom(cur, hunk.oldLines, tier, regionStart);
          if (pos !== null) {
            posTier = tier;
            break;
          }
        }
        if (pos === null) return fail(`no match in ${edit.file}`);
        const atEnd = pos + hunk.oldLines.length === cur.length;
        let replacement = hunk.newLines;
        if (posTier > 0) {
          replacement = reindent(replacement, hunk.oldLines, cur.slice(pos, pos + hunk.oldLines.length));
        }
        cur = cur.slice(0, pos).concat(replacement, cur.slice(pos + hunk.oldLines.length));
        if (atEnd) {
          if (hunk.noTrailingNewline) endsNL = false;
          else if (hunk.endsWithNewline) endsNL = true;
        }
        st.cursor = pos + replacement.length - (hunk.trailingContext || 0);
        continue;
      }
      const found = findAtFirstTier(cur, hunk.oldLines, maxTier);
      if (!found) return fail(`no match in ${edit.file}`);
      if (found.ambiguous) return fail(`ambiguous match in ${edit.file}`);
      const atEnd = found.index + hunk.oldLines.length === cur.length;
      let replacement = hunk.newLines;
      if (found.tier > 0) {
        replacement = reindent(replacement, hunk.oldLines, cur.slice(found.index, found.index + hunk.oldLines.length));
      }
      cur = cur.slice(0, found.index).concat(replacement, cur.slice(found.index + hunk.oldLines.length));
      if (atEnd) {
        if (hunk.noTrailingNewline) endsNL = false;
        else if (hunk.endsWithNewline) endsNL = true;
      }
    }
    st.raw = joinLines(cur, endsNL, st.crlf);
  }
  for (const [file, st] of state) {
    const abs = resolve(file);
    const original = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    const finalContent = st.raw === null ? null : st.bom ? "\uFEFF" + st.raw : st.raw;
    if (st.renameFrom && st.exists && !st.deleted && existsSync(resolve(st.renameFrom))) {
      plan.push({ file: st.renameFrom, action: "delete", content: null });
    }
    if (st.moveTo && st.exists && !st.deleted) {
      plan.push({ file: st.moveTo, action: "write", content: finalContent });
      if (original !== null) plan.push({ file, action: "delete", content: null });
      changed.push(st.moveTo);
      continue;
    }
    if (st.deleted) {
      if (original !== null) {
        plan.push({ file, action: "delete", content: null });
        changed.push(file);
      }
    } else if (st.exists && finalContent !== original) {
      plan.push({ file, action: "write", content: finalContent });
      changed.push(file);
    }
  }
  return { ok: true, plan, changed };
}

function commitPlan(plan) {
  for (const step of plan) {
    const abs = resolve(step.file);
    if (step.action === "delete") {
      unlinkSync(abs);
    } else {
      const dir = dirname(abs);
      mkdirSync(dir, { recursive: true });
      const mode = existsSync(abs) ? statSync(abs).mode : undefined;
      writeFileSync(abs, step.content, "utf8");
      if (mode !== undefined) chmodSync(abs, mode);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readStdinSync() {
  return readFileSync(0, "utf8");
}

function main(argv) {
  // Runner hand-over: when the trial env is present, runner.ts owns the run.
  if (process.env.MAKEFUN_ENV_URL) {
    return import("./runner.ts").then((m) => m.runRunner());
  }

  let strict = false;
  let dryRun = false;
  let patchPath = null;
  let noMoreOptions = false;
  for (const arg of argv) {
    if (noMoreOptions) {
      if (patchPath === null) patchPath = arg;
      else {
        process.stdout.write("error: too many arguments\n");
        return 1;
      }
      continue;
    }
    if (arg === "--") {
      noMoreOptions = true;
      continue;
    }
    if (arg === "--strict") strict = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(USAGE);
      return 0;
    } else if (arg === "--version" || arg === "-v") {
      process.stdout.write(`mend ${VERSION}\n`);
      return 0;
    } else if (arg.startsWith("-")) {
      process.stdout.write(`error: unknown option ${arg}\n`);
      return 1;
    } else if (patchPath === null) {
      patchPath = arg;
    } else {
      process.stdout.write("error: too many arguments\n");
      return 1;
    }
  }

  let patchText;
  try {
    if (patchPath !== null && patchPath !== "-") {
      patchText = readFileSync(patchPath, "utf8");
    } else {
      patchText = readStdinSync();
    }
  } catch {
    process.stdout.write(`error: cannot read patch file: ${patchPath ?? "-"}\n`);
    return 1;
  }
  if (patchText.trim() === "") {
    process.stdout.write("error: invalid patch: empty patch\n");
    return 1;
  }

  if (patchText.startsWith("\uFEFF")) patchText = patchText.slice(1);
  const parsed = parsePatch(patchText);
  if (!parsed.ok) {
    process.stdout.write(`error: ${parsed.message}\n`);
    return 1;
  }
  let applied;
  try {
    applied = applyEdits(parsed.edits, strict ? 0 : 2);
  } catch (err) {
    process.stdout.write(`error: ${err && err.message ? err.message : String(err)}\n`);
    return 1;
  }
  if (!applied.ok) {
    process.stdout.write(`error: ${applied.message}\n`);
    return 1;
  }
  if (!dryRun) {
    try {
      commitPlan(applied.plan);
    } catch (err) {
      process.stdout.write(`error: ${err && err.message ? err.message : String(err)}\n`);
      return 1;
    }
  }
  for (const file of applied.changed) {
    process.stdout.write(`patched ${file}\n`);
  }
  return 0;
}

// Entry point. main() may return a promise only for the runner hand-over.
// Set exitCode (never process.exit): exiting at once can truncate stdout
// still draining into a pipe, and the grader compares stdout exactly.
const result = main(process.argv.slice(2));
if (result && typeof result.then === "function") {
  result.then(
    (code) => {
      process.exitCode = code ?? 0;
    },
    (err) => {
      process.stderr.write(`mend: ${err && err.message ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
} else {
  process.exitCode = result;
}
