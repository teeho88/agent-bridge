import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  encodingIssueSnippet,
  encodingIssueReason,
  repairDatabaseEncoding,
  repairMojibakeText,
  scanDatabaseEncodingIssues,
  shouldRepairText
} from "./encoding-repair.js";
import { SQLiteMemoryStore } from "./sqlite-store.js";

const correct = "S\u1eeda l\u1ed7i \u0111\u0103ng nh\u1eadp ti\u1ebfng Vi\u1ec7t";
const onceBroken = Buffer.from(correct, "utf8").toString("latin1");
const twiceBroken = Buffer.from(onceBroken, "utf8").toString("latin1");

describe("encoding repair", () => {
  it("repairs single-layer Vietnamese mojibake", () => {
    expect(shouldRepairText(onceBroken)).toBe(true);
    expect(repairMojibakeText(onceBroken)).toBe(correct);
  });

  it("repairs double-layer Vietnamese mojibake", () => {
    expect(shouldRepairText(twiceBroken)).toBe(true);
    expect(repairMojibakeText(twiceBroken)).toBe(correct);
  });

  it("repairs mojibake stored in SQLite memories", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-repair-"));
    const dbPath = join(dir, "memories.db");
    const store = new SQLiteMemoryStore(dbPath);
    try {
      const task = store.createTask({ title: "Task" });
      store.addMemory({
        taskId: task.id,
        type: "note",
        content: twiceBroken,
        importance: 3
      });
      store.close();

      const report = repairDatabaseEncoding(dbPath);
      expect(report.changed.length).toBeGreaterThan(0);

      const repairedStore = new SQLiteMemoryStore(dbPath);
      try {
        const result = repairedStore.searchMemories("ti\u1ebfng Vi\u1ec7t");
        expect(result[0]?.content).toBe(correct);
      } finally {
        repairedStore.close();
      }
    } finally {
      try {
        store.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scans replacement question mark damage even when it cannot auto-repair", () => {
    expect(encodingIssueReason("Sửa lỗi đ??ng nhập")).toContain("question-mark");
    expect(
      encodingIssueReason("b\u1ecb s\u1eafp x\u1ebfp \u0111\u00e8 l\u00ean nhau g\u00e2y kh\u00f3 nh\u00ecn?")
    ).toBeUndefined();
    expect(encodingIssueReason("GET /api/graph?limit=&focus=")).toBeUndefined();
    expect(encodingIssueSnippet("abc d??ng packer xyz")).toContain("d??ng");

    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-scan-"));
    const dbPath = join(dir, "memories.db");
    const store = new SQLiteMemoryStore(dbPath);
    try {
      const task = store.createTask({ title: "Task" });
      store.addMemory({
        taskId: task.id,
        type: "note",
        content: "Sửa lỗi đ??ng nhập",
        importance: 3
      });
      store.close();

      const issues = scanDatabaseEncodingIssues(dbPath);
      expect(issues.some((issue) => issue.reason.includes("question-mark"))).toBe(true);
    } finally {
      try {
        store.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repairs common Vietnamese question-mark replacements from old hook data", () => {
    const broken =
      "hi???n t???i t??i th???y ph???n t???o schem linh ki???n xoay ch??a g???n g??ng, ????i l??c wire kh??ng match ch??n linh ki???n";
    const repaired = repairMojibakeText(broken, { repairQuestionMarks: true });
    expect(repaired).toContain("hi\u1ec7n t\u1ea1i");
    expect(repaired).toContain("t\u00f4i th\u1ea5y");
    expect(repaired).toContain("ph\u1ea7n t\u1ea1o");
    expect(repaired).toContain("linh ki\u1ec7n");
    expect(repaired).toContain("ch\u01b0a g\u1ecdn g\u00e0ng");
    expect(repaired).toContain("\u0111\u00f4i l\u00fac");
    expect(repaired).toContain("kh\u00f4ng");
  });

  it("repairs follow-up Vietnamese question-mark leftovers from old logs", () => {
    const broken = [
      "wire kh\u00f4ng match ch??n linh ki\u1ec7n, v?? linh ki\u1ec7n th\u01b0\u1eddng b??? s???p x???p ???? l??n nhau",
      "Xong to??n b??? ph\u1ea1m vi A+B+C+D, \u0111\u00e3 verify t???ng ph\u1ea7n. **A ??? Ch\u1ed1ng ????:** vi???t l\u1ea1i",
      "h\u00e3y th??? t\u1ea1o 1 m\u1ea1ch nh\u00e1y led v\u1edbi stm32 sau ???? ki\u1ec3m tra l\u1ea1i m\u1ea1ch",
      "Xong ph????ng ??n A. ## ???? th??m v\u00e0o scripts ??? ch???y to??n b??? smoke",
      "cho t\u00f4i bi???t n\u1ed9i dung claude.md hi\u1ec7n t\u1ea1i \u0111\u01b0\u1ee3c n\u1ea1p",
      "hi\u1ec7n t\u1ea1i c?? **2 file CLAUDE.md** \u0111\u01b0\u1ee3c n\u1ea1p v\u00e0o context cho m???i project"
    ].join("\n");
    const repaired = repairMojibakeText(broken, { repairQuestionMarks: true });
    expect(repaired).toContain("match ch\u00e2n linh ki\u1ec7n");
    expect(repaired).toContain("v\u00e0 linh ki\u1ec7n");
    expect(repaired).toContain("b\u1ecb s\u1eafp x\u1ebfp \u0111\u00e8 l\u00ean nhau");
    expect(repaired).toContain("to\u00e0n b\u1ed9");
    expect(repaired).toContain("verify t\u1eebng ph\u1ea7n");
    expect(repaired).toContain("A - Ch\u1ed1ng \u0111\u00e8:");
    expect(repaired).toContain("vi\u1ebft l\u1ea1i");
    expect(repaired).toContain("h\u00e3y th\u1eed t\u1ea1o");
    expect(repaired).toContain("sau \u0111\u00f3");
    expect(repaired).toContain("ph\u01b0\u01a1ng \u00e1n A");
    expect(repaired).toContain("\u0111\u00e3 th\u00eam v\u00e0o");
    expect(repaired).toContain("ch\u1ea1y to\u00e0n b\u1ed9");
    expect(repaired).toContain("t\u00f4i bi\u1ebft");
    expect(repaired).toContain("c\u00f3 **2 file");
    expect(repaired).toContain("m\u1ecdi project");
  });

  it("repairs final observed Vietnamese question-mark leftovers", () => {
    const broken = [
      "b\u1ecb s\u1eafp x\u1ebfp \u0111\u00e8 l\u00ean nhau g??y kh?? nh?",
      "vi\u1ebft l\u1ea1i suggest_schematic_layout_data d??ng packer",
      "Global ??? `C:\\Users\\rkaka\\.claude\\CLAUDE.md`"
    ].join("\n");
    const repaired = repairMojibakeText(broken, { repairQuestionMarks: true });
    expect(repaired).toContain("g\u00e2y kh\u00f3 nh\u00ecn");
    expect(repaired).toContain("d\u00f9ng packer");
    expect(repaired).toContain("Global - `C:\\Users\\rkaka\\.claude\\CLAUDE.md`");
  });

  it("repairs deep snippets revealed by match-centered scan output", () => {
    const broken = [
      "g\u00e2y kh\u00f3 nh\u00ecn?n, t\u00f4i mu???n b\u1ecbn v\u00e0? thi???t k??? ra ph???i c\u00f3 layout r?? r??ng t\u1eebng ph\u1ea7n, t\u1eebng c\u00f3?m",
      "d\u00f9ng packer shelf-flow theo bbox th???t c\u00f3?a linh ki\u1ec7n resolve t??? pin, b\u1ecb k???p zone g\u00e2y d???n g??c",
      "ch\u1ea1y to\u00e0n b\u1ed9 smoke_test_*.py m???t l???nh",
      "Vague prompt ??? ask ONE question"
    ].join("\n");
    const repaired = repairMojibakeText(broken, { repairQuestionMarks: true });
    expect(repaired).toContain("g\u00e2y kh\u00f3 nh\u00ecn, t\u00f4i mu\u1ed1n b\u1ea3n v\u1ebd thi\u1ebft k\u1ebf");
    expect(repaired).toContain("ph\u1ea3i c\u00f3 layout r\u00f5 r\u00e0ng");
    expect(repaired).toContain("t\u1eebng c\u1ee5m");
    expect(repaired).toContain("bbox th\u1eadt c\u1ee7a linh ki\u1ec7n");
    expect(repaired).toContain("resolve t\u1eeb pin");
    expect(repaired).toContain("b\u1ecb k\u1eb9p zone");
    expect(repaired).toContain("g\u00e2y d\u00ednh g\u00f3c");
    expect(repaired).toContain("m\u1ed9t l\u1ec7nh");
    expect(repaired).toContain("prompt - ask");
  });

  it("repairs subsequent deep snippets from the same legacy memories", () => {
    const broken = [
      "t\u1eebng c\u1ee5m ch???c n??ng, c??c ph\u1ea7n có?a m\u1ea1ch n??n ???????c k???t n???i b\u1ecbng label n???i b\u1ecb trong sheet",
      "Gap PACK_CLEARANCE_MM = clearance + grid ????? b?? vi???c snap(). ??? test 9 linh ki\u1ec7n",
      "kh\u00f4ng có?n kicad-cli kho?? c??c b\u1ecbt bi???n: layout pack kh\u00f4ng ????",
      "git commit ??? `/clear` when switching tasks",
      "Vague requests ??? propose scoped version"
    ].join("\n");
    const repaired = repairMojibakeText(broken, { repairQuestionMarks: true });
    expect(repaired).toContain("t\u1eebng c\u1ee5m ch\u1ee9c n\u0103ng");
    expect(repaired).toContain("c\u00e1c ph\u1ea7n c\u1ee7a m\u1ea1ch n\u00ean \u0111\u01b0\u1ee3c k\u1ebft n\u1ed1i");
    expect(repaired).toContain("b\u1eb1ng label n\u1ed9i b\u1ed9");
    expect(repaired).toContain("\u0111\u1ec3 b\u00f9 vi\u1ec7c snap()");
    expect(repaired).toContain("\u0110\u00e3 test 9 linh ki\u1ec7n");
    expect(repaired).toContain("kh\u00f4ng c\u1ea7n kicad-cli");
    expect(repaired).toContain("kh\u00f3a c\u00e1c b\u1ea5t bi\u1ebfn");
    expect(repaired).toContain("layout pack kh\u00f4ng \u0111\u00e8");
    expect(repaired).toContain("git commit -> `/clear`");
    expect(repaired).toContain("requests - propose");
  });

  it("repairs sheet/global-label and prompt-arrow snippets", () => {
    const broken = [
      "trong sheet ho???c global label n???u b\u1ea3n v\u1ebd chia l??m nhi???u sheet",
      "h???t COMPONENT_OVERLAP. **B ??? Kh???p ch\u00e2n + xoay:**",
      "placement c\u00f3 pins ???? resolve - rotation 2-ch\u00e2n theo tr???c c\u1ee5m ngu???n (cap ??? 90??, IC ??? 0??)",
      "\"fix all bugs\" ??? \"which file/function?\"",
      "\"explain codebase\" ??? \"which module?\"",
      "\"make it better\" ??? \"what"
    ].join("\n");
    const repaired = repairMojibakeText(broken, { repairQuestionMarks: true });
    expect(repaired).toContain("trong sheet ho\u1eb7c global label n\u1ebfu");
    expect(repaired).toContain("chia l\u00e0m nhi\u1ec1u sheet");
    expect(repaired).toContain("h\u1ebft COMPONENT_OVERLAP");
    expect(repaired).toContain("B - Kh\u1edbp ch\u00e2n");
    expect(repaired).toContain("pins \u0111\u00e3 resolve");
    expect(repaired).toContain("tr\u1ee5c c\u1ee5m ngu\u1ed3n");
    expect(repaired).toContain("cap -> 90\u00b0");
    expect(repaired).toContain("IC -> 0\u00b0");
    expect(repaired).toContain("\"fix all bugs\" -> \"which file/function?\"");
    expect(repaired).toContain("\"explain codebase\" -> \"which module?\"");
    expect(repaired).toContain("\"make it better\" -> \"what");
  });

  it("repairs final rotation and project-heading snippets", () => {
    const broken = [
      "2 ch\u00e2n theo tr???c c\u1ee5m, IC gi??? 0??); m\u1ecdi placement nay tr??? m???ng `pins` to??? ????? tuy???t ?????i",
      "layout pack kh\u00f4ng \u0111\u00e8 + m\u1ecdi placement c\u00f3 `pins` ???? resolve",
      "## 2. Project ??? `D:\\TAILIEU\\MyProject\\AI_Tool\\MCP_KiCad\\CLAUDE.md`"
    ].join("\n");
    const repaired = repairMojibakeText(broken, { repairQuestionMarks: true });
    expect(repaired).toContain("theo tr\u1ee5c c\u1ee5m");
    expect(repaired).toContain("IC gi\u1eef 0\u00b0");
    expect(repaired).toContain("tr\u1ea3 m\u1ea3ng `pins`");
    expect(repaired).toContain("t\u1ecda \u0111\u1ed9 tuy\u1ec7t \u0111\u1ed1i");
    expect(repaired).toContain("`pins` \u0111\u00e3 resolve");
    expect(repaired).toContain("Project - `D:\\TAILIEU\\MyProject\\AI_Tool\\MCP_KiCad\\CLAUDE.md`");
  });
});
