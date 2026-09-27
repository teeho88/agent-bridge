# Kế hoạch nâng cấp Orchestrator UI thành Pixel Office Animation

## 1. Mục tiêu

Thay thế khu vực `Runs` hiện tại bằng một cửa sổ animation dạng văn phòng pixel-art, trong đó toàn bộ workflow orchestration được thể hiện trực quan bằng nhân vật, bàn làm việc, khu vực review, khu vực leader và các chuyển động tương ứng với trạng thái thật của hệ thống.

Mục tiêu không chỉ là tạo hiệu ứng trang trí. Pixel Office phải trở thành một lớp quan sát workflow trực quan, giúp người dùng nhìn vào là hiểu được:

- Leader đang suy nghĩ, lập plan hay ra quyết định.
- Task nào đang được phân cho agent nào.
- Agent nào đang đi nhận việc, đang làm, đang chờ, đã xong hay bị lỗi.
- Task nào đang chuyển sang reviewer.
- Reviewer nào đang kiểm tra và kết quả review là `pass`, `rework` hay `block`.
- Một task rework đang quay lại implementer nào và đang ở vòng rework thứ mấy.
- Workflow đang chờ user approval/question ở đâu.
- Workflow đang paused, stopping, failed, reporting hay complete.
- Run nào là manual/adopted/external session.

Animation phải sinh động nhưng tuyệt đối không được làm sai lệch trạng thái thật của orchestrator. Backend vẫn là nguồn dữ liệu authoritative; animation chỉ là lớp biểu diễn.

## 2. Phạm vi phiên bản đầu tiên

Phiên bản đầu tiên tập trung vào việc thay khu vực Runs bằng Pixel Office, đồng thời giữ đầy đủ khả năng quan sát và điều khiển hiện có.

Bao gồm:

- Leader animation.
- Planning animation.
- Dispatch task cho implementer.
- Worker nhận task và đi đến bàn.
- Worker đang coding/working.
- Worker hoàn thành và bàn giao sang reviewer.
- Reviewer đọc/check task.
- Reviewer pass/rework/block.
- Adjudication của leader.
- Rework loop đầy đủ.
- Reporting.
- Done/failed/paused/stopping.
- User approval và leader question.
- External/adopted session.
- Run inspector thay thế phần thông tin chi tiết của Runs card.
- Responsive layout.
- Reduced-motion accessibility.

Không đưa game engine, physics engine hoặc pathfinding phức tạp vào bản đầu tiên.

## 3. Nguyên tắc kiến trúc quan trọng

### 3.1. Backend là nguồn sự thật

Mọi trạng thái trong Pixel Office phải được suy ra từ dữ liệu thật lấy từ `/api/workforce/board` và các orchestration events.

Không được tạo một workflow animation độc lập rồi giả định backend sẽ đi theo animation đó.

### 3.2. Không phụ thuộc duy nhất vào `orchestration.status`

Hiện tại type có các trạng thái:

- `planning`
- `executing`
- `reviewing`
- `adjudicating`
- `reworking`
- `reporting`
- `done`
- `failed`
- `paused`

Nhưng implementation hiện tại không nhất thiết chuyển orchestration sang `reviewing` hoặc `reworking` ở mọi thời điểm tương ứng.

Review thực tế có thể xảy ra ngay trong `executing`; rework có thể được tạo sau bước adjudication dưới dạng subtask mới.

Vì vậy UI cần một lớp trạng thái riêng:

```ts
PixelOfficeSceneState
```

State này phải được derive từ kết hợp của:

- `orchestration.status`
- active `runs`
- `AgentRunPhase`
- `subtasks`
- `reviews`
- `approvals`
- `questions`
- `events`
- `registeredAgents`
- `leaderAgent`
- previous UI snapshot

Đây là quyết định kiến trúc quan trọng nhất để animation phản ánh chính xác workflow thực tế.

### 3.3. Animation không được block workflow

Animation queue chỉ phục vụ UI.

Ví dụ backend có thể hoàn thành implement + review giữa hai lần poll. UI không được bắt buộc phải chạy hết một chuỗi animation dài mới cập nhật trạng thái mới.

Nếu snapshot mới đi xa hơn animation hiện tại, scene phải fast-forward hoặc reconcile để hội tụ về trạng thái authoritative mới nhất.

## 4. Bố cục Pixel Office

Đề xuất chia scene thành các zone cố định để người dùng nhìn lâu sẽ học được ý nghĩa vị trí.

```text
+------------------------------------------------------------------+
| USER GATE / APPROVAL                REPORT / ARCHIVE             |
| [?] Question bubble                 [Report Desk] [Archive]      |
|                                                                  |
| LEADER OFFICE                DECISION TABLE                      |
| [Leader Desk] [Whiteboard]  [Leader + reviewer/adjudicator]     |
|        |                                                         |
|        v                                                         |
| DISPATCH / BRIEFING COUNTER                                      |
| [Leader calls worker] [task envelope]                            |
|                                                                  |
| IMPLEMENTER FLOOR                    REVIEW LAB                   |
| [Desk 1] [Desk 2] [Desk 3] ...       [Reviewer 1] [Reviewer 2]  |
|                                                                  |
| REWORK RETURN LANE  <------------------------------              |
|                                                                  |
| ENTRANCE / EXTERNAL AGENTS                                       |
+------------------------------------------------------------------+
```

