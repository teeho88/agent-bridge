import { cellWidth, clean, fit } from "./view.js";

export type Target =
  | { kind: "new-task" }
  | { kind: "new-terminal"; agent: "codex" | "antigravity" | "claude" }
  | { kind: "section"; name: string }
  | { kind: "action"; path: string }
  | { kind: "graph-node"; path: string }
  | { kind: "network-node"; path: string }
  | { kind: "network-page"; page: number }
  | { kind: "screen"; index: number }
  | { kind: "row"; index: number }
  | { kind: "field"; index: number }
  | { kind: "choice"; value: string }
  | { kind: "editor"; start: number; text: string }
  | { kind: "scroll"; area: "list" | "detail" | "preview"; fraction: number }
  | { kind: "command"; name: "actions" | "refresh" | "search" | "help" | "quit" | "open" | "select" | "back" | "review" | "execute" | "clear" | "previous" | "next" | "select-all" | "refresh-models" | "nodes" };
export interface HitRegion { x: number; y: number; width: number; height: number; target: Target }

export const theme = {
  base: "38;2;203;213;225;48;2;11;17;29",
  muted: "38;2;118;137;161;48;2;11;17;29",
  panel: "38;2;203;213;225;48;2;16;25;41",
  border: "38;2;48;66;90;48;2;11;17;29",
  accent: "1;38;2;94;234;212;48;2;11;17;29",
  selected: "1;38;2;224;242;254;48;2;29;66;96",
  button: "38;2;203;213;225;48;2;27;42;61",
  primary: "1;38;2;8;35;45;48;2;94;234;212",
  danger: "1;38;2;254;202;202;48;2;96;30;43",
  success: "38;2;134;239;172;48;2;11;17;29",
  editFresh: "1;38;2;74;222;128;48;2;11;17;29",
  editToday: "38;2;147;197;253;48;2;11;17;29",
  caret: "38;2;11;17;29;48;2;224;242;254",
};

export class Surface {
  readonly hits: HitRegion[] = [];
  private cells: { text: string; style: string }[][];
  constructor(readonly width: number, readonly height: number, private colors: boolean) {
    this.cells = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ text: " ", style: theme.base })));
  }

  text(x: number, y: number, value: unknown, width = this.width - x, style: string = theme.base): void {
    if (y < 0 || y >= this.height) return;
    let column = x;
    for (const char of fit(value, Math.max(0, width))) {
      const size = cellWidth(char);
      if (!size) { if (column > 0 && column <= this.width) this.cells[y][column - 1].text += char; continue; }
      if (column >= 0 && column + size <= this.width) {
        this.cells[y][column] = { text: char, style };
        if (size === 2) this.cells[y][column + 1] = { text: "", style };
      }
      column += size;
    }
  }

  box(x: number, y: number, width: number, height: number, title = ""): void {
    if (width < 3 || height < 3) return;
    this.text(x, y, `╭${"─".repeat(width - 2)}╮`, width, theme.border);
    for (let row = y + 1; row < y + height - 1; row++) {
      this.text(x, row, "│", 1, theme.border);
      this.text(x + width - 1, row, "│", 1, theme.border);
    }
    this.text(x, y + height - 1, `╰${"─".repeat(width - 2)}╯`, width, theme.border);
    if (title) this.text(x + 2, y, ` ${title} `, Math.min(width - 4, [...title].length + 2), theme.accent);
  }

  hit(x: number, y: number, width: number, height: number, target: Target): void {
    this.hits.push({ x, y, width, height, target });
  }

  button(x: number, y: number, label: string, target: Target, style: string = theme.button): number {
    const width = [...clean(label)].reduce((sum, char) => sum + cellWidth(char), 0) + 4;
    if (x + width > this.width) return x;
    this.text(x, y, `[ ${label} ]`, width, style);
    this.hit(x, y, width, 1, target);
    return x + width + 1;
  }

  scrollbar(x: number, y: number, height: number, total: number, visible: number, position: number, area: "list" | "detail" | "preview"): void {
    if (total <= visible || height < 1) return;
    const thumb = Math.max(1, Math.floor(height * visible / total));
    const top = Math.round((height - thumb) * position / Math.max(1, total - visible));
    for (let row = 0; row < height; row++) {
      this.text(x, y + row, row >= top && row < top + thumb ? "┃" : "│", 1, row >= top && row < top + thumb ? theme.accent : theme.border);
      this.hit(x, y + row, 1, 1, { kind: "scroll", area, fraction: row / Math.max(1, height - 1) });
    }
  }

  frame(): string {
    return this.cells.map((row) => {
      let result = "";
      let previous = "";
      for (const cell of row) {
        if (this.colors && cell.style !== previous) { result += `\x1b[${cell.style}m`; previous = cell.style; }
        result += cell.text;
      }
      return result + (this.colors ? "\x1b[0m" : "");
    }).join("\r\n");
  }
}

export function editorLines(value: string, width: number): { text: string; start: number }[] {
  const result: { text: string; start: number }[] = [];
  let text = "";
  let start = 0;
  let used = 0;
  const chars = [...value];
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index];
    if (char === "\n") { result.push({ text, start }); text = ""; start = index + 1; used = 0; continue; }
    const size = cellWidth(char);
    if (used + size > width) { result.push({ text, start }); text = ""; start = index; used = 0; }
    text += char;
    used += size;
  }
  result.push({ text, start });
  return result;
}

export function cursorAt(text: string, column: number): number {
  let used = 0;
  let index = 0;
  for (const char of text) {
    if (used + cellWidth(char) > column) break;
    used += cellWidth(char);
    index++;
  }
  return index;
}
