# Báo cáo lỗi Orchestrator: rework lặp vô hạn / sai ngữ cảnh

## 1. Tóm tắt

Orchestrator trong repo thử nghiệm:

`D:\TAILIEU\MyProject\AI_Tool\test_game`

đã rơi vào vòng lặp rework khi xử lý yêu cầu:

> `tôi muốn tạo thêm 2 màn chơi độ khó cao hơn thêm vào game`

Lỗi gốc không nằm ở logic `accept` của `applyAdjudicateTurn()`. Nguyên nhân chính là prompt adjudication đang chứa một ví dụ JSON hard-code hoàn toàn không liên quan đến task hiện tại:

- `subtaskKey: "s1"`
- `title: "Fix migration ordering"`
- `idx_agent_runs_task exists`
- `roundtrip test passes`

Ví dụ này nằm trong:

`packages/core/src/leader-prompts.ts`

ở phần `Required Output` của `renderAdjudicatePrompt()`.

Trong run thực tế, model đã sao chép chính ví dụ này thành quyết định thật. Từ đó một task game bị nhiễm nội dung migration, tiếp tục rework vào key cũ `s1`, tạo nhiều subtask rework song song và cuối cùng vượt ngân sách cycle.

Mức độ: **High**.

Ảnh hưởng chính:

- Task bị đổi scope ngoài ý muốn.
- Rework không dừng dù công việc đã từng được review/pass/accept.
- Sinh nhiều subtask rework rác.
- Tốn token, quota và thời gian chạy agent.
- Có thể chạm `maxCycles` dù lỗi không đến từ implementation thật.
- Context của task sau bị nhiễm bởi dữ liệu từ ví dụ prompt.

---

## 2. Phạm vi kiểm tra

### Repo tái hiện lỗi

`D:\TAILIEU\MyProject\AI_Tool\test_game`

Orchestration:

`orch-f9597c2a-c611-47c1-b334-2d8ba210adfb`

Context:

`.agent-memory/context/orch-f9597c2a-c611-47c1-b334-2d8ba210adfb`

### Repo chứa implementation orchestrator

`D:\TAILIEU\MyProject\AI_Tool\Optimize_token_and_memory_pool`

Các file liên quan trực tiếp:

- `packages/core/src/leader-prompts.ts`
- `packages/core/src/leader-prompts.test.ts`
- `packages/core/src/orchestrator.ts`
- `packages/core/src/orchestrator.test.ts`

---

## 3. Bằng chứng từ run thực tế

### 3.1. Task gốc là task game

Prompt adjudication thực tế ghi rõ:

```text
Task: tôi muốn tạo thêm 2 màn chơi độ khó cao hơn thêm vào game
```

Tuy nhiên cùng prompt đó lại có Decision Log:

```text
Cycle 1 (Leader):
  - s1: rework
      rework ordered: Fix migration ordering
      rework goal:
      TASK
      Fix migration ordering.

      GOAL
      The agent-runs index exists before any query depends on it.
```

Nội dung này không có quan hệ với game.

### 3.2. Context bị trộn scope

`index.md` của orchestration cho thấy:

- `s1`: thêm Level 4 & 5 — `done`
- `s2`: verifier level 4/5 — `cancelled`
- `c3-s1`: `Fix migration ordering` — `todo`
- `s3`: verify 5 level — `cancelled`

`Fix migration ordering` là một subtask ngoài scope của yêu cầu game.

### 3.3. Rework tiếp tục dù round trước đã Accept

Trong:

`tasks/c3-s1/review-r1.md`

review round 1 kết luận pass.

Trong:

`tasks/c3-s1/adjudication-r1.md`

có kết luận:

```text
The subtask is accepted. No rework is required.
```

Nhưng sau đó vẫn xuất hiện:

- `report-r2.md`
- `review-r2.md`
- `adjudication-r2.md`

Điều này cho thấy trạng thái/decision thực tế mà orchestrator xử lý đã không còn tương ứng với ý nghĩa của tài liệu round 1.

### 3.4. Sinh hàng loạt sibling rework

Các prompt artifact sau đó cho thấy đồng thời tồn tại:

```text
s1-rework-1
s1-rework-2
s1-rework-3
s1-rework-4
s1-rework-5
s1-rework-6
s1-rework-7
```

Đây là dấu hiệu quan trọng.

Luồng bình thường phải tiến theo descendant hiện tại, ví dụ:

```text
s1
  -> s1-rework-1
       -> s1-rework-1-rework-2
```

hoặc một cơ chế attempt tương đương.

Trong lỗi hiện tại, leader tiếp tục quyết định trên stale key `s1`, vì vậy mỗi cycle lại sinh thêm một sibling mới:

```text
s1 -> s1-rework-1
s1 -> s1-rework-2
s1 -> s1-rework-3
...
```

### 3.5. Vượt ngân sách rework

Context đã ghi nhận trạng thái tương đương:

```text
cycle 9 / maxCycles 8
```

Trong `orchestrator.ts`, guard đầu `stepOrchestration` kiểm tra:

```ts
if (orchestration.cycle > orchestration.maxCycles) {
  ...
}
```

Do rework lặp, orchestration cuối cùng vượt giới hạn dù phần game không phải nguyên nhân thực sự.

---

## 4. Root cause

### 4.1. Hard-coded task-specific example trong prompt chung

Trong `packages/core/src/leader-prompts.ts`, phần cuối của `renderAdjudicatePrompt()` dựng `Required Output` bằng một JSON example cố định.

Nó chứa dữ liệu:

```ts
subtaskKey: "s1",
verdict: "rework",
rework: {
  title: "Fix migration ordering",
  goal: "TASK\nFix migration ordering... ",
  acceptanceCriteria: [
    "idx_agent_runs_task exists",
    "roundtrip test passes"
  ],
  ...
}
```

Đây là nguyên nhân gốc.

Một example mang dữ liệu nghiệp vụ cụ thể được đặt ngay trong phần:

```text
## Required Output
Reply with EXACTLY one fenced json block...
```

Với cấu trúc prompt như vậy, model có xác suất cao coi example là template cần điền hoặc thậm chí là output hợp lệ để sao chép trực tiếp.

Trong run `test_game`, điều này đã xảy ra thật.

### 4.2. Vì sao model dễ copy example này

Prompt đồng thời yêu cầu:

1. Output phải đúng một fenced JSON block.
2. JSON phải đúng schema.
3. Ngay sau yêu cầu đó là một JSON hoàn chỉnh, hợp lệ.
4. JSON hoàn chỉnh lại chứa một quyết định `rework` rất cụ thể.

Về mặt prompt design, đây gần như là một few-shot example có trọng số cao.

Do đó model không chỉ học cấu trúc JSON mà còn có thể học nhầm:

- key `s1`
- verdict `rework`
- title `Fix migration ordering`
- acceptance criteria của migration

### 4.3. Lỗ hổng phòng vệ thứ hai: stale key vẫn được áp dụng

`applyAdjudicateTurn()` hiện tìm subtask bằng:

```ts
const meta = findSubtaskMetaByKey(
  store,
  orchestration.id,
  decision.subtaskKey
);
```

Sau đó nếu verdict là `rework`, code tạo replacement mới với key:

```ts
const reworkKey =
  `${decision.subtaskKey}-rework-${orchestration.cycle}`;
```

Nhưng trước khi tạo replacement, code chưa có guard đủ mạnh để từ chối một decision nhắm vào subtask đã:

- `done`
- `cancelled`
- superseded bởi rework mới hơn

Do đó khi model cứ trả:

```json
{
  "subtaskKey": "s1",
  "verdict": "rework"
}
```

orchestrator có thể tiếp tục tạo:

```text
s1-rework-2
s1-rework-3
s1-rework-4
...
```

thay vì từ chối stale decision.

Đây là **secondary robustness defect**. Nó không tạo ra nội dung migration ban đầu, nhưng làm lỗi prompt phát triển thành vòng lặp dài.

---

## 5. Vì sao `applyAdjudicateTurn()` không phải root cause chính

Nhánh `accept` hiện tại:

```ts
if (decision.verdict === "accept") {
  store.updateSubtask(subtaskId, { status: "done" });
  if (targetAssignment) {
    store.updateAssignment(targetAssignment.id, { status: "done" });
  }
}
```

Logic này đúng với một decision hợp lệ nhắm vào đúng current subtask.

Test hiện có trong `orchestrator.test.ts` cũng bao phủ case:

```text
s1-rework-1 -> accept
```

và flow tiếp tục đúng.

Vì vậy lỗi thực tế là:

```text
prompt tạo decision sai
        |
        v
leader trả stale/wrong subtaskKey
        |
        v
orchestrator không chặn stale rework
        |
        v
sinh sibling rework mới
        |
        v
cycle tăng
        |
        +------ lặp lại ------+
```

---

## 6. Cách khắc phục đề xuất

Nên sửa theo hai lớp:

1. **Fix nguồn gây nhiễm prompt.**
2. **Thêm validation để một prompt/model sai không thể phá state machine.**

Không nên chỉ tăng `maxCycles`.

---

## 7. Fix bắt buộc số 1: loại bỏ example `Fix migration ordering`

File:

`packages/core/src/leader-prompts.ts`

### Không nên

Không được giữ bất kỳ dữ liệu domain/task cụ thể nào trong prompt dùng chung:

```text
Fix migration ordering
idx_agent_runs_task
roundtrip test passes
s1
```

trừ khi những giá trị đó thật sự đến từ `input` của orchestration hiện tại.

### Phương án tốt nhất

Sinh phần output guidance từ chính candidate hiện tại.

Ví dụ:

```ts
const decisionCandidates = input.subtasks.filter((subtask) =>
  !["done", "cancelled"].includes(subtask.status)
);
```

Khi cần minh họa key, chỉ lấy key đang tồn tại trong chính prompt:

```ts
const exampleKey =
  input.reviews[0]?.subtaskKey ??
  decisionCandidates[0]?.key;
```

Không tự tạo `"s1"`.

### Khuyến nghị thêm

Không nên đưa một example `rework` hoàn chỉnh làm mẫu mặc định.

`rework` là action có side effect lớn nhất vì:

- cancel subtask cũ
- tạo subtask mới
- re-point dependency
- tăng rework cycle

Một mẫu mặc định `rework` vô tình bias model về action nguy hiểm nhất.

Nên thay bằng một trong hai cách:

#### Cách A — schema guidance, không có business values

Mô tả field bằng prose và giữ JSON skeleton tối thiểu.

#### Cách B — dynamic example

Nếu bắt buộc cần JSON mẫu, dùng key thực tế của candidate hiện tại và nội dung rework được tạo từ title/criteria hiện tại, không dùng dữ liệu ngoài task.

Trong mọi trường hợp, không hard-code provider/model cụ thể nếu chúng không đến từ roster hiện tại.

---

## 8. Fix bắt buộc số 2: validate decision target trước khi mutate state

File:

`packages/core/src/orchestrator.ts`

Trước khi xử lý từng `decision`, cần xác minh:

1. `decision.subtaskKey` tồn tại trong orchestration hiện tại.
2. Subtask tương ứng vẫn là một decision candidate hợp lệ.
3. Không cho `rework` một subtask đã terminal.

Terminal status tối thiểu:

```text
done
cancelled
```

Pseudo-code:

```ts
const meta = findSubtaskMetaByKey(
  store,
  orchestration.id,
  decision.subtaskKey
);

if (!meta) {
  return rejectAdjudication(
    `Unknown subtask key: ${decision.subtaskKey}`
  );
}

const subtask = store.getSubtask(meta.subtaskId);

if (!subtask) {
  return rejectAdjudication(
    `Missing subtask for key: ${decision.subtaskKey}`
  );
}

if (
  decision.verdict === "rework" &&
  ["done", "cancelled"].includes(subtask.status)
) {
  return rejectAdjudication(
    `Cannot rework terminal subtask: ${decision.subtaskKey}`
  );
}
```

### Quan trọng

Không nên tự động redirect một stale key sang descendant mới nhất.

Ví dụ:

```text
s1 -> s1-rework-1
```