### 4.1. Leader Office

Chứa:

- Leader desk.
- Whiteboard/plan board.
- Thinking bubble.
- Planning notes.
- Decision indicator.

Leader phải là nhân vật có visual identity rõ nhất.

### 4.2. Dispatch / Briefing Counter

Đây là nơi leader giao việc.

Animation tiêu chuẩn:

1. Leader đứng dậy khỏi bàn.
2. Leader đi tới briefing counter hoặc gọi worker.
3. Worker đi từ khu chờ/desk/entrance đến leader.
4. Leader đưa một task envelope/document.
5. Worker nhận task.
6. Worker quay về bàn được gán.
7. Task badge xuất hiện trên bàn.

### 4.3. Implementer Floor

Mỗi active implement run có một worker actor và một desk.

Desk có thể hiển thị:

- Task title rút gọn.
- Run status.
- Model/agent badge nhỏ.
- Progress percent nếu có.
- Progress note bubble.
- Spinner/keyboard/tool effects.

### 4.4. Review Lab

Reviewer có desk riêng hoặc pool desk.

Reviewer animation:

- Worker mang packet đến reviewer inbox.
- Reviewer nhận packet.
- Reviewer ngồi đọc.
- Dùng kính lúp/checklist/stamp animation.
- Kết thúc bằng stamp:
  - xanh: PASS
  - cam: REWORK
  - đỏ: BLOCK

### 4.5. Decision Table

Dùng cho phase adjudication hoặc khi cần leader xử lý nhiều review/verdict.

Animation:

- Reviewer gửi report.
- Leader/adjudicator đi tới decision table.
- Các report được đặt lên bàn.
- Leader đọc/so sánh.
- Leader tạo verdict/rework slip.

### 4.6. Rework Return Lane

Task cần rework không được chỉ đổi màu tại chỗ.

Nên thể hiện rõ vòng quay:

```text
Reviewer -> Leader/Adjudicator -> Rework Slip -> Worker -> Desk -> Reviewer
```

Mỗi rework cycle hiện badge:

```text
R1, R2, R3...
```

Cycle chỉ tăng khi backend thật sự tạo rework cycle mới.

### 4.7. Report / Archive Area

Khi orchestration chuyển sang reporting:

- Leader hoặc reporter ngồi tại report desk.
- Các task/review summary bay/được xếp thành chồng giấy.
- Report pages được compile.
- Khi done, report được chuyển vào archive/completed cabinet.

### 4.8. User Gate

Đây là điểm hiển thị tương tác với user:

- pending approval
- leader question
- blocked request requiring user action

Có thể dùng cửa, chuông, bảng notification hoặc speech bubble hướng ra ngoài scene.

## 5. Mô hình nhân vật

### 5.1. Stable identity

Một agent phải có hình dạng ổn định trong cùng orchestration và tốt nhất là qua nhiều orchestration trong cùng workspace.

Identity có thể derive từ:

```text
agentId -> hash -> appearance preset
```

Appearance preset gồm:

- skin tone pixel palette
- hair
- shirt
- pants
- accessory

Không sử dụng màu sắc làm tín hiệu duy nhất cho trạng thái.

### 5.2. Role accessories

Leader:

- tie/cape/headset/clipboard đặc trưng

Implementer:

- keyboard/toolbox/laptop

Reviewer:

- glasses/checklist/magnifier

Reporter:

- papers/folder

External/manual agent:

- visitor badge

### 5.3. Agent nameplate

Mỗi actor có nameplate nhỏ:

```text
agent-name
role · model
```

Trong scene mặc định chỉ hiện ngắn gọn. Hover/click mới mở chi tiết.

## 6. Bộ animation tối thiểu cho sprite

Mỗi character nên có các animation states sau:

- `idle`
- `walk_north`
- `walk_south`
- `walk_east`
- `walk_west`
- `think`
- `talk`
- `receive_task`
- `carry_task`
- `type`
- `build`
- `read`
- `inspect`
- `stamp_pass`
- `stamp_rework`
- `stamp_block`
- `handoff`
- `wait`
- `error`
- `celebrate`
- `stop`

Không nhất thiết phải có đầy đủ sprite frame ngay từ milestone đầu tiên. Có thể triển khai theo từng lớp.

## 7. Asset strategy

Đề xuất sprite sheet custom, không sử dụng asset lấy từ game có copyright không rõ ràng.

Kích thước đề xuất:

- 32x32 px hoặc 48x48 px mỗi frame.
- 4 frame cho walk cycle.
- 2-4 frame cho action cycle.

CSS:

```css
image-rendering: pixelated;
```

V1 có thể bắt đầu bằng CSS pixel character đơn giản để hoàn thiện logic trước, sau đó thay bằng sprite sheet chất lượng cao mà không đổi scene engine.

