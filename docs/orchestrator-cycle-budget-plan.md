# Kế hoạch: buộc Orchestrator hội tụ ở cycle cuối và tăng cycle khi đang chạy

## 1. Mục tiêu

Giảm số lượt agent bị tiêu tốn mà orchestration vẫn quay lại cùng một trạng thái, đồng thời cho người dùng chủ động cấp thêm ngân sách rework mà không phải dừng hoặc tạo lại orchestration.

Kết quả cần đạt:

- Cycle cuối trở thành **finalization cycle**: sau khi phần work/review hiện tại kết thúc, adjudication phải đưa orchestration sang `reporting`; không được tạo thêm rework, block hoặc câu hỏi mới.
- Quy tắc trên được backend cưỡng chế, không chỉ dựa vào prompt của leader.
- Người dùng có thể cộng thêm một số cycle dương vào orchestration đang hoạt động; thay đổi có hiệu lực ngay với auto-run và không làm mất phase hiện tại.
- UI hiển thị rõ cycle đã dùng, giới hạn hiện tại, trạng thái finalization và thao tác `Add cycles`.
- Mọi thay đổi ngân sách và finalization đều có orchestration event để audit và xuất hiện trong report/handoff context.

## 2. Hiện trạng và nguyên nhân

Luồng hiện tại đã coi `cycle` là số vòng rework: accept-only adjudication không tăng cycle, còn rework tăng `cycle` thêm 1. `validateAdjudicationTurn()` từ chối rework khi `cycle >= maxCycles`, nhưng leader chỉ được thông báo chung rằng đang ở cycle N/M. Vì vậy ở cycle cuối leader vẫn có thể:

- trả `projectComplete: false`;
- `block` subtask hoặc đặt câu hỏi;
- bỏ sót subtask đang mở;
- trả một quyết định rework không hợp lệ rồi bị retry/pause.

Các nhánh này không tạo thêm rework hợp lệ nhưng vẫn tốn leader turn, retry và thao tác thủ công. Guard `cycle > maxCycles` chỉ xử lý trạng thái đã vượt giới hạn; nó không đảm bảo cycle cuối hội tụ.

`maxCycles` đã có trong model và `updateOrchestration()`, nhưng chưa có mutation/API/UI chuyên dụng để tăng ngân sách của một run đang hoạt động. Nếu triển khai bằng read-then-write ở route, hai yêu cầu gần nhau hoặc auto-run từ process khác có thể ghi đè giá trị.

## 3. Semantics chốt trước khi triển khai

### 3.1. Khi nào là cycle cuối

Thêm helper canonical trong core:

```ts
isFinalizationCycle(orchestration) = orchestration.cycle >= orchestration.maxCycles
```

Finalization chỉ tác động tại phase `adjudicating`. Implementer/reviewer đang chạy trong cycle cuối vẫn được hoàn tất và thu kết quả; hệ thống không dừng process giữa chừng.

Nếu người dùng tăng `maxCycles` trước khi final adjudication được áp dụng, run lập tức rời finalization mode và leader lại được phép chọn rework. Nếu turn adjudication đã spawn, backend phải đánh giá bằng orchestration mới nhất lúc consume kết quả, không đóng băng theo prompt cũ.

### 3.2. Quy tắc finalization

Ở finalization cycle, output hợp lệ phải:

- có đúng một quyết định cho mọi subtask chưa `done`/`cancelled`;
- chỉ dùng `accept` hoặc `drop`;
- đặt `projectComplete: true`;
- không có `questions`;
- ghi rõ defect/rủi ro còn tồn tại trong decision artifact của mọi subtask bị drop để final report không biến việc cắt scope thành thành công giả.

`accept` chỉ dùng khi acceptance criteria đã đạt. Mọi việc chưa đạt phải `drop`, kèm lý do và phần chưa hoàn thành. Final report phải phân biệt `accepted` với `dropped at cycle limit`.

### 3.3. Fail-safe cưỡng chế

Prompt tốt hơn là lớp đầu tiên; core là lớp quyết định cuối cùng:

1. Leader/adjudicator nhận finalization prompt và có một cơ hội trả kết quả đúng.
2. Nếu JSON hợp lệ nhưng vi phạm quy tắc finalization, chạy tối đa một corrective retry trong cùng cycle, với lỗi cụ thể và danh sách key bắt buộc.
3. Nếu retry vẫn vi phạm, hoặc leader trả `projectComplete: false`, core tạo một **forced finalization turn** xác định:
   - giữ các `accept`/`drop` hợp lệ cho key hiện tại;
   - chuyển `rework`/`block` thành `drop`;
   - thêm `drop` cho mọi open key bị bỏ sót;
   - xóa questions và đặt `projectComplete: true`;
   - ghi event `forced_finalization` cùng nguyên nhân và danh sách subtask bị drop;
   - tạo decision artifacts tối thiểu cho các quyết định do core tổng hợp, rồi đi qua cùng `applyAdjudicateTurn()` để tránh một đường cập nhật state riêng.
