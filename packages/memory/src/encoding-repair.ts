import Database from "better-sqlite3";
import { registerSqlFunctions } from "./migrations.js";

export type EncodingRepairChange = {
  table: string;
  id: string;
  column: string;
  before: string;
  after: string;
};

export type EncodingRepairReport = {
  changed: EncodingRepairChange[];
  suspiciousAfterRepair: EncodingRepairChange[];
};

export type EncodingIssue = {
  table: string;
  id: string;
  column: string;
  value: string;
  reason: string;
  snippet: string;
};

const cp1252: Record<number, number> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f
};

const cp1252MojibakeTrail =
  "[\\u0080-\\u00bf\\u20ac\\u201a-\\u201e\\u2020\\u2021\\u02c6\\u2030\\u0160\\u2039\\u0152\\u017d\\u2018-\\u201d\\u2022\\u2013\\u2014\\u02dc\\u2122\\u0161\\u203a\\u0153\\u017e\\u0178]";

const suspiciousPattern = new RegExp(
  `(?:\\u00c3${cp1252MojibakeTrail}|\\u00c2${cp1252MojibakeTrail}|\\u00e2${cp1252MojibakeTrail}|\\u00c4${cp1252MojibakeTrail}|\\u00c5${cp1252MojibakeTrail}|\\u00c6${cp1252MojibakeTrail}|\\u00e1[\\u00ba\\u00bb]|\\u00ef\\u00bf\\u00bd|\\ufffd)`,
  "u"
);

const suspiciousPatternGlobal = new RegExp(suspiciousPattern.source, "gu");

const vietnamesePattern =
  /[\u00e0\u00e1\u1ea1\u1ea3\u00e3\u00e2\u1ea7\u1ea5\u1ead\u1ea9\u1eab\u0103\u1eb1\u1eaf\u1eb7\u1eb3\u1eb5\u00e8\u00e9\u1eb9\u1ebb\u1ebd\u00ea\u1ec1\u1ebf\u1ec7\u1ec3\u1ec5\u00ec\u00ed\u1ecb\u1ec9\u0129\u00f2\u00f3\u1ecd\u1ecf\u00f5\u00f4\u1ed3\u1ed1\u1ed9\u1ed5\u1ed7\u01a1\u1edd\u1edb\u1ee3\u1edf\u1ee1\u00f9\u00fa\u1ee5\u1ee7\u0169\u01b0\u1eeb\u1ee9\u1ef1\u1eed\u1eef\u1ef3\u00fd\u1ef5\u1ef7\u1ef9\u0111]/giu;

const commonVietnameseWords =
  /(?:s\u1eeda|l\u1ed7i|\u0111\u0103ng|nh\u1eadp|ti\u1ebfng|vi\u1ec7t|d\u1eef|li\u1ec7u|k\u00fd|t\u1ef1|n\u1ed9i|dung|c\u1eadp|nh\u1eadt)/giu;

const replacementRunPattern = /\?{2,}/u;
const replacementRunPatternGlobal = /\?{2,}/gu;
const singleQuestionWordPattern = /[A-Za-z\u00c0-\u1ef9]\?[A-Za-z\u00c0-\u1ef9]/gu;

// Options controlling how aggressive repair is. The cp1252/latin1 round-trip
// decode is principled and always on. `repairQuestionMarks` enables the
// project-specific lookup table that guesses Vietnamese words from `?`
// placeholders — lossy and only appropriate for known legacy data, so it is
// off by default and must be opted into (e.g. `repair encoding --guess-question-marks`).
export type RepairOptions = {
  repairQuestionMarks?: boolean;
};