## 8. Công nghệ render đề xuất

### 8.1. DOM/CSS là lựa chọn V1

Khuyến nghị dùng DOM + CSS animation/WAAPI thay vì Canvas ở phiên bản đầu tiên.

Lý do:

- UI hiện tại đã là HTML/TypeScript thuần.
- Click/hover/keyboard accessibility đơn giản hơn.
- Inspector dễ gắn với character/desk.
- Dễ debug.
- Không cần thêm game framework dependency.
- Với vài chục actor thì DOM hoàn toàn đủ.

### 8.2. Quy tắc performance

Movement ưu tiên:

```css
transform: translate3d(...)
```

Không animate các thuộc tính gây layout liên tục như:

- `left`
- `top`
- `width`
- `height`

Sprite animation có thể dùng:

```css
animation-timing-function: steps(...)
```

### 8.3. Khi nào cân nhắc Canvas

Chỉ chuyển sang Canvas nếu stress test cho thấy:

- hàng trăm actors cùng lúc
- nhiều effect particle
- DOM update trở thành bottleneck

Không nên thêm Canvas ngay khi chưa có nhu cầu thực tế.

## 9. Scene State Model

Đề xuất interface khái niệm:

```ts
interface PixelOfficeSceneState {
  orchestrationId: string | null;
  mode:
    | "idle"
    | "planning"
    | "dispatching"
    | "implementing"
    | "reviewing"
    | "adjudicating"
    | "reworking"
    | "reporting"
    | "paused"
    | "failed"
    | "done";
  leader: PixelActorState | null;
  actors: PixelActorState[];
  desks: PixelDeskState[];
  taskPackets: PixelTaskPacketState[];
  reviewPackets: PixelReviewPacketState[];
  notifications: PixelNotificationState[];
  transitions: PixelTransition[];
}
```

Đây chỉ là contract đề xuất. Tên/type cuối cùng cần được điều chỉnh theo conventions của repo khi implementation.

## 10. Mapping backend -> visual state

| Backend source | Điều kiện | Scene semantic state | Animation chính | Static fallback |
|---|---|---|---|---|
| `orchestration.status` | `planning` | Leader planning | Leader ngồi suy nghĩ, whiteboard xuất notes | Leader desk + Planning badge |
| active run | `phase=plan`, running | Plan generation | Think bubble, paper/whiteboard animation | Plan run badge |
| `questions` | pending | Waiting for user answer | Leader quay về user gate, speech bubble `?` | Question badge |
| `approvals` | pending | Waiting for approval | Worker đứng tại briefing, envelope chưa được giao | Approval badge |
| subtask | ready/queued | Waiting dispatch | Worker idle/waiting area | Queue counter |
| active run | `phase=implement` | Implementing | Worker đi tới desk rồi typing/building | Worker at desk + Running |
| run progress | percent/note present | Work progress | Desk monitor/progress effect | Progress bar/text |
| implement run | done | Handoff to review | Worker cầm task packet đi tới review lab | Done badge + Review pending |
| subtask | review | Awaiting reviewer | Packet nằm ở reviewer inbox | Review queue badge |
| active run | `phase=review` | Reviewing | Reviewer đọc/check/magnifier | Reviewer desk + Reviewing |
| review verdict | pass | Review passed | Green stamp + packet gửi leader | PASS badge |
| review verdict | rework | Needs rework | Orange stamp + packet quay lại leader | REWORK badge |
| review verdict | block | Blocked | Red stamp + warning effect | BLOCK badge |
| active run | `phase=adjudicate` | Adjudicating | Leader/reviewer tại decision table | Adjudicating badge |
| orchestration | `adjudicating` | Decision stage | Report packets trên decision table | Decision panel |
| new subtask key | `*-rework-*` | Rework dispatch | Leader tạo rework slip, gọi worker | Rework cycle badge |
| active run | implement on rework subtask | Reworking | Worker nhận rework slip và làm lại | Rn badge |
| active run | `phase=report` | Reporting | Compile papers/report desk | Reporting badge |
| orchestration | `paused` | Paused | Scene dim/freeze, pause icon | Paused banner |
| run | failed | Agent failure | Actor error animation, desk red alert | Failed badge |
| orchestration | `failed` | Workflow failure | Office alarm/error state | Failed banner |
| orchestration | `done` | Completed | Agents celebrate ngắn, report archive | Done banner |
| run | detached/manual/adopted | External actor | Actor đi từ entrance vào assigned seat | Visitor badge |

## 11. Workflow animation chi tiết

### 11.1. Planning

Trigger:

- orchestration status `planning`
- hoặc active run phase `plan`

Sequence:

1. Leader đi về leader desk.
2. Animation `think`.
3. Thought bubble xuất hiện.
4. Whiteboard dần xuất các sticky notes tượng trưng cho subtasks.
5. Khi plan run hoàn thành, leader đứng dậy.
6. Plan notes được chuyển từ whiteboard xuống dispatch queue.
7. Scene chuyển sang execution/dispatch.

Nếu user reload giữa bước 4, UI không cần replay toàn bộ planning. Scene chỉ dựng trạng thái đúng hiện tại.

