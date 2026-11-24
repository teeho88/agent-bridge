import { array, type Data } from "./service.js";
import { Surface, theme } from "./surface.js";
import { cellWidth, clean } from "./view.js";
import { editHighlight, editLevels } from "./edit-highlight.js";

function tail(value: string, width: number): string {
  const chars = [...clean(value)];
  if (chars.reduce((sum, char) => sum + cellWidth(char), 0) <= width) return chars.join("");
  let result = "";
  let used = 1;
  for (const char of chars.reverse()) {
    if (used + cellWidth(char) > width) break;
    result = char + result;
    used += cellWidth(char);
  }
  return `…${result}`;
}

export function renderNetwork(ui: Surface, graph: Data, selected: Data, page: number, x: number, y: number, width: number, height: number, now = Date.now()): void {
  const nodes = array(graph.nodes);
  const nodeByPath = new Map(nodes.map((node) => [node.path, node]));
  const path = String(selected.path ?? "");
  const selectedEdit = editHighlight(selected, now);
  const nodeScore = selected.score ?? selected.structuralScore;
  const score = typeof nodeScore === "number" ? `Score ${nodeScore.toFixed(2)} · ` : "";
  if (!path) {
    ui.text(x, y, nodes.length ? "No matching files. Change the filter." : "No indexed files. Build the repository graph.", width, theme.muted);
    if (height >= 3) {
      const end = ui.button(x, y + 2, "Build graph", { kind: "action", path: "graph/build" }, theme.primary);
      if (end + 14 <= x + width) ui.button(end, y + 2, "Settings", { kind: "section", name: "Settings" });
    }
    if (height >= 5) ui.text(x, y + 4, "If Build finds no files, check include/ignore paths in Settings.", width, theme.muted);
    return;
  }
  if (height < 4) {
    ui.text(x, y, "Enlarge terminal to show the network.", width, theme.muted);
    return;
  }
  const edges = array(graph.edges);
  const incoming = [...new Set((Array.isArray(selected.incoming) ? selected.incoming : edges.filter((edge) => edge.target === path).map((edge) => edge.source)).filter((item): item is string => typeof item === "string"))];
  const outgoing = [...new Set((Array.isArray(selected.outgoing) ? selected.outgoing : edges.filter((edge) => edge.source === path).map((edge) => edge.target)).filter((item): item is string => typeof item === "string"))];
  const paging = (row: number, current: number, pages: number): void => {
    let column = x;
    const button = (label: string, next: number): void => {
      if (column + [...label].length + 4 > x + width) return;
      column = ui.button(column, row, label, { kind: "network-page", page: next });
    };
    if (current > 0) button("‹ Links", current - 1);
    if (current < pages - 1) button("Links ›", current + 1);
    ui.text(column, row, `${current + 1}/${pages}`, Math.max(0, x + width - column), theme.muted);
  };
  if (width < 62 && height >= 8) {
    const incomingSet = new Set(incoming);
    const outgoingSet = new Set(outgoing);
    const links = [...new Set([...incoming, ...outgoing])].map((file) => ({
      file,
      prefix: incomingSet.has(file) ? outgoingSet.has(file) ? "↔" : "←" : "→",
      label: incomingSet.has(file) ? outgoingSet.has(file) ? "both" : "used by" : "imports",
    }));
    const rows = height - 7;
    const pages = Math.max(1, Math.ceil(links.length / rows));
    const current = Math.max(0, Math.min(page, pages - 1));
    ui.text(x, y, `${score}${incoming.length} used by · ${outgoing.length} imports`, width, theme.muted);
    ui.box(x, y + 1, width, 3, `SELECTED${selectedEdit ? ` · ${selectedEdit.label}` : ""}`);
    ui.text(x + 1, y + 2, tail(path, width - 2), width - 2, theme.selected);
    ui.hit(x, y + 1, width, 3, { kind: "network-node", path });
    links.slice(current * rows, (current + 1) * rows).forEach((link, index) => {
      const node = nodeByPath.get(link.file) ?? {};
      const edit = editHighlight(node, now);
      const prefix = `${link.prefix} ${link.label}: ${edit ? `[${edit.label}] ` : ""}${node.briefStale ? "[STALE] " : ""}`;
      ui.text(x, y + 4 + index, prefix, Math.min(width, prefix.length), edit?.style ?? theme.accent);
      ui.text(x + prefix.length, y + 4 + index, tail(link.file, width - prefix.length), Math.max(0, width - prefix.length), edit?.style ?? (node.briefStale ? theme.danger : theme.button));
      ui.hit(x, y + 4 + index, width, 1, { kind: "network-node", path: link.file });
    });
    if (!links.length) ui.text(x, y + 4, "Isolated file · no internal links", width, theme.muted);
    if (pages > 1) paging(y + height - 2, current, pages);
    ui.text(x, y + height - 1, "← used by · → imports · ↔ both", width, theme.muted);
    return;
  }
  if (height < 8) {
    const size = Math.floor((width - 8) / 3);
    const files = [incoming[Math.min(page, Math.max(0, incoming.length - 1))], path, outgoing[Math.min(page, Math.max(0, outgoing.length - 1))]];
    const labels = ["USED BY", "SELECTED", "IMPORTS"];
    files.forEach((file, index) => {
      const column = x + index * (size + 4);
      ui.text(column, y, labels[index], size, theme.accent);
      const node = file ? nodeByPath.get(file) ?? {} : {};
      const edit = editHighlight(node, now);
      ui.text(column, y + 1, file ? tail(file, size) : "(none)", size, index === 1 ? theme.selected : edit?.style ?? (node.briefStale ? theme.danger : theme.button));
      if (file) ui.hit(column, y + 1, size, 1, { kind: "network-node", path: file });
      if (index < 2 && files[index] && files[index + 1]) ui.text(column + size, y + 1, " ─▶ ", 4, theme.accent);
    });
    ui.text(x, y + 2, `${selectedEdit ? `${selectedEdit.label} · ` : ""}${path}`, width, selectedEdit?.style ?? theme.accent);
    ui.text(x, y + 3, `${score}${incoming.length} used by · ${outgoing.length} imports · ↑/↓: browse`, width, theme.muted);
    if (height > 4 && Math.max(incoming.length, outgoing.length) > 1) {
      paging(y + 4, Math.max(0, Math.min(page, Math.max(incoming.length, outgoing.length) - 1)), Math.max(incoming.length, outgoing.length));
    }
    return;
  }
  const detailed = height >= 13;
  const cardHeight = detailed ? 4 : 3;
  const stride = cardHeight + 1;
  const top = y + (height < 11 ? 2 : 3);
  const rows = Math.max(1, Math.floor((height - (top - y) - 3) / stride));
  const pages = Math.max(1, Math.ceil(Math.max(incoming.length, outgoing.length) / rows));
  const current = Math.max(0, Math.min(page, pages - 1));
  const cardWidth = Math.floor((width - 8) / 3);
  const gap = Math.floor((width - cardWidth * 3) / 2);
  const columns = [x, x + cardWidth + gap, x + 2 * (cardWidth + gap)];
  const centerY = top + Math.floor((rows - 1) / 2) * stride;
  const centerLine = centerY + 1;
  ui.text(x, y, `${nodes.length} files · ${edges.length} links · click a node · ↑/↓: browse files`, width, theme.muted);
  if (top - y >= 3) {
    let column = x;
    for (const level of editLevels) {
      const label = `${level.label}  `;
      if (column + label.length > x + width) break;
      ui.text(column, y + 1, label, label.length, level.style);
      column += label.length;
    }
  }
  [`USED BY (${incoming.length})`, "SELECTED", `IMPORTS (${outgoing.length})`].forEach((label, index) => ui.text(columns[index], top - 1, label, cardWidth, theme.accent));

  const card = (file: string, column: number, row: number, active = false): void => {
    const node = nodeByPath.get(file) ?? {};
    const edit = editHighlight(node, now);
    const style = active ? theme.selected : edit?.style ?? (node.briefStale ? theme.danger : theme.button);
    const normalized = file.replace(/\\/g, "/");
    const split = normalized.lastIndexOf("/");
    const name = normalized.slice(split + 1);
    const directory = split < 0 ? "./" : normalized.slice(0, split + 1);
    const border = edit?.style ?? (active ? theme.accent : node.briefStale ? theme.danger : theme.border);
    ui.text(column, row, `${active ? "╔" : "╭"}${(active ? "═" : "─").repeat(cardWidth - 2)}${active ? "╗" : "╮"}`, cardWidth, border);
    for (let offset = 1; offset < cardHeight - 1; offset++) {
      ui.text(column, row + offset, active ? "║" : "│", 1, border);
      ui.text(column + cardWidth - 1, row + offset, active ? "║" : "│", 1, border);
    }
    ui.text(column, row + cardHeight - 1, `${active ? "╚" : "╰"}${(active ? "═" : "─").repeat(cardWidth - 2)}${active ? "╝" : "╯"}`, cardWidth, border);
    ui.text(column + 1, row + 1, tail(detailed ? name : file, cardWidth - 2), cardWidth - 2, style);
    if (detailed) ui.text(column + 1, row + 2, tail(directory, cardWidth - 2), cardWidth - 2, theme.muted);
    if (cardWidth >= 16 && (node.briefStale || edit)) {
      const status = ` ${node.briefStale ? `STALE${edit?.label.startsWith("EDIT ") ? ` ${edit.label.slice(5)}` : ""}` : edit?.label} `;
      ui.text(column + cardWidth - status.length - 2, row, status, status.length, node.briefStale ? theme.danger : edit!.style);
    }
    ui.hit(column, row, cardWidth, cardHeight, { kind: "network-node", path: file });
  };
  const branch = (files: string[], left: boolean): void => {
    const visible = files.slice(current * rows, (current + 1) * rows);
    if (!visible.length) {
      ui.text(left ? columns[0] : columns[2], centerLine, files.length ? "(no more on this page)" : "(none)", cardWidth, theme.muted);
      return;
    }
    const trunk = left ? columns[1] - 2 : columns[1] + cardWidth + 1;
    const lines = visible.map((_, index) => top + index * stride + 1);
    const joints = new Map<string, { column: number; row: number; mask: number }>();
    const joint = (column: number, row: number, mask: number): void => {
      const key = `${column},${row}`;
      joints.set(key, { column, row, mask: (joints.get(key)?.mask ?? 0) | mask });
    };
    const first = Math.min(centerLine, ...lines);
    const last = Math.max(centerLine, ...lines);
    for (let row = first; row < last; row++) {
      joint(trunk, row, 4);
      joint(trunk, row + 1, 1);
    }
    const horizontal = (start: number, end: number, row: number): void => {
      for (let column = start; column < end; column++) {
        joint(column, row, 2);
        joint(column + 1, row, 8);
      }
    };
    visible.forEach((file, index) => {
      const line = lines[index];
      if (left) horizontal(columns[0] + cardWidth, trunk, line);
      else {
        horizontal(trunk, columns[2] - 1, line);
      }
      card(file, left ? columns[0] : columns[2], top + index * stride);
    });
    if (left) {
      horizontal(trunk, columns[1] - 1, centerLine);
    } else horizontal(columns[1] + cardWidth, trunk, centerLine);
    const glyphs: Record<number, string> = { 1: "│", 2: "─", 3: "└", 4: "│", 5: "│", 6: "┌", 7: "├", 8: "─", 9: "┘", 10: "─", 11: "┴", 12: "┐", 13: "┤", 14: "┬", 15: "┼" };
    for (const point of joints.values()) ui.text(point.column, point.row, glyphs[point.mask], 1, theme.accent);
    if (left) ui.text(columns[1] - 1, centerLine, "▶", 1, theme.accent);
    else for (const line of lines) ui.text(columns[2] - 1, line, "▶", 1, theme.accent);
  };
  branch(incoming, true);
  branch(outgoing, false);
  card(path, columns[1], centerY, true);
  const bottom = top + rows * stride;
  if (pages > 1) {
    paging(bottom, current, pages);
  } else ui.text(x, bottom, incoming.length || outgoing.length ? "Arrows: source imports target" : "Isolated file · no internal imports or dependents", width, theme.muted);
  if (bottom + 1 < y + height) ui.text(x, bottom + 1, path, width, theme.accent);
  if (bottom + 2 < y + height) ui.text(x, bottom + 2, `${score}${selectedEdit ? `${selectedEdit.label} · ` : ""}${incoming.length} used by · ${outgoing.length} imports · ${selected.language ?? "source"} · ${selected.symbols ?? 0} symbols${selected.briefStale ? " · stale brief" : ""}`, width, theme.muted);
  if (bottom + 3 < y + height) ui.text(x, bottom + 3, selected.brief ?? "Enter: file details · Nodes / n: choose a file", width, theme.base);
}