nếu leader lại gửi `s1`, orchestrator nên **reject decision và yêu cầu adjudication turn trả lại key hợp lệ**, thay vì đoán rằng leader muốn nói `s1-rework-1`.

Lý do: redirect ngầm có thể áp dụng một verdict sai lên công việc khác.

---

## 9. Fix số 3: chỉ cho rework candidate đang thực sự cần quyết định

Ngoài status guard, có thể siết chặt hơn.

`rework` chỉ hợp lệ nếu subtask:

- có pending review cần adjudicate; hoặc
- đang `blocked`; hoặc
- đang stranded và leader được phép tạo replacement.

Không nên cho phép một arbitrary historical key nhận `rework`.

Có thể tạo một `Set` các key hợp lệ ngay khi dựng adjudication:

```ts
const allowedDecisionKeys = new Set([
  ...pendingReviewKeys,
  ...blockedKeys,
  ...strandedKeys,
]);
```

Sau đó validate mọi decision:

```ts
if (!allowedDecisionKeys.has(decision.subtaskKey)) {
  // reject turn before any mutation
}
```

Tốt nhất validate toàn bộ turn trước, rồi mới apply bất kỳ decision nào để tránh partial mutation.

---

## 10. Fix số 4: chặn duplicate/sibling rework

Hiện key mới được tạo theo:

```ts
`${decision.subtaskKey}-rework-${orchestration.cycle}`
```

Nếu `decision.subtaskKey` là stale key gốc, sẽ sinh sibling.

Sau khi có stale-key guard, lỗi này gần như biến mất.

Tuy nhiên nên thêm invariant:

> Một terminal/superseded subtask không được phép sinh thêm replacement thứ hai.

Có thể kiểm tra xem key đang target đã có active replacement hay chưa.

Nếu đã có:

```text
s1 -> s1-rework-1
```

thì rework lại `s1` phải fail validation.

---

## 11. Fix số 5: bảo vệ `maxCycles` trước khi tạo thêm rework

Hiện orchestration có thể được tăng từ cycle 8 lên 9, sau đó lần `step` tiếp theo mới bị guard:

```ts
if (orchestration.cycle > orchestration.maxCycles)
```

Nên cân nhắc chặn ngay trước khi apply một rework mới:

```ts
if (
  reworked &&
  orchestration.cycle >= orchestration.maxCycles
) {
  // pause/fail/raise user question
  // không tạo thêm replacement
}
```

Đây không phải root fix nhưng giúp:

- không tạo state cycle 9/8
- không spawn thêm work đã chắc chắn vượt budget
- dễ debug state hơn

---

## 12. Regression tests cần bổ sung

### 12.1. `leader-prompts.test.ts`: prompt không chứa dữ liệu ngoài input

Thêm test:

```ts
it("does not inject unrelated hard-coded adjudication work", () => {
  const prompt = renderAdjudicatePrompt({
    taskTitle: "Add levels 4 and 5",
    cycle: 1,
    maxCycles: 8,
    reviews: [{
      subtaskKey: "level-config",
      subtaskTitle: "Add level configs",
      verdict: "pass",
      summary: "Looks good."
    }],
    subtasks: [{
      key: "level-config",
      title: "Add level configs",
      status: "review",
      acceptanceCriteria: ["5 levels exist"]
    }]
  });

  expect(prompt).not.toContain("Fix migration ordering");
  expect(prompt).not.toContain("idx_agent_runs_task");
  expect(prompt).not.toContain("roundtrip test passes");
});
```

### 12.2. Required Output chỉ tham chiếu key hiện tại

```ts
expect(prompt).toContain("level-config");
expect(prompt).not.toContain('"subtaskKey": "s1"');
```

nếu input không có `s1`.

### 12.3. `orchestrator.test.ts`: reject rework trên cancelled subtask

Flow:

1. `s1` bị rework.
2. `s1` trở thành `cancelled`.
3. `s1-rework-1` là current work.
4. Leader sai và gửi tiếp:

```json
{
  "subtaskKey": "s1",
  "verdict": "rework"
}
```

Kỳ vọng:

- không tạo `s1-rework-2`
- cycle không tăng
- orchestration yêu cầu adjudication lại hoặc chuyển sang trạng thái lỗi/paused có reason rõ ràng