### 11.2. Dispatch task

Trigger:

- subtask trở thành eligible để chạy
- hoặc implement run mới xuất hiện

Sequence:

1. Leader đi tới dispatch counter.
2. Leader gọi đúng worker.
3. Worker đi đến counter.
4. Task packet xuất hiện.
5. Nếu cần approval:
   - worker đứng chờ
   - packet nhấp nháy tại counter
   - user gate hiển thị approval
6. Khi approved:
   - leader trao packet
   - worker nhận
   - worker đi về desk
7. Run active -> desk chuyển sang working state.

### 11.3. Implementing

Trong lúc active implement run:

- worker typing/building loop
- monitor flicker nhẹ
- task label trên desk
- progressPercent -> progress bar nhỏ
- progressNote -> speech bubble/status ticker

Nếu run waiting:

- worker dừng typing
- animation `wait`

Nếu run stopping:

- worker dọn desk/stop animation

Nếu failed:

- error icon trên monitor
- actor đứng dậy/error reaction

### 11.4. Implement -> Review handoff

Trigger:

- implement run done
- subtask chuyển sang review

Sequence:

1. Worker ngừng typing.
2. Packet/task artifact xuất hiện trên desk.
3. Worker cầm packet.
4. Worker đi đến reviewer inbox.
5. `handoff` animation.
6. Packet chuyển ownership sang reviewer.
7. Worker quay về desk hoặc idle area.

Nếu reviewer run đã bắt đầu trước khi sequence kết thúc do poll latency, animation phải được rút gọn và reconcile.

### 11.5. Reviewing

Trigger:

- active run phase `review`

Sequence:

1. Reviewer nhận packet.
2. Reviewer ngồi desk.
3. `read` -> `inspect` loop.
4. Checklist items bật lần lượt.
5. Khi review row xuất hiện, reviewer đóng checklist.
6. Stamp verdict.

### 11.6. Review PASS

Sequence:

1. Green PASS stamp.
2. Reviewer cho report vào folder xanh.
3. Folder được gửi tới decision table/leader.
4. Task desk nhận completed indicator.

### 11.7. Review REWORK

Sequence:

1. Orange REWORK stamp.
2. Reviewer đặt report vào orange folder.
3. Reviewer/runner mang report đến leader/adjudicator.
4. Leader đọc report.
5. Leader tạo rework slip.
6. Worker được gọi quay lại briefing counter.
7. Worker nhận rework slip.
8. Worker quay lại desk.
9. Desk badge hiện `R1`, `R2`...
10. Worker làm lại.
11. Hoàn thành thì lại đi review.

Đây là loop quan trọng cần animation rõ ràng nhất.

### 11.8. Review BLOCK

Sequence:

1. Red BLOCK stamp.
2. Reviewer gọi attention.
3. Report đi về leader.
4. Leader/adjudicator xử lý decision.
5. Nếu backend chuyển failed/blocking state, office hiển thị warning.

### 11.9. Adjudication

Trigger:

- orchestration `adjudicating`
- hoặc active run phase `adjudicate`

Sequence:

1. Leader đến decision table.
2. Review report packets được đặt lên bàn.
3. Leader đọc/so sánh.
4. Decision animation.
5. Backend quyết định pass/rework/block.
6. Scene phát transition phù hợp.

### 11.10. Reporting

Trigger:

- orchestration `reporting`
- hoặc active run phase `report`

Sequence:

1. Task packets từ các zone thu về report desk.
2. Leader/reporter compile report.
3. Pages xếp thành document.
4. Khi report done, document đóng folder.
5. Folder chuyển vào archive.

### 11.11. Done

Sequence ngắn, không gây phiền:

- desk lights xanh nhẹ
- agents đứng dậy/celebrate 1-2 cycle
- completed banner
- archive cabinet nhận report

Sau animation, office trở về idle completed state.

### 11.12. Paused

Không nên dừng DOM một cách mù quáng.

Thay vào đó:

- dim scene
- actor chuyển idle/frozen pose
- pause icon lớn vừa phải
- click actor vẫn mở inspector
- resume sẽ derive scene mới từ backend rồi tiếp tục

### 11.13. Failed

Phân biệt:

- một run failed
- toàn orchestration failed

Run failed:

- chỉ desk/actor liên quan báo lỗi

Orchestration failed:

- scene global warning
- leader reaction
- status summary rõ ràng

## 12. Transition Queue

Không render lại toàn bộ scene bằng `innerHTML` mỗi poll.

Client giữ:

```text
previousSnapshot
currentSnapshot
sceneState
transitionQueue
```

Mỗi poll:

1. Nhận board snapshot mới.
2. Normalize dữ liệu.
3. Compare với snapshot trước.
4. Sinh semantic transitions.
5. Dedupe transitions.
6. Push vào queue.
7. Scene controller chạy animation.
8. Reconcile với authoritative current snapshot.

Ví dụ semantic transition:

```ts
{
  type: "IMPLEMENT_COMPLETED",
  runId,
  subtaskKey,
  actorId,
  reviewTarget
}
```