4. Lỗi hạ tầng không có dữ liệu để adjudicate (không spawn được agent, store/context hỏng) vẫn là `failed`; không được báo hoàn thành giả. Nếu có reviews/subtask state nhưng agent chỉ lỗi output/parse sau retry, forced finalization vẫn có thể đóng run và đưa thiếu sót vào report.

Fail-safe không tăng `cycle`, không spawn implementer mới và không pause để hỏi người dùng.

### 3.4. Tăng ngân sách cycle

API nhận delta thay vì giá trị tuyệt đối:

```json
{ "taskId": "...", "additionalCycles": 3 }
```

Ràng buộc:

- `additionalCycles` là integer từ 1 đến 100 cho mỗi request;
- chỉ cho phép với `planning`, `executing`, `adjudicating` hoặc `paused`;
- từ chối `reporting`, `done`, `failed` để không âm thầm mở lại run đã kết thúc;
- chỉ tăng, không hỗ trợ giảm limit giữa run;
- không đổi `cycle`, phase, autonomy hoặc active runs;
- nếu status là `paused`, việc tăng budget không tự resume; người dùng vẫn chủ động Resume;
- với auto/approve-each đang chạy, timer hiện có tự đọc giới hạn mới ở tick kế tiếp, không tạo timer thứ hai.

Thêm method store dạng atomic `incrementOrchestrationMaxCycles(id, delta)` dùng một câu SQL update và trả row mới. Route ghi event `cycle_budget_increased` chứa old/new/delta. Giới hạn tổng cần được chặn ở một mức hợp lý (đề xuất `maxCycles <= 1000`) để tránh vô tình biến budget thành vô hạn.

## 4. Thay đổi theo lớp

### 4.1. Core orchestration

Files:

- `packages/core/src/orchestrator.ts`
- `packages/core/src/leader-prompts.ts`
- `packages/core/src/context-store.ts` nếu cần helper ghi forced decision artifact

Công việc:

1. Tạo helper `isFinalizationCycle()` và dùng cùng một định nghĩa trong prompt, validation và apply.
2. Truyền `finalization: boolean` hoặc suy ra từ `cycle/maxCycles` trong `renderAdjudicatePrompt()`.
3. Thêm khối nổi bật vào prompt: đây là lượt cuối; cấm rework/block/questions; phải quyết định mọi open key và đặt `projectComplete: true`; defect chưa sửa phải drop và ghi vào artifact/report.
4. Mở rộng `validateAdjudicationTurn()` để kiểm tra toàn bộ contract finalization, trả lỗi liệt kê key thiếu hoặc verdict bị cấm.
5. Tách việc retry/fallback finalization khỏi retry adjudication thông thường để bảo đảm retry có giới hạn và không rơi vào `paused` sau lần thứ hai.
6. Tạo forced turn từ snapshot subtask mới nhất, ghi artifacts/event, rồi gọi `applyAdjudicateTurn()`.
7. Gắn lý do drop vào `statusReason` và decision ledger thay vì chuỗi chung `Dropped by the leader`, để report nêu đúng việc bị cắt do hết budget.
8. Giữ guard `cycle > maxCycles` để tương thích dữ liệu cũ/bị sửa tay, nhưng đổi thông điệp thành lỗi invariant; đường chạy bình thường không được chạm guard này.

### 4.2. Persistence

Files:

- `packages/memory/src/memory-store.ts`
- `packages/memory/src/sqlite-store.ts`
- `packages/memory/src/types.ts` nếu cần type kết quả mutation

Công việc:

1. Thêm `incrementOrchestrationMaxCycles(id, delta)` vào `MemoryStore`.
2. SQLite thực hiện update atomic với điều kiện delta/ceiling đã validate, cập nhật `updated_at`, rồi đọc lại row.
3. Không cần migration schema vì `max_cycles` đã tồn tại.
4. Cập nhật fake stores/test doubles triển khai `MemoryStore`.

### 4.3. HTTP route và auto-run

Files:

- `packages/cli/src/commands/routes/orchestration-runs.ts`
- `packages/cli/src/commands/ui.ts`
- `packages/cli/src/commands/routes/auto-run.ts` chỉ khi test cho thấy timer cache state; thiết kế hiện tại dự kiến không cần sửa logic timer

Công việc:

1. Thêm `POST /api/workforce/orchestration/add-cycles`.
2. Resolve orchestration từ `taskId`, validate status và `additionalCycles`, gọi store mutation atomic.
3. Ghi event audit với cycle hiện tại, giới hạn cũ/mới và delta.
4. Trả `{ orchestration, previousMaxCycles, additionalCycles, autoRun }` để UI cập nhật ngay.
5. Không gọi `stepOrchestration()` ngay trong route; tránh cạnh tranh với active agent/timer. Auto-run xử lý ở tick kế tiếp, manual run vẫn chờ Step.