export function repairMojibakeText(value: string, options: RepairOptions = {}): string {
  const seed = options.repairQuestionMarks ? [value, repairVietnameseQuestionMarks(value)] : [value];
  const candidates = new Set<string>(seed);
  let frontier = [value];

  for (let depth = 0; depth < 4; depth += 1) {
    const next: string[] = [];
    for (const candidate of frontier) {
      for (const repaired of decodeCandidates(candidate, options)) {
        if (candidates.has(repaired)) continue;
        candidates.add(repaired);
        next.push(repaired);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }

  return [...candidates].sort((a, b) => scoreText(b) - scoreText(a))[0] ?? value;
}

export function shouldRepairText(value: string, options: RepairOptions = {}): boolean {
  if (!isSuspiciousEncoding(value)) return false;
  const repaired = repairMojibakeText(value, options);
  return repaired !== value && scoreText(repaired) > scoreText(value);
}

export function isSuspiciousEncoding(value: string): boolean {
  return suspiciousPattern.test(value) || replacementIssueIndex(value) >= 0;
}

export function scanDatabaseEncodingIssues(databasePath: string): EncodingIssue[] {
  const db = new Database(databasePath);
  try {
    return scanDatabase(db);
  } finally {
    db.close();
  }
}

export function repairDatabaseEncoding(databasePath: string, options: RepairOptions = {}): EncodingRepairReport {
  const db = new Database(databasePath);
  const changed: EncodingRepairChange[] = [];
  const suspiciousAfterRepair: EncodingRepairChange[] = [];
  try {
    db.pragma("foreign_keys = ON");
    // Repairs UPDATE the memories table, which fires the FTS triggers that call
    // fold(); register it on this connection or those writes fail.
    registerSqlFunctions(db);
    repairAllTextColumns(db, changed, options);
    collectSuspiciousText(db, suspiciousAfterRepair, options);
  } finally {
    db.close();
  }
  return { changed, suspiciousAfterRepair };
}

function repairAllTextColumns(db: Database.Database, changed: EncodingRepairChange[], options: RepairOptions): void {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;

  for (const { name: table } of tables) {
    const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; type: string; pk: number }>;
    const textColumns = columns.filter((column) => /TEXT/i.test(column.type));
    if (!textColumns.length) continue;
    const idColumn = columns.find((column) => column.pk)?.name ?? textColumns[0]?.name;
    if (!idColumn) continue;

    const selectedColumns = unique([idColumn, ...textColumns.map((column) => column.name)])
      .map((column) => `"${column}"`)
      .join(", ");
    const rows = db.prepare(`SELECT ${selectedColumns} FROM "${table}"`).all() as Record<string, unknown>[];
    const updates: Array<{ id: string; idColumn: string; column: string; value: string }> = [];

    for (const row of rows) {
      const id = String(row[idColumn]);
      for (const { name: column } of textColumns) {
        const value = row[column];
        if (typeof value !== "string" || !shouldRepairText(value, options)) continue;
        const repaired = repairMojibakeText(value, options);
        if (repaired === value) continue;
        changed.push({ table, id, column, before: value, after: repaired });
        updates.push({ id, idColumn, column, value: repaired });
      }
    }

    const transaction = db.transaction(() => {
      for (const update of updates) {
        db.prepare(`UPDATE "${table}" SET "${update.column}" = ? WHERE "${update.idColumn}" = ?`).run(
          update.value,
          update.id
        );
      }
    });
    transaction();
  }
}

function collectSuspiciousText(
  db: Database.Database,
  suspicious: EncodingRepairChange[],
  options: RepairOptions
): void {
  for (const issue of scanDatabase(db)) {
    suspicious.push({
      table: issue.table,
      id: issue.id,
      column: issue.column,
      before: issue.value,
      after: repairMojibakeText(issue.value, options)
    });
  }
}

function scanDatabase(db: Database.Database): EncodingIssue[] {
  const issues: EncodingIssue[] = [];
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;

  for (const { name: table } of tables) {
    const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; type: string; pk: number }>;
    const textColumns = columns.filter((column) => /TEXT/i.test(column.type));
    if (!textColumns.length) continue;
    const idColumn = columns.find((column) => column.pk)?.name ?? textColumns[0]?.name;
    if (!idColumn) continue;

    const selectedColumns = unique([idColumn, ...textColumns.map((column) => column.name)])
      .map((column) => `"${column}"`)
      .join(", ");
    const rows = db.prepare(`SELECT ${selectedColumns} FROM "${table}"`).all() as Record<string, unknown>[];
    for (const row of rows) {
      const id = String(row[idColumn]);
      for (const { name: column } of textColumns) {
        const value = row[column];
        if (typeof value === "string") {
          const reason = encodingIssueReason(value);
          if (reason) {
            issues.push({ table, id, column, value, reason, snippet: encodingIssueSnippet(value) ?? sampleIssueText(value) });
          }
        }
      }
    }
  }
  return issues;
}