Không nên để animation engine phụ thuộc trực tiếp vào raw JSON diff.

## 13. Deduplication

Transition cần stable key.

Ví dụ:

```text
run:<runId>:started
run:<runId>:done
review:<reviewId>:verdict
subtask:<key>:rework:<cycle>
event:<eventId>
```

Một event đã chạy animation thì không được replay mỗi poll.

## 14. Reconciliation khi polling bỏ qua trạng thái trung gian

Ví dụ:

Poll N:

```text
implement running
```

Poll N+1:

```text
review already complete + rework created
```

UI không được mất đồng bộ chỉ vì không quan sát được snapshot `implement done` và `review running`.

Giải pháp:

1. Xác định current authoritative state.
2. Sinh transition chain ngắn nhất có ý nghĩa.
3. Nếu animation backlog quá dài, bỏ bớt animation trung gian.
4. Đảm bảo actor cuối cùng đứng đúng zone/state.

Rule đề xuất:

- transition <= 2 bước phía sau: play đầy đủ
- 3-5 bước phía sau: play compressed
- >5 bước hoặc orchestration completed: fast-forward

## 15. Scene actor lifecycle

### 15.1. Actor registry

Client giữ actor registry:

```text
agentId -> PixelActorController
```

Không tạo actor DOM mới mỗi poll.

### 15.2. Run association

Một agent có thể chạy nhiều run theo thời gian.

Do đó tách:

```text
actor identity != run identity
```

Actor có thể đổi task packet nhưng vẫn là cùng nhân vật.

### 15.3. Parallel runs

Nếu một agent backend có khả năng nhiều run song song, cần quyết định UI:

- hoặc clone avatar dạng `agent-instance`
- hoặc desk stack task

Khuyến nghị dùng `agent-instance` keyed bằng `runId` nếu thật sự có concurrent runs trên cùng agent.

## 16. Desk allocation

Desk assignment cần stable để nhân vật không nhảy vị trí mỗi poll.

Key đề xuất:

```text
agentId -> deskId
```

Khi agent rời workflow:

- desk giữ assignment một khoảng grace period
- sau đó mới recycle

Đối với > số desk visible:

- mở rộng grid
- hoặc scroll scene ngang
- hoặc tạo second row

Không nên teleport agent sang desk khác chỉ vì sort order thay đổi.

## 17. Path system

Không cần A* pathfinding trong V1.

Scene có thể định nghĩa waypoint graph cố định:

```text
leaderDesk
dispatchPoint
deskRowA1..N
deskRowB1..N
reviewInbox
reviewDesk1..N
decisionTable
reportDesk
entrance
userGate
```

Movement:

```text
currentPoint -> corridor waypoint -> targetPoint
```

Điều này đủ tạo cảm giác nhân vật thật sự đi lại mà không cần engine phức tạp.

## 18. Run Inspector

Việc bỏ Runs card không được làm mất thông tin hiện tại.

Click vào:

- actor
- desk
- task packet
- reviewer

sẽ mở inspector/drawer.

Inspector nên chứa lại các thông tin hiện Runs card đang có hoặc tương đương:

- run id
- agent
- role
- model
- phase
- status
- task/subtask
- progress
- recent log tail
- full log action
- stop action nếu hợp lệ
- model controls nếu hiện tại Runs card có
- timestamps
- review association

Nếu user click leader, inspector chuyển sang orchestration summary.

## 19. Toolbar thay thế Runs filters

Các filter hiện tại không nên biến mất hoàn toàn.

Đề xuất toolbar trên Pixel Office:

- Active
- This cycle
- All
- Show completed desks toggle
- Show task labels toggle
- Reduced effects toggle tùy chọn

Filter chỉ ảnh hưởng visibility/history overlay, không được thay đổi authoritative scene state.

## 20. Old Runs compatibility strategy

Trong giai đoạn migration nên có feature flag:

```text
Pixel Office | Classic Runs
```

Mục đích:

- dễ debug
- dễ rollback
- so sánh parity
- giảm rủi ro mất chức năng Runs card

Khi Pixel Office đạt đủ acceptance criteria mới cân nhắc bỏ Classic Runs.

## 21. State reducer đề xuất

Tách logic derive scene khỏi DOM renderer.

Pseudo pipeline:

```ts
board payload
  -> normalizeBoardSnapshot()
  -> deriveOfficeState()
  -> diffOfficeState(previous, current)
  -> buildTransitions()
  -> sceneController.apply()
```

Lợi ích:

- test dễ
- animation engine không dính backend structure
- có thể replay snapshot fixtures
- giảm logic spaghetti trong `main.ts`

## 22. Module split đề xuất

Không nên tiếp tục nhồi toàn bộ Pixel Office vào `packages/cli/src/ui-client/main.ts`.

Đề xuất thư mục:

```text
packages/cli/src/ui-client/orchestrator-office/
  types.ts
  normalize.ts
  derive-state.ts
  transitions.ts
  scene-controller.ts
  actor-controller.ts
  desk-controller.ts
  paths.ts
  sprites.ts
  inspector.ts
```

