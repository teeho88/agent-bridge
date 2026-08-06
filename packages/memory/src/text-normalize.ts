// Fold a string to a diacritic-insensitive, lowercase form used for indexing
// and matching. This lets "dang nhap" and the accented Vietnamese form match.
//
// NFD splits most accented Latin letters into base + combining marks, which we
// strip (U+0300-U+036F). Vietnamese "d-stroke" is a distinct letter (NOT base +
// combining), so NFD leaves it intact - we map it explicitly. The original text
// is always kept for display; only the indexed/queried copy is folded.
export function foldDiacritics(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}
