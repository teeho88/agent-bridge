import { StringDecoder } from "node:string_decoder";

export interface MouseEvent {
  x: number;
  y: number;
  button: number;
  release: boolean;
  motion: boolean;
  wheel: number;
}

export const mouseEnable = "\x1b[?1000h\x1b[?1006h";
export const mouseDisable = "\x1b[?1000l\x1b[?1006l";

export class TerminalInput {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private pasted = false;
  private timer?: NodeJS.Timeout;

  constructor(private keyboard: (text: string) => void, private mouse: (event: MouseEvent) => void) {}

  feed(chunk: Buffer | string): void {
    if (this.timer) clearTimeout(this.timer);
    this.pending += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let text = "";
    const flushText = (): void => { if (text) { this.keyboard(text); text = ""; } };
    while (this.pending) {
      const value = this.pending;
      const marker = this.pasted ? "\x1b[201~" : "\x1b[200~";
      if (value.startsWith(marker)) {
        this.pasted = !this.pasted;
        text += marker;
        this.pending = value.slice(marker.length);
        continue;
      }
      if (marker.startsWith(value) || (!this.pasted && ["\x1b[<", "\x1b[M"].some((prefix) => prefix.startsWith(value)))) break;
      if (!this.pasted && value.startsWith("\x1b[<")) {
        const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(value);
        if (match) {
          flushText();
          const code = Number(match[1]);
          const x = Number(match[2]) - 1;
          const y = Number(match[3]) - 1;
          if (Number.isSafeInteger(x) && Number.isSafeInteger(y) && x >= 0 && y >= 0) this.mouse({
            x, y, button: code & 3, release: match[4] === "m", motion: Boolean(code & 32), wheel: code & 64 ? (code & 1 ? 1 : -1) : 0,
          });
          this.pending = value.slice(match[0].length);
          continue;
        }
        if (/^\x1b\[<[\d;]*$/.test(value) && value.length < 64) break;
      }
      if (!this.pasted && value.startsWith("\x1b[M")) {
        if ([...value].length < 6) break;
        flushText();
        const chars = [...value.slice(3)];
        const code = chars[0].charCodeAt(0) - 32;
        this.mouse({ x: chars[1].charCodeAt(0) - 33, y: chars[2].charCodeAt(0) - 33,
          button: code & 3, release: (code & 3) === 3, motion: Boolean(code & 32), wheel: code & 64 ? (code & 1 ? 1 : -1) : 0 });
        this.pending = chars.slice(3).join("");
        continue;
      }
      text += value[0];
      this.pending = value.slice(1);
    }
    flushText();
    if (this.pending) this.timer = setTimeout(() => {
      const remaining = this.pending;
      this.pending = "";
      this.keyboard(remaining);
    }, 80);
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.pending = "";
  }
}