Tên cuối cùng cần kiểm tra conventions/build pipeline khi bắt đầu implement.

## 23. File impact dự kiến

### `packages/cli/src/ui-page.ts`

Thay đổi:

- Runs markup -> Pixel Office shell.
- Scene container.
- Toolbar.
- Inspector drawer/modal.
- Pixel Office CSS base.
- Responsive rules.
- reduced-motion rules.

Không thay logic orchestrator backend.

### `packages/cli/src/ui-client/main.ts`

Thay đổi:

- Giữ polling `/api/workforce/board`.
- Giữ các action APIs hiện có.
- Thay `renderOrchestratorRun`/run-grid orchestration bằng Pixel Office controller.
- Gửi board snapshot vào scene reducer/controller.
- Giữ Classic Runs renderer tạm thời nếu feature flag được dùng.

### `packages/cli/src/ui-client/orchestrator-office/*`

Mới:

- derived scene state
- semantic diff
- transition queue
- actor lifecycle
- desk allocation
- path movement
- inspector integration

### `packages/cli/src/commands/routes/workforce.ts`

V1 ưu tiên không sửa backend route nếu dữ liệu hiện tại đủ dùng.

Chỉ bổ sung field khi implementation chứng minh có ambiguity không thể giải quyết ổn định từ payload hiện có.

Possible future fields:

```text
visualSeq
eventSeq
structured transition metadata
```

Không thêm chỉ để thuận tiện nếu client có thể derive chính xác.

### Tests

Dự kiến liên quan:

- `packages/cli/src/commands/ui.test.ts`
- `packages/cli/src/commands/ui-routes.test.ts` nếu API thay đổi
- test mới cho office state reducer/transition logic

## 24. Event usage strategy

Existing orchestration events có các kind như:

- `leader_turn`
- `spawn`
- `run_ended`
- `verdict`
- `rework`
- `error`
- `user_action`

Ưu tiên tận dụng các event này làm evidence để sinh animation transition chính xác hơn.

Tuy nhiên scene không được phụ thuộc hoàn toàn vào event history vì:

- user có thể reload browser
- event window có thể bị trim
- UI có thể reconnect sau thời gian dài

Rule:

```text
snapshot determines current truth
events improve transition fidelity
```

## 25. Reload / reconnect behavior

Khi user reload:

1. Không replay toàn lịch sử animation.
2. Fetch board snapshot.
3. Derive scene ngay lập tức.
4. Actor xuất hiện tại vị trí phù hợp với state hiện tại.
5. Chỉ animation mới sau thời điểm load được enqueue.

Ví dụ:

Nếu reload khi worker đang review:

- reviewer phải xuất hiện đang đọc ngay
- không cần replay worker nhận task -> code -> handoff

## 26. Approval flow

Khi pending approval:

- actor liên quan đi đến briefing/approval waiting point
- envelope/task chưa được handoff hoàn toàn
- user gate sáng lên
- approval count badge

Khi approved:

- play `approved` transition
- task handoff tiếp tục

Khi denied:

- leader thu lại envelope
- worker quay lại idle
- scene phản ánh run/task state backend trả về

## 27. Leader question flow

Khi leader đặt câu hỏi:

1. Leader rời whiteboard/decision table.
2. Leader quay về user gate.
3. Speech bubble xuất hiện.
4. Office liên quan có thể chuyển waiting animation.

Khi user trả lời:

1. Bubble biến mất.
2. Leader quay lại work zone.
3. Scene tiếp tục derive từ snapshot tiếp theo.

## 28. External/adopted session

Khi một external session được adopt:

1. Actor xuất hiện ở entrance.
2. Visitor badge hiện ngắn.
3. Actor đi đến briefing point.
4. Sau khi association rõ ràng, actor đi tới desk phù hợp.

Nếu detached:

- actor rời desk
- đi ra entrance
- desk chuyển detached state

## 29. Responsive design

Desktop là trải nghiệm chính nhưng cần hoạt động trên cửa sổ hẹp.

Desktop:

- full office layout
- nhiều desk song song

Medium width:

- scene scroll ngang
- inspector overlay

Small width:

- simplified zones
- actors vẫn đúng state
- giảm decoration/effects

Không nên scale toàn scene nhỏ đến mức text không đọc được.

## 30. Accessibility

Animation không được là nguồn thông tin duy nhất.

Yêu cầu:

- `prefers-reduced-motion`.
- Keyboard focus cho actor/desk.
- ARIA label mô tả state.
- Tooltip text.
- Status text panel fallback.
- Không phân biệt PASS/REWORK/BLOCK chỉ bằng màu.

Reduced-motion mode:

- bỏ walking tween dài
- actor snap/short fade sang vị trí mới
- vẫn giữ icon/badge/status text

## 31. Performance budget

Target sơ bộ:

- 60 FPS khi vài chục actor/effect.
- Không full DOM rebuild mỗi poll.
- Không render full logs trong scene.
- Inspector mới fetch/show log chi tiết khi cần.
- Limit particle effects.
- Actor DOM reused.
- Scene effect objects recycled.