### 12.4. Accept current replacement phải đóng đúng work

Giữ/siết test hiện có:

```text
s1-rework-1 -> accept
```

Kỳ vọng:

- replacement = `done`
- không có replacement mới
- dependent work được dispatch

### 12.5. Không cho một decision turn mutate một phần rồi mới fail

Nếu turn có:

```text
decision 1 = valid
decision 2 = stale/invalid
```

toàn bộ turn nên fail validation trước khi mutation.

Test phải xác minh decision 1 chưa bị apply.

---

## 13. Test command đề xuất sau khi sửa

Chạy focused tests trước:

```powershell
npx vitest run packages/core/src/leader-prompts.test.ts
npx vitest run packages/core/src/orchestrator.test.ts
```

Nếu project dùng npm script riêng cho core thì ưu tiên script tương ứng trong `package.json`.

Sau đó chạy bộ test/build liên quan của `packages/core`.

Các assertion bắt buộc:

- Không còn chuỗi `Fix migration ordering` trong prompt của task game.
- Không còn hard-coded `idx_agent_runs_task` trong generic adjudication prompt.
- Rework vào cancelled/done key bị reject.
- Không sinh sibling rework từ stale ancestor.
- Cycle chỉ tăng khi một rework hợp lệ được apply.
- Accept current rework không tăng cycle.

---

## 14. Thứ tự triển khai khuyến nghị

### Patch 1 — prompt contamination

Sửa:

- `packages/core/src/leader-prompts.ts`
- `packages/core/src/leader-prompts.test.ts`

Mục tiêu:

- bỏ hoàn toàn example migration hard-code
- output guidance chỉ dùng dữ liệu từ input hiện tại

### Patch 2 — state-machine validation

Sửa:

- `packages/core/src/orchestrator.ts`
- `packages/core/src/orchestrator.test.ts`

Mục tiêu:

- reject unknown/stale/terminal rework target
- validate toàn turn trước mutation
- chặn duplicate replacement

### Patch 3 — cycle guard

Siết `maxCycles` để không tạo state vượt budget trước rồi mới fail ở lần step sau.

---

## 15. Điều không nên làm

Không nên xử lý bằng các cách sau:

### Chỉ tăng `maxCycles`

Điều này chỉ kéo dài vòng lặp và tăng chi phí.

### Chỉ thêm câu prompt “đừng copy example”

Model vẫn nhìn thấy một JSON hợp lệ với dữ liệu cụ thể. Cách đúng là loại bỏ dữ liệu hard-code khỏi prompt chung.

### Tự động map `s1` sang descendant mới nhất

Có thể che lỗi nhưng tạo nguy cơ apply verdict lên sai work.

### Chỉ sửa tài liệu `adjudication-r1.md`

File markdown là context artifact. State machine hành động theo JSON turn đã parse và storage state; sửa artifact không chữa root cause.

---

## 16. Kết luận

Root cause đã được xác định:

> `renderAdjudicatePrompt()` chứa một `Required Output` example hard-code từ một task migration cũ. Model đã copy example này vào quyết định thật của một orchestration game.

Lỗi trở nên nghiêm trọng vì state machine tiếp tục chấp nhận `rework` nhắm vào stale/superseded key `s1`, từ đó sinh nhiều sibling:

```text
s1-rework-1
s1-rework-2
...
s1-rework-7
```

và đẩy orchestration đến trạng thái vượt `maxCycles`.

Ưu tiên sửa:

1. Xóa toàn bộ hard-coded migration example khỏi `leader-prompts.ts`.
2. Dựng output guidance từ chính input/candidate hiện tại.
3. Validate toàn bộ adjudication decision trước mutation.
4. Reject `rework` trên `done/cancelled/superseded` subtask.
5. Thêm regression tests cho prompt contamination và stale-key rework.
6. Siết guard `maxCycles` như lớp bảo vệ cuối.

Sau khi hoàn tất các bước trên, lỗi rework liên tục quan sát ở `test_game` sẽ được chặn cả ở nguồn phát sinh prompt lẫn ở tầng state-machine.