export function encodingIssueReason(value: string): string | undefined {
  if (/\ufffd/.test(value)) return "replacement character found; original bytes may be lost";
  if (replacementIssueIndex(value) >= 0) return "question-mark replacement pattern found";
  if (suspiciousPattern.test(value)) return "mojibake pattern found";
  return undefined;
}

export function encodingIssueSnippet(value: string): string | undefined {
  const replacementIndex = replacementIssueIndex(value);
  if (replacementIndex >= 0) return snippetAround(value, replacementIndex);
  const suspiciousIndex = firstMatchIndex(value, suspiciousPatternGlobal);
  if (suspiciousIndex >= 0) return snippetAround(value, suspiciousIndex);
  return undefined;
}

function replacementIssueIndex(value: string): number {
  const replacementRunIndex = firstMatchIndex(value, replacementRunPatternGlobal);
  if (replacementRunIndex >= 0) return replacementRunIndex;

  singleQuestionWordPattern.lastIndex = 0;
  for (const match of value.matchAll(singleQuestionWordPattern)) {
    const questionIndex = (match.index ?? 0) + 1;
    if (isLikelyUrlQueryMarker(value, questionIndex)) continue;
    singleQuestionWordPattern.lastIndex = 0;
    return match.index ?? questionIndex;
  }
  singleQuestionWordPattern.lastIndex = 0;
  return -1;
}

function isLikelyUrlQueryMarker(value: string, questionIndex: number): boolean {
  const tokenStart = findTokenStart(value, questionIndex);
  const tokenEnd = findTokenEnd(value, questionIndex);
  const token = value.slice(tokenStart, tokenEnd);
  const query = value.slice(questionIndex + 1, tokenEnd);
  if (!query.includes("=")) return false;
  return /(?:^|[/:.])[\w.-]+$/u.test(value.slice(tokenStart, questionIndex)) && /^[\w.-]+=/u.test(query);
}