### 4.4. Work Board UI

Files:

- `packages/cli/src/ui-page.ts`
- `packages/cli/src/ui-client/main.ts`

Công việc:

1. Đặt control cạnh badge `rework cycle N/M`: number input mặc định `1`, min `1`, max `100`, nút `Add cycles` và vùng status.
2. Chỉ enable khi orchestration thuộc status cho phép; ẩn hoặc disable rõ ràng khi `reporting/done/failed`.
3. Khi `cycle >= maxCycles`, hiển thị badge `finalization cycle` và tooltip giải thích run sẽ không tạo rework mới, phần chưa đạt sẽ được drop và ghi vào report.
4. Submit endpoint mới, khóa nút trong lúc request, hiển thị `M → M+n`, refresh board sau thành công và giữ nguyên orchestration đang được chọn.
5. Không tự resume orchestration đang paused và không tự đổi autonomy.

## 5. Kiểm thử

### Core (`packages/core/src/orchestrator.test.ts`, `packages/core/src/leader-prompts.test.ts`)

- Prompt cycle thường vẫn cho phép rework; prompt cycle cuối chứa contract finalization và danh sách open keys.
- Ở cycle trước cuối, rework hợp lệ tạo replacement và tăng cycle đúng một lần.
- Ở cycle cuối, `rework`, `block`, questions, thiếu quyết định hoặc `projectComplete: false` bị nhận diện chính xác.
- Corrective retry chỉ xảy ra một lần trong cùng cycle.
- Lần trả sai thứ hai tạo forced turn, drop các key còn mở, ghi event/artifact và chuyển sang `reporting`.
- Quyết định `accept/drop` hợp lệ ở lượt đầu đi thẳng sang `reporting`, không spawn thêm agent.
- Tăng `maxCycles` trong lúc adjudication đang chạy khiến kết quả được đánh giá theo budget mới; rework hợp lệ trở lại nếu run không còn ở cycle cuối.
- Guard dữ liệu cũ `cycle > maxCycles` vẫn fail có chẩn đoán, không loop.

### Persistence (`packages/memory/src/sqlite-store.test.ts`)

- Increment trả đúng old/new value và giữ nguyên các field còn lại.
- Hai increment liên tiếp cộng dồn, không lost update.
- Không vượt ceiling và không chấp nhận delta không hợp lệ.

### Route/UI (`packages/cli/src/commands/ui-routes.test.ts`, `packages/cli/src/commands/ui.test.ts`)

- Route mới được đăng ký và trả 200 cho active orchestration.
- Reject delta `0`, âm, số thực, vượt giới hạn và status terminal.
- Paused run được tăng budget nhưng giữ paused; active auto-run giữ timer hiện tại.
- Event audit chứa old/new/delta.
- HTML/client có control, gọi đúng endpoint, hiển thị finalization badge và disable đúng theo status.

### Regression

- Chạy focused tests cho memory, leader prompts, orchestrator và UI routes.
- Chạy `corepack pnpm -r build` sau khi focused tests pass.
- Xác nhận accept-only adjudication vẫn không tốn cycle, request changes vẫn reset cycle như hiện tại, pause/resume/autonomy không đổi hành vi.

## 6. Thứ tự triển khai

1. Viết test contract cho finalization prompt và core state transition.
2. Cài helper finalization, validation, bounded retry và forced fallback trong core.
3. Bổ sung atomic store mutation cùng persistence tests.
4. Thêm route `add-cycles`, route registration và tests.
5. Thêm UI control/badge và UI tests.
6. Chạy regression/build, sửa tài liệu hành vi nếu README/Work Board help text có mô tả cycle cũ.

Mỗi bước nên là một commit độc lập, chỉ commit các file thuộc bước đó để dễ rollback và bisect.

## 7. Tiêu chí hoàn thành

- Một orchestration ở `cycle === maxCycles` không thể tạo replacement subtask mới.
- Sau tối đa một adjudication turn và một corrective retry ở cycle cuối, orchestration đi tới `reporting` hoặc `failed` vì lỗi hạ tầng xác định; không pause/loop vì quyết định nghiệp vụ không hội tụ.
- Mọi subtask còn mở khi forced finalization đều trở thành `done` hoặc `cancelled`, với lý do có thể truy vết trong event, context artifact và final report.
- Người dùng cộng thêm cycle cho active/paused run từ UI và thấy giới hạn mới ngay; phase, active runs, autonomy và timer không bị reset.
- Concurrent increments không làm mất budget.
- Focused tests và monorepo build pass.

## 8. Ngoài phạm vi

- Tự động chọn số cycle dựa trên độ phức tạp hoặc token cost.
- Giảm cycle limit giữa run.
- Mở lại orchestration `done/failed` bằng thao tác Add cycles; việc đó tiếp tục thuộc Request changes/re-plan.
- Thay đổi định nghĩa hiện tại rằng chỉ rework mới tiêu tốn cycle.