Nếu số historical runs lớn, history chỉ hiện trong inspector/list overlay, không biến thành hàng trăm nhân vật trong office.

## 32. Animation backlog control

Transition queue phải có max backlog.

Ví dụ:

```text
MAX_QUEUED_TRANSITIONS = 20
```

Nếu vượt ngưỡng:

- drop cosmetic transitions trước
- compress movement
- giữ semantic critical transitions:
  - verdict
  - rework
  - failed
  - done
  - approval/question

Mục tiêu là chính xác state trước, đẹp sau.

## 33. Effect priority

### Critical

- task ownership
- worker/reviewer identity
- pass/rework/block
- failure
- waiting approval/question
- paused
- done

### Important

- walking
- handoff packet
- thinking
- working desk loop

### Cosmetic

- particles
- lights
- coffee animation
- decorative NPC movement
- celebration confetti

Khi performance thấp, disable từ Cosmetic trước.

## 34. Sound

Âm thanh chỉ là optional polish phase.

Nếu có:

- mặc định OFF
- click/notification nhẹ
- task handoff
- stamp
- done chime

Không được autoplay sound mặc định.

## 35. Milestone triển khai

### Phase 0 - Contract và static mock

Mục tiêu:

- chốt scene zones
- chốt actor/desk/task packet model
- chốt mapping backend -> scene
- tạo static Pixel Office shell

Deliverable:

- office layout hiển thị trong UI
- chưa cần animation phức tạp
- dữ liệu thật có thể map vào labels

### Phase 1 - Derived state engine

Mục tiêu:

- `normalizeBoardSnapshot`
- `deriveOfficeState`
- stable actor identity
- stable desk assignment

Tests:

- planning
- implementing
- reviewing derived từ active review run
- reworking derived từ rework subtask/review
- reporting
- done/failed/paused

### Phase 2 - Core movement và workflow

Mục tiêu:

- walk paths
- leader planning
- dispatch
- worker desk working
- implement -> review handoff
- reviewer working
- verdict stamps

Đây là phase đầu tiên tạo được cảm giác “văn phòng sống”.

### Phase 3 - Rework/adjudication đầy đủ

Mục tiêu:

- decision table
- review packet to leader
- rework slip
- worker return loop
- rework cycle badge
- block handling

Đây là phase quan trọng nhất sau core flow vì user muốn nhìn rõ vòng reviewer -> rework.

### Phase 4 - User interaction states

Mục tiêu:

- approval
- questions
- paused
- stop/stopping
- error
- external/adopted sessions

### Phase 5 - Inspector và feature parity

Mục tiêu:

- click actor/desk
- run inspector
- full-log access
- stop/model controls nếu đang có
- filters Active/This cycle/All
- Classic Runs fallback

Không coi Pixel Office hoàn tất nếu mất capability quản lý Runs hiện tại.

### Phase 6 - Polish

Mục tiêu:

- sprite sheets đẹp
- environment props
- lights
- particles vừa phải
- celebration
- better walk cycles
- better rework visual storytelling

### Phase 7 - Hardening

Mục tiêu:

- stress test
- reconnect/reload
- polling skip reconciliation
- many parallel agents
- reduced motion
- responsive
- memory leaks
- stale transition cleanup

### Phase 8 - Default rollout

Mục tiêu:

- Pixel Office trở thành default view
- Classic Runs giữ dưới fallback một thời gian
- sau khi ổn định mới cân nhắc remove legacy Runs layout

## 36. Test matrix

### State reducer unit tests

Các case bắt buộc:

1. No orchestration -> idle office.
2. Planning + plan run running.
3. Planning + pending leader question.
4. Executing + queued subtask.
5. Implement run starting.
6. Implement run running.
7. Implement run waiting.
8. Implement run done -> subtask review.
9. Review run running.
10. Review PASS.
11. Review REWORK.
12. Review BLOCK.
13. Adjudication active.
14. Rework subtask created.
15. Rework cycle N implement running.
16. Reporting.
17. Done.
18. Failed run only.
19. Failed orchestration.
20. Paused.
21. Pending approval.
22. Approval resolved.
23. External/adopted run.
24. Detached run.

### Transition tests

Test semantic transitions:

```text
plan -> execute
queued -> assigned
assigned -> running
running -> review handoff
review -> pass
review -> rework
rework -> implement
review -> block
adjudicate -> report
report -> done
```

### Reconciliation tests

Snapshot skip cases:

- running -> review done
- planning -> implementing
- implementing -> rework
- review -> reporting
- active -> done

Expected:

- không duplicate actor
- không replay vô hạn
- scene hội tụ đúng state

### DOM behavior tests

- stable actor DOM node across polls
- stable desk assignment
- click actor opens correct run
- completed historical runs không tạo active actor sai
- filter không phá scene state

### Accessibility tests

- prefers-reduced-motion
- keyboard navigation
- ARIA state
- status readable without animation

### Performance tests

Fixtures:

- 1 leader + 3 workers
- 1 leader + 10 workers + 5 reviewers
- 20+ active/visible actors
- 100 historical runs