function findTokenStart(value: string, index: number): number {
  let start = index;
  while (start > 0 && !/\s|["'`<>()\[\]{}]/u.test(value[start - 1] ?? "")) start -= 1;
  return start;
}

function findTokenEnd(value: string, index: number): number {
  let end = index;
  while (end < value.length && !/\s|["'`<>()\[\]{}]/u.test(value[end] ?? "")) end += 1;
  return end;
}

function decodeCandidates(value: string, options: RepairOptions): string[] {
  return [
    ...(options.repairQuestionMarks ? [repairVietnameseQuestionMarks(value)] : []),
    decodeAsUtf8FromBytes(value, "cp1252"),
    decodeAsUtf8FromBytes(value, "latin1")
  ].filter(
    (candidate, index, all) => candidate !== value && all.indexOf(candidate) === index
  );
}

function repairVietnameseQuestionMarks(value: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/\bhi\?{3}n\b/giu, "hi\u1ec7n"],
    [/\bt\?{3}i\b/giu, "t\u1ea1i"],
    [/\bt\?{2}i\b/giu, "t\u00f4i"],
    [/\bth\?{3}y\b/giu, "th\u1ea5y"],
    [/\bph\?{3}n\b/giu, "ph\u1ea7n"],
    [/\bt\?{3}o\b/giu, "t\u1ea1o"],
    [/\bschem\b/giu, "schem"],
    [/\blinh ki\?{3}n\b/giu, "linh ki\u1ec7n"],
    [/\bch\?{2}a\b/giu, "ch\u01b0a"],
    [/\bch\?{2}n(?=$|[^A-Za-z0-9_])/giu, "ch\u00e2n"],
    [/\bg\?{3}n g\?{2}ng\b/giu, "g\u1ecdn g\u00e0ng"],
    [/\?\?\?\?i l\?{2}c\b/giu, "\u0111\u00f4i l\u00fac"],
    [/\bkh\?{2}ng\b/giu, "kh\u00f4ng"],
    [/\bv\?{2}(?=$|[^A-Za-z0-9_])/giu, "v\u00e0"],
    [/\bv\?{2}\b/giu, "v\u00e0"],
    [/\bth\?{5}ng\b/giu, "th\u01b0\u1eddng"],
    [/\bto\?{2}n b\?{3}(?=$|[^A-Za-z0-9_])/giu, "to\u00e0n b\u1ed9"],
    [/\bto\?{2}n b\u1ecb(?=$|[^A-Za-z0-9_])/giu, "to\u00e0n b\u1ed9"],
    [/\bb\?{3}(?=$|[^A-Za-z0-9_])/giu, "b\u1ecb"],
    [/\bb\?{3}\b/giu, "b\u1ecb"],
    [/\bs\?{3}p x\?{3}p\b/giu, "s\u1eafp x\u1ebfp"],
    [/\?\?\?\? l\?{2}n nhau\b/giu, "\u0111\u00e8 l\u00ean nhau"],
    [/\bg\?{2}y kh\?{2} nh\?(?=$|[^A-Za-z0-9_])/giu, "g\u00e2y kh\u00f3 nh\u00ecn"],
    [/\bnh\u00ecn\?n\b/giu, "nh\u00ecn"],
    [/\bg\?{2}y\b/giu, "g\u00e2y"],
    [/\bkh\?{2}\b/giu, "kh\u00f3"],
    [/\bmu\?{3}n\b/giu, "mu\u1ed1n"],
    [/\bb\u1ecbn v\u00e0\?(?=$|[^A-Za-z0-9_])/giu, "b\u1ea3n v\u1ebd"],
    [/\bthi\?{3}t k\?{3}(?=$|[^A-Za-z0-9_])/giu, "thi\u1ebft k\u1ebf"],
    [/\bph\?{3}i\b/giu, "ph\u1ea3i"],
    [/\br\?{2} r\?{2}ng\b/giu, "r\u00f5 r\u00e0ng"],
    [/\bc\u00f3\?m\b/giu, "c\u1ee5m"],
    [/\bch\?{3}c n\?{2}ng\b/giu, "ch\u1ee9c n\u0103ng"],
    [/\bc\?{2}c\b/giu, "c\u00e1c"],
    [/\bc\u00f3\?a\b/giu, "c\u1ee7a"],
    [/\bn\?{2}n\b/giu, "n\u00ean"],
    [/\?{7}c\b/giu, "\u0111\u01b0\u1ee3c"],
    [/\bk\?{3}t n\?{3}i\b/giu, "k\u1ebft n\u1ed1i"],
    [/\bb\u1ecbng\b/giu, "b\u1eb1ng"],
    [/\bn\?{3}i b\u1ecb(?=$|[^A-Za-z0-9_])/giu, "n\u1ed9i b\u1ed9"],
    [/\bho\?{3}c\b/giu, "ho\u1eb7c"],
    [/\bn\?{3}u\b/giu, "n\u1ebfu"],
    [/\bl\?{2}m\b/giu, "l\u00e0m"],
    [/\bnhi\?{3}u\b/giu, "nhi\u1ec1u"],
    [/\bph\?{3}m vi\b/giu, "ph\u1ea1m vi"],
    [/\?\?\?\? verify\b/giu, "\u0111\u00e3 verify"],
    [/\bt\?{3}ng\b/giu, "t\u1eebng"],
    [/\bT\?{2}m t\?{3}t\b/giu, "T\u00f3m t\u1eaft"],
    [/\bA \?{3} Ch\?{3}ng \?{4}:/giu, "A - Ch\u1ed1ng \u0111\u00e8:"],
    [/\bA \?{3} Ch\u1ed1ng \?{4}:/giu, "A - Ch\u1ed1ng \u0111\u00e8:"],
    [/\bCh\?{3}ng\b/giu, "Ch\u1ed1ng"],
    [/\bvi\?{3}t\b/giu, "vi\u1ebft"],
    [/\bth\?{3}t c\u00f3\?a\b/giu, "th\u1eadt c\u1ee7a"],
    [/\bth\?{3}t c\u1ee7a\b/giu, "th\u1eadt c\u1ee7a"],
    [/\bt\?{3} pin\b/giu, "t\u1eeb pin"],
    [/\bk\?{3}p zone\b/giu, "k\u1eb9p zone"],
    [/\bd\?{3}n g\?{2}c\b/giu, "d\u00ednh g\u00f3c"],
    [/\?{5} b\?{2} vi\?{3}c\b/giu, "\u0111\u1ec3 b\u00f9 vi\u1ec7c"],
    [/\?{3} test\b/giu, "\u0110\u00e3 test"],
    [/\bh\?{3}t\b/giu, "h\u1ebft"],
    [/\bB \?{3} Kh\?{3}p\b/giu, "B - Kh\u1edbp"],
    [/\bd\?{2}n\b/giu, "d\u1ecdn"],
    [/\bd\?{2}ng\b/giu, "d\u00f9ng"],
    [/\bh\?{2}y\b/giu, "h\u00e3y"],
    [/\bth\?{2}m\b/giu, "th\u00eam"],
    [/\bth\u1eedm\b/giu, "th\u00eam"],
    [/\bth\?{3}(?=$|[^A-Za-z0-9_])/giu, "th\u1eed"],
    [/\bth\?{2}\b/giu, "th\u1eed"],
    [/\bm\?{3}ch\b/giu, "m\u1ea1ch"],
    [/\bnh\?{2}y\b/giu, "nh\u00e1y"],
    [/\bv\?{3}i\b/giu, "v\u1edbi"],
    [/\bsau \?{4}\b/giu, "sau \u0111\u00f3"],
    [/\bsau \?{4}(?=$|[^A-Za-z0-9_])/giu, "sau \u0111\u00f3"],
    [/\bki\?{3}m tra\b/giu, "ki\u1ec3m tra"],
    [/\bl\?{3}i\b/giu, "l\u1ea1i"],
    [/\bn\?{3}i dung\b/giu, "n\u1ed9i dung"],
    [/\bph\?{4}ng \?{2}n\b/giu, "ph\u01b0\u01a1ng \u00e1n"],
    [/\?{4} th\u00eam\b/giu, "\u0111\u00e3 th\u00eam"],
    [/\?{3} ch\?{3}y\b/giu, "\u0111\u1ec3 ch\u1ea1y"],
    [/\bch\?{3}y\b/giu, "ch\u1ea1y"],
    [/\bbi\?{3}t\b/giu, "bi\u1ebft"],
    [/\bc\?{2}(?=$|[^A-Za-z0-9_])/giu, "c\u00f3"],
    [/\bm\?{3}i\b/giu, "m\u1ecdi"],
    [/\bm\?{3}t l\?{3}nh\b/giu, "m\u1ed9t l\u1ec7nh"],
    [/\bkh\u00f4ng c\u00f3\?n\b/giu, "kh\u00f4ng c\u1ea7n"],
    [/\bkho\?{2} c\?{2}c b\u1ecbt bi\?{3}n\b/giu, "kh\u00f3a c\u00e1c b\u1ea5t bi\u1ebfn"],
    [/\bkho\?{2} c\u00e1c b\u1ecbt bi\?{3}n\b/giu, "kh\u00f3a c\u00e1c b\u1ea5t bi\u1ebfn"],
    [/\bkh\u00f4ng \?{4}(?=$|[^A-Za-z0-9_])/giu, "kh\u00f4ng \u0111\u00e8"],
    [/`pins` \?{4} resolve\b/giu, "`pins` \u0111\u00e3 resolve"],
    [/\bpins \?{4} resolve\b/giu, "pins \u0111\u00e3 resolve"],
    [/\btr\?{3}c c\u1ee5m ngu\?{3}n\b/giu, "tr\u1ee5c c\u1ee5m ngu\u1ed3n"],
    [/\btr\?{3}c c\u1ee5m\b/giu, "tr\u1ee5c c\u1ee5m"],
    [/\bgi\?{3} 0\?{2}/giu, "gi\u1eef 0\u00b0"],
    [/\btr\?{3} m\?{3}ng\b/giu, "tr\u1ea3 m\u1ea3ng"],
    [/\bto\?{3} \?{5} tuy\?{3}t \?{5}i\b/giu, "tọa \u0111\u1ed9 tuy\u1ec7t \u0111\u1ed1i"],
    [/\bcap \?{3} 90\?{2}/giu, "cap -> 90\u00b0"],
    [/\bIC \?{3} 0\?{2}/giu, "IC -> 0\u00b0"],
    [/\bgit commit \?{3} `\/clear`/giu, "git commit -> `/clear`"],
    [/\bprompt \?{3} ask\b/giu, "prompt - ask"],
    [/\brequests \?{3} propose\b/giu, "requests - propose"],
    [/"fix all bugs" \?{3} "which file\/function\?"/giu, "\"fix all bugs\" -> \"which file/function?\""],
    [/"explain codebase" \?{3} "which module\?"/giu, "\"explain codebase\" -> \"which module?\""],
    [/"make it better" \?{3} "what/giu, "\"make it better\" -> \"what"],
    [/\bProject \?{3}(?=\s*`)/giu, "Project -"],
    [/\bGlobal \?{3}(?=\s*`)/giu, "Global -"],
    [/\?\?p d\?{3}ng\b/giu, "\u00e1p d\u1ee5ng"],
    [/\?{7}c n\?{3}p\b/giu, "\u0111\u01b0\u1ee3c n\u1ea1p"]
  ];

  let repaired = value;
  for (const [pattern, replacement] of replacements) {
    repaired = repaired.replace(pattern, replacement);
  }
  return repaired;
}

function decodeAsUtf8FromBytes(value: string, mode: "cp1252" | "latin1"): string {
  const bytes: number[] = [];
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0xff) {
      bytes.push(code);
    } else if (mode === "cp1252" && cp1252[code] !== undefined) {
      bytes.push(cp1252[code]);
    } else {
      bytes.push(...Buffer.from(char, "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function scoreText(value: string): number {
  let score = 0;
  const suspiciousMatches = value.match(suspiciousPatternGlobal);
  score -= (suspiciousMatches ?? []).length * 15;
  score -= (value.match(/\ufffd/g) ?? []).length * 50;
  score -= (value.match(/\?/g) ?? []).length * 4;
  score -= (value.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g) ?? []).length * 30;
  score += (value.match(vietnamesePattern) ?? []).length * 6;
  score += (value.match(commonVietnameseWords) ?? []).length * 20;
  score += (value.match(/[a-z0-9 .,;:_/\\()[\]{}'"`-]/gi) ?? []).length;
  return score;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function firstMatchIndex(value: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  const match = pattern.exec(value);
  pattern.lastIndex = 0;
  return match?.index ?? -1;
}

function snippetAround(value: string, index: number): string {
  const normalized = value.replace(/\s+/g, " ");
  const normalizedIndex = Math.min(index, normalized.length);
  const start = Math.max(0, normalizedIndex - 70);
  const end = Math.min(normalized.length, normalizedIndex + 90);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < normalized.length ? "..." : "";
  return `${prefix}${normalized.slice(start, end)}${suffix}`;
}

function sampleIssueText(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 160);
}