Kiểm tra:

- không full page rerender
- không memory leak actor controller
- transition queue bounded

## 37. Acceptance criteria

Pixel Office chỉ được coi là hoàn thành khi đáp ứng tất cả các điểm sau:

1. Người dùng có thể nhìn scene và phân biệt rõ planning, implementing, reviewing, reworking, adjudicating, reporting.
2. Leader có animation planning/thinking riêng.
3. Dispatch task được thể hiện bằng interaction giữa leader và worker.
4. Active implement run có đúng worker đang làm tại desk.
5. Khi implement xong, task được thể hiện là bàn giao cho reviewer.
6. Reviewer có animation kiểm tra riêng.
7. PASS, REWORK và BLOCK có visual khác nhau và có text/icon tương ứng.
8. Rework loop được thể hiện đầy đủ reviewer -> leader/adjudicator -> worker -> reviewer.
9. Rework cycle không tăng sai so với backend.
10. Reporting và done có scene rõ ràng.
11. Pending approval/question hiển thị chính xác.
12. Failed/paused/stopping không bị mô tả sai bởi animation.
13. Reload page dựng đúng current state mà không replay toàn lịch sử.
14. Scene hội tụ về snapshot mới nhất trong tối đa một polling cycle + thời gian transition bounded.
15. Không duplicate actor qua nhiều poll.
16. Run inspector giữ đủ thông tin/capability quan trọng của Runs card cũ.
17. `prefers-reduced-motion` vẫn truyền đạt đầy đủ trạng thái.
18. Backend orchestration behavior không bị thay đổi chỉ để phục vụ animation.
19. Classic Runs có thể bật lại trong rollout phase nếu cần debug/rollback.
20. Performance vẫn mượt với số agent song song thực tế của orchestrator.

## 38. Rủi ro và cách xử lý

### Rủi ro 1: Snapshot polling bỏ qua transition

Giải pháp:

- semantic diff
- events hỗ trợ fidelity
- reconciliation + fast-forward

### Rủi ro 2: `reviewing/reworking` không được backend set đầy đủ

Giải pháp:

- derived scene state từ phase/runs/reviews/subtasks/events

Không sửa core state machine chỉ để animation đẹp hơn trong V1.

### Rủi ro 3: Animation backlog

Giải pháp:

- queue cap
- transition compression
- cosmetic drop priority

### Rủi ro 4: Actor nhảy desk

Giải pháp:

- stable desk allocation keyed by agent/run

### Rủi ro 5: Duplicated actor sau reload/poll

Giải pháp:

- keyed actor registry
- idempotent scene updates

### Rủi ro 6: Mất chức năng Runs hiện tại

Giải pháp:

- run inspector
- parity checklist
- Classic Runs feature flag trong rollout

### Rủi ro 7: Asset tốn thời gian

Giải pháp:

- hoàn thiện scene engine bằng CSS/block sprites trước
- polish sprite sheet sau

### Rủi ro 8: Accessibility

Giải pháp:

- reduced motion
- text labels
- keyboard
- ARIA

## 39. Out of scope cho V1

- Full game engine.
- Physics engine.
- Free-form A* pathfinding.
- Multiplayer interaction.
- User điều khiển nhân vật bằng bàn phím.
- Audio bắt buộc.
- 3D scene.
- Rewrite orchestration backend state machine.
- Persist animation timeline vào database.
- Replay toàn bộ orchestration như video timeline.

Các mục này có thể xem xét sau khi Pixel Office core đã ổn định.

## 40. Thứ tự implementation khuyến nghị

Khi bắt đầu code, nên thực hiện theo thứ tự:

```text
1. Static office shell
2. Board snapshot normalizer
3. Derived scene state
4. Stable actors/desks
5. Leader planning
6. Dispatch
7. Implementing
8. Review handoff
9. Reviewer + verdict
10. Adjudication
11. Rework loop
12. Reporting/done
13. Approval/question/error/pause
14. Inspector parity
15. Reconciliation/queue hardening
16. Sprite polish
17. Responsive/accessibility/performance
18. Default rollout
```

Không nên bắt đầu bằng sprite polish trước khi state reducer và transition semantics ổn định.

## 41. Definition of Done cho toàn bộ upgrade

Upgrade được xem là hoàn tất khi Pixel Office trở thành một biểu diễn trực quan đáng tin cậy của workflow orchestration, không chỉ là animation trang trí.

Người dùng phải có thể quan sát toàn bộ vòng đời:

```text
Leader thinks
  -> creates plan
  -> dispatches task
  -> worker receives task
  -> worker works at desk
  -> worker hands result to reviewer
  -> reviewer inspects
  -> PASS / REWORK / BLOCK
  -> leader adjudicates
  -> rework returns to worker when needed
  -> repeated review cycle
  -> report generation
  -> final completion
```

Mọi animation phải luôn hội tụ về trạng thái backend thật, vẫn giữ được khả năng quản lý run hiện tại, và không làm orchestration phụ thuộc vào tốc độ hoặc trạng thái của UI.

