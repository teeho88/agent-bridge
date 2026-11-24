# Kế hoạch quản lý task và tối ưu token cho coding agent

**Trạng thái hiện hành 28/10/2026:** G5 round8003d0db: 6/6 smoke reviewed PASS; state smoke-completed; last S-0-handoff-2-attempt-2; formal0/50, measurementComplete=false/releasePassed=false. Active locator .local/g5-active-preparation-20261028.json; runner session none. Preserve all terminal rounds and successful evidence. Review each completed attempt before next invocation.

**Cấu hình test hiện hành:** Mọi campaign/test model mới của Phase 8.2 dùng **GPT-6 Web High** (`chatgpt-web/gpt-6-sol`, effort `high`, budget `unbounded`), cùng cấu hình cho B/S, không tự fallback hoặc gộp với Luna/Medium lịch sử. G5 đã freeze pool 44 identities/44 workspaces, 6 smoke/50 formal, tối đa hai attempts/slot; capacity planning sau tối ưu còn dự toán 4,43–4,89 GiB và dung lượng trống quan sát gần nhất 19,6 GiB. Xem [kế hoạch chuyển model](docs/phase8-2-gpt6-web-high-test-plan-20261024.md) và [trình tự G5–G7](docs/phase8-2-completion-plan-20261022.md). Diagnostic không cấp quyền formal hoặc thay thế smoke/formal operational.

Trạng thái lịch sử 22/10/2026: quyền runtime/registry/process đã gỡ; offline 45/45, controls 10/10, CLI 56 commands, native proof 7/7/0 SKIP, independent build/preflight và pool sáu identities PASS. Đã freeze diagnostic riêng nhưng G4 BLOCKED sau một invocation B-small: agent bỏ Set-Location ở một PowerShell call, self-verifier thất bại vì source claims không có trong canonical; ledger/checkpoint chưa đủ. Turn completed, zero writers/sessions/leases và cleanup PASS; supplemental acceptance 2/2 không cấp gate credit. Không retry/successor; measurementComplete=false, releasePassed=false. [Báo cáo G4 retry](docs/phase8-2-remediation-20261019/diagnostics/g4-retry-20261022-0abbf0b9/report.md). Các đoạn bên dưới giữ lịch sử từng lượt.

Ngày lập: 16/10/2026. Trạng thái lịch sử: Phase 0–7 và 8.1 được ghi done trong nhật ký; baseline revision 5 từng có 25/25 lượt và review 24 PASS, 1 REWORK. Historical raw/frozen evidence đã mất trước đợt chạy lại ngày 19/10, nên hiện không thể kiểm chứng lại các kết luận đó từ artifact gốc. Source sản phẩm hiện tại vẫn ở packages/. Trạng thái mới: đã phục hồi runtime/adapter phục vụ benchmark, dựng/build/freeze baseline B riêng từ ZIP và các thay đổi pre-Phase-1 có provenance; không khẳng định byte-identical baseline cũ. Phase 8.2 blocked: round phục hồi c50beabc... đã chạy hai smoke attempts B-small, acceptance đều 2/2 nhưng content REWORK rồi blocked; attempt 2 vượt guard 1000000 input+output và giữ source claim sai. State quality_failed, smoke 0 latest PASS, formal 0/50, S chưa chạy, releasePassed=false. Baseline đo lại chưa hoàn tất. Xem docs/phase8-2-recovery-report-20261019.md; chưa mở 8.3 hoặc Phase 9.

## 1. Mục tiêu và phạm vi

- Quản lý task từ yêu cầu đến kết quả đã kiểm chứng, có thể tiếp tục hoặc bàn giao.
- Giảm tổng token cho một task hoàn thành đúng; theo dõi cả thời gian và số lần làm lại. Theo yêu cầu ngày 18/10/2026, tạm hoãn tính chi phí tiền; pricing không phải điều kiện nghiệm thu hiện tại.
- Hỗ trợ một agent trước, sau đó nhiều agent, giữ đúng task/session và tránh sửa xung đột.
- Tận dụng Agent Bridge hiện có; không mặc định xây lại task, context compiler, handoff, lease hoặc dashboard.
- File này là kế hoạch triển khai, chưa xác nhận chức năng nào đã hoạt động đúng và chưa cho phép tự động thay đổi các file khác.

Tài liệu đối chiếu: [README](README.md), [token efficiency](docs/token-efficiency-improvement-plan.md), [leader orchestration](docs/workforce-leader-orchestration-plan.md). Các đề xuất cũ phải được kiểm tra trên code hiện tại trước khi áp dụng. Plan này không tự thay thế các quyết định trước đó.

## 2. Quy tắc thực hiện tuần tự

1. Thực hiện đúng thứ tự phase, rồi đúng thứ tự bước trong từng phase. Chỉ có một bước triển khai ở trạng thái `in_progress`.
2. Chỉ đánh dấu `[x]` khi đầu ra tồn tại, điều kiện đạt đã được kiểm tra và bằng chứng đã được ghi.
3. Bước chưa đạt hoặc `blocked` thì dừng các bước phụ thuộc; ghi nguyên nhân, việc cần xử lý và bước tiếp theo. Không bỏ qua, tự coi là đạt hoặc mở phase sau.
4. Chức năng đã có vẫn phải được xác minh; được tái sử dụng sau khi có bằng chứng đạt, không cần viết lại.
5. Phát hiện lỗi ở bước trước thì mở lại bước đó, tạm dừng bước hiện tại và kiểm tra lại các kết quả bị ảnh hưởng.
6. Không mở rộng phạm vi để xử lý lỗi không liên quan. Ghi thành backlog riêng; lỗi chặn tiêu chí hiện tại phải giải quyết trước.
7. Ghi checkpoint ở cuối bước và trước compact/bàn giao. Không bắt buộc gọi agent hoặc ghi bộ nhớ sau mỗi lần đọc file.
8. Sau khi hệ thống đã được kiểm chứng, các task độc lập mới được chạy song song theo Phase 6. Việc đó không cho phép triển khai song song các bước của plan này.

Mỗi bước ghi một bản cập nhật theo mẫu sau ngay dưới mục “Nhật ký thực hiện”:

```text
Bước: mã bước
Trạng thái: todo | in_progress | blocked | review | done
Người/agent phụ trách:
Đầu ra: đường dẫn artifact hoặc commit liên quan
Kiểm tra: lệnh/kịch bản và kết quả thực tế
Quyết định hoặc blocker:
Bước tiếp theo:
```

`done` yêu cầu đủ bằng chứng; không ghi test PASS nếu chưa chạy. Chỉ cập nhật chỉ số từ dữ liệu thật; dữ liệu thiếu là `null`, không phải 0.

## 3. Phase 0 — Đối chiếu hiện trạng và chốt cách đo

### [x] 0.1 — Lập bản đồ chức năng hiện có

- Làm: tìm entry point của task/state, context compiler, session, handoff/checkpoint, file lease, orchestration, telemetry và dashboard; đọc đoạn liên quan.
- Đầu ra: bảng `chức năng → file/symbol → hành vi quan sát → thiếu sót → tái sử dụng/sửa/thêm`.
- Đạt khi: mỗi nhóm trên có vị trí code và ít nhất một cách kiểm chứng; phân biệt tài liệu mô tả với hành vi đã xác minh.

### [x] 0.2 — Chốt protocol đo và tiêu chí chất lượng

- Làm: chọn tập task đại diện cho sửa nhỏ, debug, thay đổi nhiều module và bàn giao; cố định input snapshot, acceptance, model/effort và cách thu usage cho từng phép so sánh.
- Đầu ra: protocol ghi rõ số lượt, thứ tự chạy, baseline, cách tính chi phí, ngưỡng chất lượng và ngưỡng hiệu quả được dùng để quyết định phát hành.
- Đạt khi: có thể chạy lại cùng task và đánh giá cùng tiêu chí; retry, review, handoff và phần đo thiếu được quy định rõ. Không tự áp dụng ngưỡng từ tài liệu cũ khi protocol chưa chốt.

### [x] 0.3 — Thu baseline trước thay đổi

- Làm: chạy protocol trên phiên bản hiện tại; lưu usage thô, thời gian, tool calls, kết quả và số lần làm lại.
- Đầu ra: baseline gắn phiên bản code, cấu hình và task snapshot.
- Đạt khi: dữ liệu đủ theo protocol; phần provider không cung cấp được ghi rõ. Thiếu runtime hoặc usage bắt buộc thì bước này bị blocked.

Điều kiện kết thúc Phase 0: 0.1–0.3 đều done; có bản đồ hiện trạng và baseline dùng được.

## 4. Phase 1 — Chuẩn hóa task và trạng thái

### [x] 1.1 — Chốt contract task tối thiểu

- Làm: chuẩn hóa `id`, tiêu đề, mục tiêu, scope, constraints, acceptance, cách kiểm tra, owner, dependency và trạng thái; trạng thái tiếp tục gồm decisions, changes, checks, blocker, next step và context references.
- Đầu ra: schema và mẫu task, ánh xạ vào dữ liệu hiện có thay vì tạo bản lưu trùng.
- Đạt khi: biểu diễn được cả task nhỏ và task nhiều module; thông tin dài được tham chiếu bằng đường dẫn, không sao chép toàn bộ hội thoại.

### [x] 1.2 — Kiểm soát vòng đời và người phụ trách

- Làm: áp dụng `todo → in_progress → review → done`; cho phép blocked kèm lý do và trạng thái quay lại; review không đạt quay về in_progress. Claim owner phải nguyên tử để tránh hai agent nhận cùng task.
- Đầu ra: quy tắc chuyển trạng thái và cơ chế xác thực tương ứng.
- Đạt khi: không chạy task thiếu đầu vào bắt buộc, không có hai owner đồng thời và không chuyển done khi acceptance/checks chưa đủ.

### [x] 1.3 — Xác minh tạo, sửa và tiếp tục task

- Làm: kiểm tra tạo task, cập nhật mục tiêu, restart, review/rework, blocked/unblock và đọc task từ CLI/dashboard nếu có.
- Đầu ra: kết quả kiểm tra lưu trạng thái và tương thích dữ liệu cũ.
- Đạt khi: task không mất owner, constraints hoặc tiến độ sau khi mở lại; không phát sinh hai nguồn trạng thái mâu thuẫn.

Điều kiện kết thúc Phase 1: 1.1–1.3 done; task và acceptance là nguồn xác định công việc cần làm.

## 5. Phase 2 — Kiểm soát context và output công cụ

### [x] 2.1 — Gắn context đúng task/session/request

- Làm: đối chiếu binding giữa task, agent, session và yêu cầu hiện tại; trường hợp mơ hồ phải trả thông báo rõ thay vì chọn task bất kỳ.
- Đầu ra: context có định danh và revision; kiểm tra đổi task, tiếp tục phiên và hai phiên cùng provider.
- Đạt khi: không nạp goal hoặc handoff của task khác; artifact cũ không được trình bày như mới.

### [x] 2.2 — Chọn nội dung liên quan và chặn tổng budget

- Làm: ưu tiên yêu cầu hiện tại, constraints, quyết định còn hiệu lực, next step và file liên quan; dedupe và bỏ mục rỗng. Budget tính cả bản render cuối.
- Đầu ra: context pack có budget, phần bị lược bỏ và đường dẫn xem thêm; tokenizer hoặc estimator được nhận diện rõ.
- Đạt khi: context nằm trong budget; nội dung thiết yếu vượt budget phải báo rõ, không âm thầm bỏ constraints hay dùng lại context cũ.

### [x] 2.3 — Áp dụng tìm trước, đọc sau và output ngắn

- Làm: hướng dẫn tìm symbol bằng `rg`, đọc đoạn liên quan và dependency trực tiếp; loại file sinh tự động khỏi tìm kiếm mặc định; lọc log nhưng giữ lỗi/stack trace. Kết quả dài lưu artifact để tra cứu.
- Đầu ra: quy tắc đọc và định dạng output công cụ, tận dụng hướng dẫn hiện có.
- Đạt khi: hoàn thành một task mẫu mà không cần nạp toàn repo; lỗi bị cắt vẫn có đường dẫn và cách lấy đầy đủ.

### [x] 2.4 — Tái sử dụng context khi còn hợp lệ

- Làm: gắn nguồn/hash/revision cho brief và kết quả đọc; vô hiệu hóa phần phụ thuộc khi source, request hoặc quyết định thay đổi.
- Đầu ra: chính sách tái sử dụng và invalidation.
- Đạt khi: không đọc lại vô ích ở cùng revision; thay đổi source liên quan buộc xác minh lại trước khi sửa hoặc kết luận.

Điều kiện kết thúc Phase 2: 2.1–2.4 done; context đúng, có giới hạn và truy xuất được chi tiết.

## 6. Phase 3 — Checkpoint, compact và bàn giao

### [x] 3.1 — Hợp nhất checkpoint tối thiểu

- Làm: lưu goal, quyết định, file/symbol đã đổi, kiểm tra thực tế, blocker và next step; liên kết vào task thay vì ghi lại nhiều bản cùng nội dung.
- Đầu ra: thao tác checkpoint có thể cập nhật theo nhóm thay đổi.
- Đạt khi: checkpoint đủ để tiếp tục và phân biệt việc đã làm, dự định làm, kiểm tra chưa chạy.

### [x] 3.2 — Thực hiện compact và resume an toàn

- Làm: checkpoint ở ranh giới giai đoạn hoặc trước compact/clear; xác định cách tương đương cho từng provider thay vì giả định mọi agent hỗ trợ cùng slash command.
- Đầu ra: quy trình và kịch bản tiếp tục bằng session mới.
- Đạt khi: agent mới tiếp tục đúng next step, giữ constraints và xác minh source đã thay đổi mà không phải đọc toàn lịch sử.

### [x] 3.3 — Chuẩn hóa handoff giữa agent

- Làm: handoff gồm task/revision, kết quả, bằng chứng, phần còn lại, lease và bước tiếp; agent nhận xác minh binding và nguồn trước khi sửa.
- Đầu ra: contract handoff và một lượt bàn giao thực tế.
- Đạt khi: không tạo task trùng, không mất blocker, không tuyên bố hoàn thành chỉ vì agent trước kết thúc run.

Điều kiện kết thúc Phase 3: 3.1–3.3 done; resume và handoff bảo toàn trạng thái cần thiết.

## 7. Phase 4 — Kiểm tra, review và xử lý vòng lặp lỗi

### [x] 4.1 — Xây cách chọn kiểm tra theo ảnh hưởng

- Làm: xác định test/build/lint phù hợp với từng scope; chạy kiểm tra liên quan trước, mở rộng khi dependency, lỗi hoặc quy định repo yêu cầu.
- Đầu ra: quy tắc chọn kiểm tra và bản ghi lệnh/kết quả theo revision.
- Đạt khi: thay đổi mẫu được kiểm tra đúng hành vi; không coi exit code agent là bằng chứng chất lượng và không chạy lại suite khi không có lý do mới.

### [x] 4.2 — Thiết lập review và điều kiện done

- Làm: đối chiếu acceptance, diff, kết quả kiểm tra và hạn chế; task đơn giản dùng review phù hợp phạm vi, task phức tạp dùng reviewer độc lập khi cần.
- Đầu ra: verdict pass/rework/blocked cùng lý do và bằng chứng.
- Đạt khi: task có acceptance chưa đạt không thể done; rework giữ liên kết với task và kết quả review cũ.

### [x] 4.3 — Giới hạn vòng lặp không tiến triển

- Làm: định nghĩa trước ngưỡng retry/token/thời gian theo loại task; khi chạm ngưỡng phải checkpoint giả thuyết, bằng chứng và chọn đổi hướng, tăng năng lực hoặc blocked.
- Đầu ra: chính sách retry và lý do kết thúc mỗi attempt.
- Đạt khi: kịch bản lỗi lặp dừng được; không gọi lại cùng thao tác vô hạn và không bỏ acceptance để tiết kiệm token.

Điều kiện kết thúc Phase 4: 4.1–4.3 done; một agent có thể hoàn thành, review và báo blocker có kiểm soát.

## 8. Phase 5 — Chia task và quản lý dependency

### [x] 5.1 — Quy định mức chia task

- Làm: chia theo đầu ra kiểm tra được; mỗi subtask có acceptance, scope và owner; gộp việc quá nhỏ nếu chi phí phối hợp vượt lợi ích.
- Đầu ra: mẫu phân rã và ví dụ task nhỏ/đa module.
- Đạt khi: không có subtask chỉ ghi “tiếp tục xử lý”; tổng acceptance con bao phủ mục tiêu cha và có kiểm tra tích hợp.

### [x] 5.2 — Kiểm soát đồ thị dependency

- Làm: phát hiện chu trình, dependency chưa tồn tại và điều kiện sẵn sàng; task phụ thuộc chỉ chạy khi đầu ra tiền nhiệm được chấp nhận.
- Đầu ra: validation và quy tắc mở khóa task.
- Đạt khi: task không thể chạy trước dependency; tiền nhiệm bị mở lại sẽ chặn hoặc yêu cầu đánh giá lại task phụ thuộc.

Điều kiện kết thúc Phase 5: 5.1–5.2 done; kế hoạch task có thứ tự và đầu ra rõ ràng.

## 9. Phase 6 — Điều phối nhiều agent và chống xung đột

### [x] 6.1 — Kiểm chứng lease và ownership

- Làm: tái sử dụng file lease; acquire trước sửa, kiểm tra ownership khi release; thu hồi lease treo phải có kiểm tra run/session và quy tắc recovery.
- Đầu ra: kiểm tra tranh chấp cùng file, batch thất bại và agent bị ngắt.
- Đạt khi: hai agent không thể sửa cùng vùng được bảo vệ; không release lease của phiên khác hoặc bỏ mất thay đổi chưa lưu khi recovery.

### [x] 6.2 — Bật song song có giới hạn

- Làm: chỉ dispatch task độc lập, scope không xung đột; giới hạn concurrency và ngân sách; task nhỏ mặc định một agent nếu chưa có lợi ích đo được.
- Đầu ra: quy tắc dispatch và thu kết quả riêng từng task/run.
- Đạt khi: dependency và lease vẫn được giữ khi chạy đồng thời; tổng chi phí gồm cả leader, reviewer và handoff.

### [x] 6.3 — Tích hợp kết quả và phục hồi run

- Làm: kiểm tra thay đổi kết hợp, stop/resume và agent thất bại; giữ owner rõ ràng khi bàn giao hoặc chạy lại.
- Đầu ra: một luồng nhiều agent có review và kiểm tra tích hợp.
- Đạt khi: không chấp nhận kết quả lỗi chỉ vì từng subtask PASS; restart không tạo run trùng hoặc hai agent cùng nhận việc.

Điều kiện kết thúc Phase 6: 6.1–6.3 done; song song chỉ hoạt động trên task đủ điều kiện.

## 10. Phase 7 — Model, prompt caching và bộ nhớ dài hạn

### [x] 7.1 — Chọn model theo độ khó

- Làm: phân loại task bằng đặc điểm quan sát được; cấu hình model/capability theo provider; định nghĩa điều kiện chuyển model khi không tiến triển.
- Đầu ra: bảng routing và fallback, có thể ghi đè theo yêu cầu người dùng.
- Đạt khi: model được chọn hoàn thành task mẫu; chi phí tính cả attempt thất bại trước khi chuyển model.

### [x] 7.2 — Tối ưu phần prompt ổn định

- Làm: giữ instructions chung ngắn; tách phần ổn định khỏi task/request thay đổi; kiểm chứng prompt caching theo provider thực dùng.
- Đầu ra: cấu trúc prompt và telemetry cache hit/read/write nếu provider cung cấp.
- Đạt khi: không trộn task để tăng cache; không suy cache hit từ marker hoặc coi cached token là không tốn phí. Provider không hỗ trợ được ghi rõ.

### [x] 7.3 — Quản lý bộ nhớ có nguồn và thời hạn hiệu lực

- Làm: chỉ lưu kiến thức có thể tái sử dụng, kèm scope, nguồn, revision và điều kiện invalidation; xử lý trùng/mâu thuẫn và loại thông tin nhạy cảm trước khi lưu.
- Đầu ra: quy tắc ghi, truy xuất, cập nhật và loại bỏ memory lỗi thời.
- Đạt khi: task không nạp memory không liên quan; quyết định cũ không lấn át yêu cầu hiện tại; xóa/sửa memory không làm mất lịch sử task bắt buộc.

Điều kiện kết thúc Phase 7: 7.1–7.3 done; lợi ích model/cache/memory có thể đo và kiểm soát.

## 11. Phase 8 — Đo hiệu quả và kiểm chứng tổng thể

### [x] 8.1 — Hoàn thiện telemetry xuyên suốt task

- Làm: gắn usage vào task/session/run/attempt/model/revision; tách input chưa cache, cached input, cache write, output và reasoning theo semantics của provider, tránh cộng trùng.
- Đầu ra: báo cáo token tiêu hao (input chưa cache, cached input, cache write, output, reasoning và tổng không cộng trùng), thời gian, tool calls, retry, rework và tỷ lệ hoàn thành. Tạm hoãn chi phí tiền và pricing.
- Đạt khi: đối chiếu được với raw usage; thiếu usage hiển thị thiếu dữ liệu, không suy ra mức tiết kiệm token chính xác. Không yêu cầu pricing để nghiệm thu.

### [ ] 8.2 — Chạy so sánh theo protocol Phase 0

- Native retry 14/11/2026 sau mở quyền: đã PASS native AppContainer không inference. Identity evaluator cũ còn1415historical grants nên giữ nguyên và không dùng; probe chuyển sang native identity pair có provenance, audit1052248entries/0matches/0failures. Sandbox ghi workspace journal, bị từ chối đọc/ghi host journal; stop0writers/processes, interrupted journal readback giữ partial/null đúng contract, profile storage/cleanup/revoke và post-revoke scope PASS. Pipeline offline50/50 và source hashes được kiểm lại. Đã chốt [source manifest sẵn sàng freeze tương lai](docs/phase8-telemetry-native-ready-20261114/source-manifest.json), readyForFutureFreeze=true. Không tạo operational freeze, không model call hoặc đo lại; cohort cũ giữ measurementComplete=false/releasePassed=false.
- Kiểm tra readiness 14/11/2026: runner/auditor/reporter telemetry revision riêng đã đối chiếu journal với raw/events, snapshot/head hash, binding và timing; reporter tự kiểm lại sau audit/review.50/50 offline tests PASS,0skip, không inference. Probe native bị chặn tại scope enumeration với EPERM ở .bridge-runtime lịch sử; readonly Get-Acl cũng bị từ chối. Dừng trước AppContainer launch/grant; supervisor requests0, cache probe đã dọn, không đổi ACL lịch sử. [Báo cáo và source manifest](docs/phase8-telemetry-readiness-20261114/report.md) giữ readyForFutureFreeze=false vì chưa có native proof. Cohort đã chốt và hai cờ nghiệm thu không đổi; không đo lại.
- Gia cố telemetry offline 14/11/2026: thêm compare-run-next.mjs và invocation-telemetry.mjs cho revision tương lai. Usage/callback và checkpoint timing được append+fsync, gắn protocol/attempt/run/thread/turn, phân biệt observedUsage với confirmed final usage; checkpoint còn lại sau crash không được dùng làm duration đầy đủ. Runner freeze đúng runner/auditor mới và telemetry helper, kiểm contract/hash trước chạy.58/58 tests PASS,0skip, gồm process-kill thật, timeout/disconnect, lỗi ghi mô phỏng, binding/chain tampering và freeze guards. [Báo cáo và source manifest](docs/phase8-telemetry-hardening-20261114/report.md). Giữ nguyên cohort/source hashes đã chốt; không provider call, operational freeze hoặc lịch đo mới; measurementComplete/releasePassed của cohort cũ không đổi.
- Bảo trì offline 14/11/2026: đã xử lý nguyên nhân chung của13lỗi integration trong auditor revision mới compare-audit-next.mjs. Guard chỉ kiểm scoped compaction attempt3 khi predecessor thực sự tồn tại; tránh undefined===undefined. Suite compare-validation14/14 và related21/21 PASS,0skip; giữ nguyên tất cả assertion. Auditor cũ và source hashes của cohort đã chốt không đổi; revision mới chưa kích hoạt cho cohort cũ hoặc benchmark mới. [Báo cáo, TAP và source archives](docs/phase8-integration-audit-revision-20261114/report.md). Không model call; không đổi measurementComplete/releasePassed; telemetry hardening chưa thuộc thay đổi này.
- Cập nhật 27/10/2026: G4 diagnostic latest 8/8 và full audit/finalized review PASS; hash assessment cùng 9 evidence references khớp. G5 operational GPT-6 Web High đã PASS 44/44 loopback/native startup, independent B/S build/native, fresh provider/shell preflight, freeze protocol, thu hồi temporary RX và final ACL audit 821.969 entries/0 matches/0 failures. Frozen [checkpoint/round riêng](docs/phase8-2-remediation-20261019/cohorts/gpt6-web-high/g5-operational-20261027-e8332c46/checkpoint.json) bắt đầu smoke; B-0-small-1 và B-0-handoff-1 đều PASS mechanical audit và host content review, mỗi lượt 2/2 acceptance và 22/22 raw commands thành công; smoke 4/6 reviewed, formal 0/50, actual operational provider invocations 4. Lượt B-0-handoff-2 và S-0-small-1 cũng đã PASS mechanical audit, host review và acceptance 2/2; ghi nhận một git command lỗi (signed ledger) được xử lý bằng SHA-256. Tiếp tục smoke kế tiếp theo frozen schedule và review từng attempt; không chuyển slot diagnostic sang operational, không đánh dấu 8.2 done. [Báo cáo G4](docs/phase8-2-g4-diagnostic-completion-20261027.md). Các bullet có ngày cũ bên dưới là lịch sử.
- Thử lại sau mở quyền ngày 22/10: diagnostic runner/sáu identities/freeze và prerequisites đã đạt. Round d2179a16… dừng infrastructure_failed sau B-small attempt 1 vì một tool call thiếu Set-Location; self-verifier/canonical ledger/checkpoint cũng chưa đạt. Một invocation actual Luna/medium, 563.479 input+output, zero latest reviewed PASS, không S/handoff/rework. Official acceptance null, supplemental fresh native acceptance 2/2; stop/session/lease/cleanup và final frozen/historical integrity PASS. Giữ terminal, không retry; G4 BLOCKED và chưa mở G5–G7. [Report/checkpoint retry](docs/phase8-2-remediation-20261019/diagnostics/g4-retry-20261022-0abbf0b9/report.md).
- Tiếp tục handoff ngày 22/10: revalidation và offline PASS; ma trận G4 dự thảo tối đa 8 logical slots/16 invocations/6 workspaces, chưa freeze/launch. Registry B/S và system process inventory bị access denied; runtime B/S có 1.153/1.225 read failures nên chưa thể xác nhận hash hiện tại. G3 historical proof giữ nguyên, không xem read failure là source drift. Cần môi trường đọc được prerequisites, diagnostic runner schedule riêng, independent build/provenance, identities và fresh preflights trước inference. [Báo cáo G4 resume](docs/phase8-2-remediation-20261019/diagnostics/g4-resume-20261022-41ad4a8b/report.md).
- G3 ngày 22/10 — pair sạch và proof mới đạt: B/S dùng hai existing profiles/SIDs khác identity lỗi, scope 140.379/142.050 entries, zero grants/read failures trước launch. Native source cuối 7/7 PASS/0 SKIP, có actual checkpoint/handoff CLI dưới runtime read-only, signed observation/key/parent boundary, fresh session, raw readback, zero writers/sessions/leases, storage và cleanup/revoke receipts. Runtime 1.153/1.225 files và 3.603 historical hashes khớp. Chưa model call; G4 diagnostics/operational freeze và 6 smoke/50 formal vẫn thiếu, measurementComplete=false/releasePassed=false. [Báo cáo G3 pair mới](docs/phase8-2-remediation-20261019/reports/g3-clean-identities-20261022-09758004.md).
- Retry G3 tiếp ngày 22/10: scope audit đọc 135.683 entries, zero read failures nhưng phát hiện 1.339 matching grants còn ở workspace của lượt timeout trước; identity chưa sạch. Probe dừng trước native launch, 6 PASS/1 FAIL/0 SKIP, source unchanged, outer scratch cleanup đạt. Chưa model call; cần lifecycle/revoke recovery hoặc identity sạch với proof mới thay vì retry nguyên trạng. [Báo cáo retry lần hai](docs/phase8-2-remediation-20261019/reports/g3-retry2-20261022-620bcd9b.md).
- Thử lại G3 ngày 22/10 sau mở quyền môi trường: đọc ACL/registry đã hoạt động; scope audit 134.109 entries, zero failures/matches; registry discovery integration PASS. Native probe mới tới B CLI task-start rồi watchdog ETIMEDOUT, thiếu command/native stop receipts; S chưa chạy. Quan sát OS sau timeout không còn matching process nhưng không thay stop proof. Giữ scratch/logs; G3 vẫn chưa đạt vì timeout/lifecycle, không còn blocker đọc ACL/registry trước đó. [Báo cáo retry](docs/phase8-2-remediation-20261019/reports/g3-retry-20261022-0cae7de0.md).
- Cập nhật 22/10/2026: thực thi completion plan đã có resume inventory, kiểm 3.603 historical/frozen hashes khớp và sửa provider observation coverage/ancestry/ledger/canonical binding. Source cuối đạt 41/41 focused tests, controls 10/10, CLI B/S 6 cases/56 receipts và cleanup chính đạt. Regression rộng còn 2 lỗi native/registry; native proof mới bị scope audit chặn bởi 21 ACL unreadable, chưa native launch hoặc model call mới. G3 chưa đạt, G4–G7 chưa mở; measurementComplete=false, releasePassed=false. [Báo cáo/checkpoint 22/10](docs/phase8-2-remediation-20261019/reports/completion-20261022-d24faf46.md).
- Cập nhật 21/10/2026: native B/S literal-script/readback 7/7 và runner/cleanup 21/21 PASS. Diagnostic revision 4 B-small đạt acceptance 2/2, source roles/checkpoint/publish/agent verifier nhưng host review BLOCKED vì lỗi provider launch os267 thiếu trong ledger; scheduler quality_failed, không mở successor. Cần bổ sung authenticated provider observation cho failure trước khi tạo process, giữ nguyên frozen evidence và quality gates. Chưa đủ diagnostics, 6 smoke/50 formal và metrics nên checkbox giữ chưa hoàn tất. Bằng chứng và bước tiếp: [báo cáo Luna remediation](docs/phase8-2-remediation-20261019/reports/luna-scope-remediation-20261020.md).
- Làm: chạy cùng tập task và acceptance, kiểm soát snapshot/model/effort, đảo thứ tự theo protocol; so baseline với một agent tối ưu và nhiều agent khi phù hợp.
- Đầu ra: dữ liệu thô và báo cáo so sánh, tách lỗi hạ tầng; công bố cả retry-inclusive và phần implementation.
- Đạt khi: đủ lượt và chất lượng theo protocol; báo độ phân tán và trường hợp xấu đi, không kết luận từ một lần chạy hoặc chỉ từ kích thước context.

### [ ] 8.3 — Đóng các điểm chưa đạt

- Cập nhật 14/11/2026: đã thực hiện phần sửa lỗi/kiểm chứng có thể làm mà không đo lại. [Báo cáo và ledger 8.3](docs/phase8-3-remediation-20261114/report.md) ghi nhận 6 hạng mục đã đóng theo phạm vi revision/lệnh kiểm chứng; 26/26 tests trên đúng 7 file hiện hành PASS, không tái hiện thêm lỗi sản phẩm trong các ca đã chọn. Source manifest đã sẵn sàng freeze tương lai và các hash của cohort đã chốt không đổi. Không model call, rebuild, freeze hoặc benchmark mới.
- [x] Ghi nhận đã đóng lỗi guard compaction, độ bền/finality của usage, checkpoint timing, đối chiếu journal ở auditor/reporter và native boundary/stop/readback/cleanup, kèm evidence references.
- [x] Kiểm chứng resume/checkpoint, ownership/session/lease, stale-state CAS, concurrency/crash boundaries và artifact retention; sửa lệnh discovery để không kéo source snapshots lịch sử.
- [ ] Nghiệm thu hiệu quả: dữ liệu benchmark G7 đã bị loại khỏi căn cứ nghiệm thu.
- Scratch của lượt regression được giữ lại vì kiểm duyệt tự động từ chối recursive cleanup với lý do blocked by policy; logs và kết quả scoped PASS đã lưu riêng.
- Làm: sửa các lỗi task/session, mất trạng thái, xung đột hoặc chất lượng trước; sau đó tối ưu overhead đo được. Mỗi thay đổi mở lại bước liên quan và kiểm tra phần bị ảnh hưởng.
- Đầu ra: danh sách vấn đề đã đóng và kết quả kiểm chứng cuối.
- Đạt khi: đạt ngưỡng đã chốt; nếu không đạt, giữ bước blocked/rework và chưa mở Phase 9.

Điều kiện kết thúc Phase 8: 8.1–8.3 done; có bằng chứng hiệu quả và chất lượng theo tiêu chí ban đầu.

## 12. Phase 9 — Đưa vào sử dụng và duy trì

### [ ] 9.1 — Hoàn thiện hướng dẫn vận hành tối thiểu

- Làm: ghi cách tạo/nhận task, checkpoint, bàn giao, review, unblock và recovery; cập nhật CLI/dashboard theo chức năng đã kiểm chứng, giữ hướng dẫn chung ngắn.
- Đầu ra: runbook kèm ví dụ một agent và nhiều agent; không giới thiệu flag chưa triển khai.
- Đạt khi: agent mới theo hướng dẫn hoàn thành một task mẫu mà không cần toàn bộ hội thoại triển khai.

### [ ] 9.2 — Pilot và chuẩn bị rollback

- Làm: áp dụng trên tập task giới hạn; chuẩn bị backup/migration và khôi phục cấu hình/dữ liệu theo thay đổi thực tế; kiểm tra rollback trước khi mở rộng.
- Đầu ra: báo cáo pilot, artifact recovery và quyết định mở rộng theo tiêu chí Phase 0.
- Đạt khi: pilot giữ chất lượng và tính toàn vẹn trạng thái; rollback không mất task/checkpoint đã cam kết lưu.

### [ ] 9.3 — Thiết lập theo dõi định kỳ

- Làm: theo dõi token/task hoàn thành đúng, median và p95 token/thời gian, tỷ lệ rework/blocked và lỗi resume; quy định lịch rà soát, owner và ngưỡng cảnh báo từ baseline. Chi phí tiền tạm hoãn theo phạm vi hiện tại.
- Đầu ra: lịch vận hành và cách điều chỉnh routing/budget/concurrency khi số liệu xấu đi.
- Đạt khi: có người chịu trách nhiệm và quy trình xử lý; đóng plan khi toàn bộ bước đạt và bằng chứng được liên kết đầy đủ.

Điều kiện kết thúc Phase 9: 9.1–9.3 done; hệ thống có hướng dẫn, recovery và người duy trì.

## 13. Nhật ký thực hiện

Ngày: 27/10/2026 — tối ưu storage và dọn repo theo chỉ đạo người dùng
Bước: 8.2 / G5 — giảm evidence trùng và thu hồi dung lượng
Trạng thái: storage optimization done; xóa scratch blocked bởi automatic approval review; G5 chưa PASS
Người/agent phụ trách: Codex
Đầu ra: docs/phase8-2-storage-optimization-20261027.md; cohorts/gpt6-web-high/g5-storage-20261027/checkpoint.json; scripts/phase8-clean-test-scratch.ps1 (dry-run, chưa Apply).
Kiểm tra: input thật 807.629 entries, cặp JSON/JSONL 430.596.818 bytes → một gzip 5.183.516 bytes (-98,80%); round-trip hash PASS. Focused suite 39/39, scope-list tests 2/2, syntax 3/3 PASS. NTFS compression 36 files, SHA-256 trước/sau khớp, thu hồi 1.089.705.212 allocated bytes; hai pnpm hardlinks giữ nguyên. G4 references 9/9 và frozen inventory 2.442/2.442 hashes khớp.
Quyết định hoặc blocker: D còn 20,975 GiB; forecast mới 4,43 GiB/56 attempts hoặc 4,89 GiB/112 attempts, capacity planning PASS, thay dự toán logic cũ. Automatic approval review chặn cả bulk test-fixture delete và single temporary-file delete (blocked by policy); không xóa file hoặc dùng workaround. Cleanup dry-run xác định 40 targets/489 files/17.608.765 logical bytes, script có root/reparse/process guards để người dùng chạy. Raw/frozen/history/continuation giữ nguyên.
Bước tiếp theo: bổ sung/readback loopback đúng 44-SID pool bằng Administrator, fresh source/native/build/scope/preflight/startup và freeze operational riêng. Không inference mới, measurementComplete=false/releasePassed=false; G6/G7 chưa mở.


Ngày: 27/10/2026 — tiếp tục từ báo cáo hoàn tất G4
Bước: 8.2 / G5 — operational prerequisites cho GPT-6 Web High
Trạng thái: blocked trước operational freeze; G4 diagnostic đã đạt, G6/G7 chưa mở
Người/agent phụ trách: Codex
Đầu ra: docs/phase8-2-g5-preparation-20261027.md; docs/phase8-2-remediation-20261019/cohorts/gpt6-web-high/g5-preparation-20261027/{checkpoint,capacity,checks}.json; pool offline/identity-pool-ee194cae-8f14-42fa-9d74-f80f51f13492/identity-pool.json. Sửa scoped script loopback để kiểm đúng lịch 6 hoặc 44 identities, toàn bộ registry mapping và ValidateOnly trước mutation.
Kiểm tra: assessment G4 và 9 evidence hashes khớp; registration exit 0, 44 identities, audit 809.881 entries/zero failures/zero grants trên selected SIDs, cleanup PASS. Bốn negative tests PASS; native ValidateOnly 44/6 identities PASS, zero mutations. Loopback readback exit 0, chỉ 3/44 covered, thiếu 41 SID; shell không Administrator. D còn 19,96 GiB; dự toán theo latest evidence 26,62 GiB cho 56 attempts hoặc 49,26 GiB cho 112 attempts, có giả định/dự phòng, không phải số đo campaign tương lai.
Quyết định hoặc blocker: cần Administrator để thêm exemptions đúng pool và giải quyết capacity trước freeze. Không xóa evidence hoặc sửa diagnostic verdict. Không provider/model invocation mới, operational smoke 0/6, formal 0/50; measurementComplete=false, releasePassed=false.
Bước tiếp theo: thực hiện lệnh Administrator trong báo cáo G5 và chốt xử lý dung lượng; sau đó fresh scope/build/preflight/native startup 44 workspaces và operational freeze riêng, rồi mới 6 smoke reviewed slots. Không mở formal từ diagnostic.

Ngày: 22/10/2026 — thử lại sau khi môi trường mở quyền
Bước: 8.2 / G4 — diagnostic schedule riêng, prerequisites, freeze và first model attempt
Trạng thái: blocked / terminal infrastructure_failed
Người/agent phụ trách: Codex
Đầu ra: docs/phase8-2-remediation-20261019/diagnostics/g4-retry-20261022-0abbf0b9/{report.md,checkpoint.json,terminal-assessment.json,accounting.json,requirements.json,final-integrity.json}; pointer round.json, round d2179a16-3666-4445-bbb1-a50ddb8717c1, fingerprint ccf3f5a9bc506bf2170110b090ceb68dcee9860ee3b70e80b73d897c84ed80e6. Source thêm diagnostic-plan module/tests và lịch riêng, formal guards, registrar sáu identities, source pin native/helper.
Kiểm tra: access/runtime/historical retry PASS; focused 45/45/0 SKIP, controls 10/10, CLI 6 cases/56 commands, syntax 8 modules, B/S build/provenance, fresh Luna/shell preflight và native source mới 7/7/0 SKIP PASS. Pool sáu identities audit 116.070 entries/294 contained links, zero selected grants/read failures PASS. Sau path-safety guard trong test, năm diagnostic tests rechecked PASS. Giữ failed-before/relative-path/host-LOCALAPPDATA receipts và context reproduction; không thay verdict cũ.
Kết quả model: chỉ B-small attempt 1, actual gpt-6-luna/medium, turn completed. Agent bỏ Set-Location ở exec-c0dff298…; runner infrastructure_failed trước official acceptance, partial audit không PASS vì zero finished slots. Self-verifier FAIL Source claims artifact missing; canonical thiếu claims/errors, raw failure references sai/thiếu và không task checkpoint. Host supplemental assessment BLOCKED; không inject review/rework vào unfinished row. Fresh frozen acceptance bổ sung cùng workspace/identity 2/2 PASS, không sửa source/RESULT/CURRENT hay original state.
Accounting/integrity: input553767/cached502784/uncached50983/output9712, tổng563479; reasoning847 subset output, cost/thresholds null. Native zero writers, sessions0/leases0, cleanup PASS. Final2439 frozen/19 harness/16 native-source/3603 historical/47 prior G3/raw protocol hashes khớp. Zero owned live handles; latest reviewed PASS0/8 diagnostic, operational smoke/formal mới0, measurementComplete=false/releasePassed=false.
Bước tiếp theo: giữ round terminal và mọi failure; chẩn đoán offline bootstrap compliance và quy trình author/publish source claims/error ledger/checkpoint. Revision mới chỉ sau correction có evidence và affected offline/native checks; không retry/successor hoặc tự rollover. G5–G7/8.3/9 chưa mở.

Ngày: 22/10/2026 — tiếp tục từ docs/phase8-2-handoff-20261022.md
Bước: 8.2 / G4 — revalidate và lập diagnostic matrix
Trạng thái: blocked trước diagnostic freeze/launch
Người/agent phụ trách: Codex
Đầu ra: docs/phase8-2-remediation-20261019/diagnostics/g4-resume-20261022-41ad4a8b/{execution,resume-inventory,diagnostic-plan,checkpoint,evidence-index}.json và report.md; offline/2026-10-22T04-11-49-397Z-fb3152cf-421d-4377-95cf-0c87ac256d26/result.json.
Kiểm tra: 47 indexed G3 artifacts, 15 G3 source hashes và Node khớp; 3.603 historical hashes không đổi đầu/cuối. Offline 41/41 PASS/0 SKIP, controls 10/10, CLI B/S 6 cases/56 commands PASS; cleanup exit 0, source unchanged. D: còn khoảng 40,86 GiB. Hai thay đổi so G2 là probe changes đã được G3 pin; không có drift mới trên 15 source hashes G3.
Quyết định hoặc blocker: runtime B/S 1.153/1.225 EPERM read failures, registry mappings bị denied, Win32_Process inventory bị denied. Không đủ current runtime/process proof để freeze hoặc launch; giữ G3 historical PASS và chưa chứng nhận native trong lượt này. Diagnostic matrix dự thảo tối đa 8 slots/16 invocations/6 workspaces; runner hiện dùng fixed operational schedule, chưa có diagnostic schedule riêng. Không model call, không sửa source/historical evidence; measurementComplete=false/releasePassed=false.
Bước tiếp theo: khôi phục khả năng đọc prerequisites và kiểm process trong môi trường thực thi; revalidate trước diagnostic runner/build/identity/preflight/freeze. G5–G7 chưa mở, không chuyển 8.3/9.

### 0.1 — Checkpoint 16/10/2026

Bước: 0.1  
Trạng thái: done  
Người/agent phụ trách: Codex  
Đầu ra: [Bản đồ hiện trạng](docs/phase0-20261016/current-state.md), [report và raw logs](docs/phase0-20261016/observations/report.json), [snapshot source có SHA-256](docs/phase0-20261016/observations/snapshot.json).  
Kiểm tra: `node scripts/phase0-preflight.mjs`; v2 73/73 tests PASS (cwd `next`, không skip), fixture bốn stage PASS; CLI legacy FAIL `MODULE_NOT_FOUND`, giữ nguyên stack trace.  
Quyết định hoặc blocker: tách legacy được README mô tả và v2 đã có source; không nhận định dashboard/lease/orchestration legacy đã hoạt động. Không sửa runtime.  
Bước tiếp theo: 0.2 — Chốt protocol đo và tiêu chí chất lượng.

### 0.2 — Checkpoint 16/10/2026

Bước: 0.2  
Trạng thái: done  
Người/agent phụ trách: Codex  
Đầu ra: [Protocol revision 1](benchmarks/task-management/PROTOCOL.md), fixtures/controls cùng thư mục, [snapshot protocol và kết quả controls](docs/phase0-20261016/protocol-verification/report.json).  
Kiểm tra: `node benchmarks/task-management/verify.mjs` PASS đủ 10 controls: năm positive đạt đủ tests, năm negative bị từ chối đúng; không gọi model. Protocol hash `7df556ebc10e1cdda920c9246755adbd17d1f60c98756df6be0fa1a7adbb403b`.  
Quyết định hoặc blocker: cố định bốn loại task, năm repetition/nhánh, model/effort, acceptance/review, retry limits, raw usage semantics và ngưỡng token/time mới; chi phí tiền null khi chưa có pricing. Baseline là CLI legacy đang được wrapper cấu hình, không thay bằng v2 fixture. Handoff sequential báo riêng; release cần round xen kẽ mới để kiểm soát drift.  
Bước tiếp theo: 0.3 — Thu baseline trước thay đổi; kiểm tra gate runtime trước model invocation.

### 0.3 — Checkpoint 16/10/2026

Bước: 0.3  
Trạng thái: blocked  
Người/agent phụ trách: Codex  
Đầu ra: [Baseline manifest và 25 slot chưa chạy](docs/phase0-20261016/baseline.json), [runtime preflight](docs/phase0-20261016/observations/report.json), [stack trace đầy đủ](docs/phase0-20261016/observations/legacy-cli.stderr.log).  
Kiểm tra: CLI mà wrapper đang cấu hình không chạy được (`MODULE_NOT_FOUND` cho `packages/cli/dist/index.js`); source/manifests legacy cũng thiếu. V2 contracts và evaluator controls đã PASS nhưng không thay thế provider baseline. Có archive legacy ngày 13/10 và ZIP source ngày 10–11/10; chưa xác minh tương đương phiên bản hiện hành, không tự phục hồi/đổi baseline.  
Kiểm tra artifact cuối: đối chiếu SHA-256 đủ 55 file source snapshot, 28 file protocol snapshot và raw observation logs PASS; 25 baseline slot có ID duy nhất, đều chưa chạy/usage null; các link trong plan tồn tại; `node --check` PASS cho hai script mới.  
Quyết định hoặc blocker: chưa launch model; provider usage, baseline time/tool calls/rework và chi phí đều null. Không đánh dấu 0.3 done và không mở Phase 1.  
Bước tiếp theo: khôi phục/xác minh đúng runtime legacy được cấu hình cùng dependencies và provenance; mở lại kiểm chứng snapshot 0.1/0.2 bị ảnh hưởng, freeze revision mới, qua preflight/smoke rồi thu đủ 25 lượt B theo protocol. Nếu muốn đổi runtime mục tiêu, cần chốt lại protocol trước khi đo; không sửa ngầm dataset này.

### 0.1 — Mở lại để phục hồi baseline 16/10/2026

Bước: 0.1  
Trạng thái: in_progress  
Người/agent phụ trách: Codex  
Đầu ra: kiểm kê legacy freeze `8f9ee3f72712a23d0e0c8305ec0c2b847700e59fc684995fbeeb9a69b712937e`.  
Kiểm tra: manifest hash hợp lệ, 1095/1095 blobs đúng SHA-256, không missing/corrupt; toàn bộ file legacy còn lại khớp archive, không drifting survivor. Root/CLI/core/memory/adapters cùng version 0.1.1.  
Quyết định hoặc blocker: yêu cầu tiếp tục 0.3 bao gồm phục hồi phần thiếu từ bản lưu khớp các survivors; chỉ restore file packages còn thiếu, không ghi đè source hiện có hoặc state. Tạm giữ 0.3 chờ kiểm chứng runtime/dependencies và đóng lại 0.1–0.2.  
Bước tiếp theo: phục hồi và chạy probe CLI, kiểm chứng task/context/session/handoff/lease legacy; freeze dependency/runtime trước phép đo.

### 0.1 — Kiểm chứng lại hoàn tất 16/10/2026

Bước: 0.1  
Trạng thái: done  
Người/agent phụ trách: Codex  
Đầu ra: [Recovery manifest](docs/phase0-20261016/recovery.json), [bản đồ legacy đã cập nhật](docs/phase0-20261016/current-state.md).  
Kiểm tra: CLI version/help PASS; 182 legacy tests PASS (memory 1, core 76, CLI 105); CLI chạy forks đơn worker sau khi runner threads crash, giữ cả log lỗi và log exit 0. Dependencies đúng lockfile khôi phục từ cache; native SQLite đã cài binary theo package script. Provider preflight không inference PASS.  
Quyết định hoặc blocker: tái sử dụng restored legacy 0.1.1, provenance archive khớp survivor; không sửa behavior runtime, không mở Phase 1.  
Bước tiếp theo: mở lại 0.2, freeze protocol revision 2 với source/dependencies phục hồi và runner mới.

### 0.2 — Cập nhật fingerprint sau phục hồi 16/10/2026

Bước: 0.2  
Trạng thái: in_progress  
Người/agent phụ trách: Codex  
Đầu ra: protocol revision 2 và native baseline runner đang chuẩn bị.  
Kiểm tra: runtime/provider đã qua prerequisite không model; fixtures và acceptance giữ nguyên.  
Quyết định hoặc blocker: giữ nguyên revision 1 và raw evidence cũ; bổ sung rõ manual lifecycle, provenance phục hồi và instrumentation trước smoke.  
Bước tiếp theo: verifier controls/fingerprint mới, đóng 0.2 rồi chạy smoke B và formal B cho 0.3.

### 0.2 — Protocol revision 2 đã freeze 16/10/2026

Bước: 0.2  
Trạng thái: done  
Người/agent phụ trách: Codex  
Đầu ra: [Protocol revision 2](benchmarks/task-management/PROTOCOL.md), [10 controls đã kiểm chứng](docs/phase0-20261016/protocol-verification-v2/report.json), [round pointer](docs/phase0-20261016/round.json).  
Kiểm tra: verifier 10/10 controls PASS, node syntax check PASS; prepare đóng gói 43 production packages, freeze runtime/provider/Node/harness/fixtures. Controls hash `3ff493f0f9ae54cfd3c1f5085f1a22cdaf256389bbf5254593af199d679b1a5e`; round hash `816beab2939d1990ec2755c69a5d02c4fd32831af39f9cc88157b7bc44f7716e`.  
Quyết định hoặc blocker: giữ nguyên yêu cầu nghiệp vụ/acceptance/ngưỡng; bổ sung provenance recovery, manual lifecycle và harness native không đưa state/tools v2 vào model. Lưu evidence cũ nguyên vẹn.  
Bước tiếp theo: 0.3 — smoke B gồm small và handoff hai phiên, review thực tế trước formal.

### 0.3 — Thu baseline thật 16/10/2026

Bước: 0.3  
Trạng thái: in_progress  
Người/agent phụ trách: Codex  
Đầu ra: round được liên kết trong [round.json](docs/phase0-20261016/round.json); state, intent, source snapshot và raw logs ghi theo invocation.  
Kiểm tra: legacy/provider/evaluator prerequisites đã đạt; chưa công nhận kết quả smoke hoặc formal trước khi chạy và review.  
Quyết định hoặc blocker: chạy tuần tự smoke B rồi formal B, không mở candidate S hoặc Phase 1.  
Bước tiếp theo: `node benchmarks/task-management/run.mjs smoke`.

### 0.3 — Smoke hạ tầng bị dừng 16/10/2026

Bước: 0.3  
Trạng thái: blocked  
Người/agent phụ trách: Codex  
Đầu ra: [Interrupted smoke và partial usage](docs/phase0-20261016/interrupted-smoke.json), [native probe](docs/phase0-20261016/native-probe.json), [compatibility probe](docs/phase0-20261016/native-probe-compat.json).  
Kiểm tra: một invocation thật; task start và test runner bị treo ở Node piped child process. Host dừng đúng run, native stop xác nhận zero writers; CLI session đã đóng, source unchanged. Probe không model: mặc định timeout 124; file-backed stdio chạy child và task start exit 0; test isolation none phát hiện seed lỗi đúng.  
Quyết định hoặc blocker: không replay hoặc sửa ledger; giữ toàn bộ 665898 input / 610176 cached / 3211 output tokens trong experiment accounting. Sửa reader binding canonical runtime.db và RPC budget interrupt trong harness; không đổi source sản phẩm. Mở lại 0.2 trước vòng mới.  
Bước tiếp theo: 0.2 revision 3 — verifier controls và compatibility regression, freeze round mới.

### 0.2 — Native compatibility revision 3 16/10/2026

Bước: 0.2  
Trạng thái: in_progress  
Người/agent phụ trách: Codex  
Đầu ra: protocol revision 3 và harness native-stdio.  
Kiểm tra: native compatibility probe chạy task start exit 0; đang kiểm tra bảo toàn stdout/stderr/Unicode/exit và timeout.  
Quyết định hoặc blocker: giữ acceptance/ngưỡng chất lượng; hiệu chỉnh execution ceilings từ pilot trước formal, ghi rõ giới hạn và không tự nâng tiếp.  
Bước tiếp theo: freeze mới khi toàn bộ kiểm tra model-free đạt.

### 0.2 — Revision 3 đã kiểm chứng 16/10/2026

Bước: 0.2  
Trạng thái: done  
Người/agent phụ trách: Codex  
Đầu ra: [Controls revision 3](docs/phase0-20261016/protocol-verification-v3/report.json), [stdio regressions](docs/phase0-20261016/native-stdio-tests.log), [round mới](docs/phase0-20261016/round.json).  
Kiểm tra: 10/10 positive/negative controls đạt, 4/4 stdio regressions PASS, native child và task start exit 0, syntax PASS; đóng gói/freeze lại 43 production packages. Round hash `fda2975b14e60f35643dab0d64153cfe0b170f823d3de597948a864928723ff6`.  
Quyết định hoặc blocker: runtime CLI nguyên byte không đổi; compatibility chỉ ở harness. Round cũ giữ nguyên, partial usage không nhập formal.  
Bước tiếp theo: 0.3 smoke mới, host review trước formal.

### 0.3 — Round revision 3 16/10/2026

Bước: 0.3  
Trạng thái: in_progress  
Người/agent phụ trách: Codex  
Đầu ra: [round pointer](docs/phase0-20261016/round.json), state/evidence theo lượt trong round mới.  
Kiểm tra: mọi prerequisite model-free đã đạt; chưa công nhận smoke/formal khi chưa có kết quả và review.  
Quyết định hoặc blocker: không replay round cũ; chỉ đo B, giữ 25 formal slot chưa chạy.  
Bước tiếp theo: `node benchmarks/task-management/run.mjs smoke` rồi review thực tế.

### 0.3 — Native receipt đến muộn 16/10/2026

Bước: 0.3  
Trạng thái: blocked  
Người/agent phụ trách: Codex  
Đầu ra: [Late receipt reconciliation](docs/phase0-20261016/interrupted-smoke-v3.json), [model-free lifecycle probe](docs/phase0-20261016/native-probe-missing.json).  
Kiểm tra: small source đã sửa đúng và agent quan sát 2/2 tests PASS; không có completed turn. Native receipt đến sau deadline, đối chiếu lại request/path/run xác nhận timeout124, zero writers; session đã đóng, hai lease được host release. Partial usage 73338 input / 56576 cached / 1312 output. Probe riêng task start→lease→checkpoint exit 0; không đủ bằng chứng kết luận lỗi checkpoint hoặc sleep/reboot.  
Quyết định hoặc blocker: giữ nguyên lượt cũ không replay, không coi task/test PASS là smoke PASS khi thiếu turn/receipt đúng thời điểm.  
Bước tiếp theo: 0.2 kiểm chứng grace receipt 15 giây rồi freeze revision 4, giữ nguyên budget/acceptance.

### 0.2 — Receipt grace revision 4 16/10/2026

Bước: 0.2  
Trạng thái: in_progress  
Người/agent phụ trách: Codex  
Đầu ra: native receipt reader có binding và grace 15 giây.  
Kiểm tra: native lifecycle probe PASS, đang verifier/syntax và freeze mới.  
Quyết định hoặc blocker: không thay source legacy, business tasks, quality gates hoặc execution budget.  
Bước tiếp theo: đóng 0.2 khi controls/freeze đạt; tiếp tục 0.3 bằng round mới, không formal khi smoke chưa review PASS.

### 0.2 — Revision 4 đã freeze 16/10/2026

Bước: 0.2  
Trạng thái: done  
Người/agent phụ trách: Codex  
Đầu ra: [controls revision 4](docs/phase0-20261016/protocol-verification-v4/report.json), [round pointer](docs/phase0-20261016/round.json).  
Kiểm tra: 10/10 controls đạt, syntax PASS, native lifecycle probe PASS; freeze 43 production packages, hash `ac0800bba1729167d55845d6c740a07f16d041c6020cdeb098579a1b6d0aa9b2`.  
Quyết định hoặc blocker: không đổi budget/acceptance, không replay lượt trước.  
Bước tiếp theo: 0.3 smoke round mới.

### 0.3 — Smoke revision 4 16/10/2026

Bước: 0.3  
Trạng thái: in_progress  
Người/agent phụ trách: Codex  
Đầu ra: round `c229f2c2-3df6-48e5-9d51-89325f57b924`, theo [pointer](docs/phase0-20261016/round.json).  
Kiểm tra: chỉ prerequisites model-free đã đạt; cần actual smoke và review trước formal.  
Quyết định hoặc blocker: giữ raw evidence và partial usage hai round trước riêng khỏi formal.  
Bước tiếp theo: chạy smoke và theo dõi từng lượt, không mở Phase 1.

### 0.3 — Smoke revision 4 đạt, mở formal 16/10/2026

Bước: 0.3  
Trạng thái: in_progress  
Người/agent phụ trách: Codex  
Đầu ra: smoke-audit.json và smoke-review.json trong [round hiện tại](docs/phase0-20261016/round.json).  
Kiểm tra: 3/3 smoke invocations completed; mỗi lượt 2/2 native acceptance PASS; audit hashes/raw usage/actual model-effort/native stop/canonical task/lease/snapshot continuity PASS. Review source/RESULT/handoff PASS: clamp chỉ sửa cận bằng nhau; shipping stage 2 chỉ đổi return expression, giữ validation, đúng task/fresh session, source hash nối tiếp và supersession đúng ID.  
Quyết định hoặc blocker: handoff preview cắt ngắn nhưng full evidence artifact tồn tại; direct reported tests không giả làm runtime-verified. Goal cũ giữ nguyên, current request/active decision mới điều khiển stage 2. Baseline smoke không nhập mẫu formal; giữ hai smoke hạ tầng trong experiment accounting.  
Bước tiếp theo: `node benchmarks/task-management/run.mjs formal` — 25 invocations B tuần tự, sau đó audit/content review trước khi đánh dấu 0.3 done.

### 0.3 — Formal revision 4 dừng do quota 16/10/2026

Bước: 0.3  
Trạng thái: blocked  
Người/agent phụ trách: Codex  
Đầu ra: [báo cáo chặn quota](docs/phase0-20261016/formal-blocker-v4.md), [baseline đồng bộ](docs/phase0-20261016/baseline.json), `formal-audit.partial.json` và `formal-content-review.partial.json` trong [round hiện tại](docs/phase0-20261016/round.json).  
Kiểm tra: 13/25 formal invocations đã hoàn thành, 13/13 acceptance PASS (2/2 tests mỗi lượt), mechanical audit 13/13 không có mismatch, content review 13/13 PASS. Lượt `B-3-handoff-1` dừng trước `thread/start`: primary quota 100%, secondary 22%, credits 0; `launch=null`, `usage=null`, native stop xác nhận zero writers và zero active processes.  
Quyết định hoặc blocker: giữ nguyên round và raw evidence, không replay sau `infrastructure_failed`, không bật paid fallback hoặc sửa gate; 11 slot còn lại chưa khởi động. Tổng usage 13 lượt hoàn thành chỉ là partial, không phải baseline đầy đủ; phí tiền vẫn null.  
Bước tiếp theo: sau khi ordinary quota có lại, tạo round ID mới và chạy smoke/review rồi formal đủ 25 lượt theo protocol đã freeze; bảo toàn accounting và bằng chứng round dừng. Giữ 0.3 blocked và Phase 1 đóng cho đến khi đạt đầy đủ tiêu chí.

### 0.3 — Đóng baseline revision 5 ngày 16/10/2026

Bước: 0.3  
Trạng thái: done (đủ dữ liệu baseline, có 1 verdict chất lượng REWORK)  
Người/agent phụ trách: Codex  
Đầu ra: [baseline revision 5](docs/phase0-20261016/baseline.json), [round pointer](docs/phase0-20261016/round.json), `formal-audit.json`, `formal-content-review.partial.json` (ledger gốc) và `formal-review.json` (báo cáo đã đối chiếu hash) trong round `bcec1765-ab96-4c58-85f2-75d2424be872`; [tổng kết](docs/phase0-20261016/formal-review-v5.md).  
Kiểm tra: round mới `gpt-6-luna`, effort `medium`; smoke 3/3, formal 25/25 finished; 25/25 acceptance PASS với 50/50 native tests; mechanical audit 25/25 PASS, mismatch 0; content review 24 PASS, 1 REWORK, 0 BLOCKED. `node benchmarks/task-management/finalize-review.mjs` xác minh hash source và RESULT của từng lượt, identity và model/effort; `node benchmarks/task-management/sync-baseline.mjs` ghi `status=done`, `baselineComplete=true`. Raw provider measurements hợp lệ 25/25; cache-write và monetary cost để null vì semantics/giá chưa xác minh.  
Quyết định hoặc blocker: đây là kết thúc **thu dữ liệu** Phase 0, không phải công nhận chất lượng 25/25. `B-4-handoff-1` vẫn REWORK vì RESULT.md không ghi trực tiếp lệnh và kết quả test; host acceptance 2/2 và handoff chứng minh chạy đạt. Bằng chứng frozen giữ nguyên, không đổi verdict, không chạy lại invocation. Round revision 4 và các infrastructure attempts không nhập vào baseline revision 5.  
Bước tiếp theo: Phase 1 chưa mở theo phạm vi đã giao; giữ finding REWORK cho quyết định chất lượng và các phép so sánh về sau.

### Phase 1 — Contract, lifecycle và xác minh ngày 16/10/2026

Bước: 1.1  
Trạng thái: done  
Người/agent phụ trách: Codex  
Đầu ra: `packages/memory/src/types.ts`, `schema.ts`, `migrations.ts`, `task-repository.ts`, `sqlite-store.ts`, `memory-store.ts`, `sqlite-codecs.ts`, [hướng dẫn contract](docs/phase1-task-contract.md). Task giữ một nguồn dữ liệu SQLite; contract chứa scope, constraints, acceptance, checks, dependencies, context references và revision; checkpoint và handoff tham chiếu trạng thái dài.  
Kiểm tra: `managed-task.test.ts` bao gồm hợp đồng nhiều module, phiên bản contract, restart; kiểm tra migration v36→v38 và v37→v38.  
Quyết định hoặc blocker: tái sử dụng tasks/checkpoints/decisions/changes/handoffs hiện có; không sao chép hội thoại.  
Bước tiếp theo: 1.2.

Bước: 1.2  
Trạng thái: done  
Người/agent phụ trách: Codex  
Đầu ra: `packages/memory/src/task-repository.ts`, `packages/cli/src/commands/task.ts`, `packages/cli/src/commands/routes/task.ts`; CLI claim/release, contract show/set, verify, transition; `todo → in_progress → review → done`, blocked/rework có lý do, claim nguyên tử theo agent/session; done bắt buộc có proof từng acceptance và check đúng contract version.  
Kiểm tra: `managed-task.test.ts` xác minh tranh chấp owner, transition sai, dependency, rework xóa proof, thiếu check từ chối done, checkpoint sai task/session/version/evidence bị từ chối; giao dịch SQLite immediate.  
Quyết định hoặc blocker: các hook tự động Codex/Claude/Antigravity và gợi ý nhãn không tự hoàn tất hoặc sửa managed task; transition phải đi qua API có owner/session.  
Bước tiếp theo: 1.3.

Bước: 1.3  
Trạng thái: done  
Người/agent phụ trách: Codex  
Đầu ra: `packages/memory/src/managed-task.test.ts`, `packages/cli/src/commands/task-managed.test.ts`, `packages/cli/src/commands/routes/managed-task.test.ts`, `packages/cli/src/task-suggestions.test.ts`, `packages/cli/src/commands/ui-routes.test.ts`; sửa resume trong `packages/cli/src/commands/routes/session.ts` để bảo toàn managed state và từ chối mở terminal mới khi có claim.  
Kiểm tra: memory targeted 8/8 PASS; memory legacy 46/46 PASS; dashboard + task suggestion + UI routes 98/98 PASS; toàn CLI suite trước khi thêm CLI smoke 374/374 PASS (46 file); CLI command smoke riêng 1/1 PASS (contract set, claim, cập nhật mục tiêu, blocked, show, SQLite reopen); memory/CLI lint và build PASS. Test UI freshness có cảnh báo PATH `pnpm` nhưng toàn CLI suite exit 0.  
Quyết định hoặc blocker: dùng một SQLite cho CLI/dashboard, giữ tương thích legacy; không chạy provider invocation hay chỉnh bằng chứng Phase 0. Phase 2 chưa mở. Bằng chứng checkpoint là metadata do host kiểm chứng hình thức; nội dung artifact phải được review độc lập trước khi chấp nhận.  
Bước tiếp theo: Phase 2.1 — gắn context đúng task/session/request, chỉ triển khai ở lượt tiếp theo.

Kiểm tra bổ sung 1.2/1.3 (16/10/2026): phát hiện đường `todo → blocked → in_progress` có thể bỏ qua kiểm tra dependency; đã áp dụng cùng precondition của `todo → in_progress` cho `blocked → in_progress`. Sau sửa, memory 54/54 PASS, CLI dashboard/task command routes 94/94 PASS, memory/CLI lint và build exit 0. Không thay đổi verdict Phase 0.

Bước: 2.1  
Trạng thái: done  
Người/agent phụ trách: Codex  
Đầu ra: `packages/cli/src/context-runtime.ts`, `packages/cli/src/commands/context.ts`, `packages/core/src/context-compiler.ts`, các regression tests tương ứng. Manifest session-scoped có `taskId`, `agent`, `sessionId`, context `revision`, `requestRevision`, `requestId` và `sourceRevision` (hash task/handoff/decisions/relevant memories). Lookup xác minh agent/session/task, repo/branch, các artifact hash và source revision; startup tự compile lại nếu source cũ. Rebind session không thừa hưởng request cũ; `startup` buộc chọn session khi hai session cùng provider; assignment sai task bị từ chối. `context locate` trả kèm task/agent/revisions.  
Kiểm tra: context runtime + command 20/20 PASS; Codex/Claude/Antigravity hook, concurrency, retention, sandbox 46/46 PASS; core compiler 20/20 PASS; core/CLI lint và build PASS. Full CLI 380/381 PASS (46/47 file), còn một test độc lập `application-update` bị timeout 5 giây kèm lỗi Windows `EBUSY` khi dọn thư mục tạm; riêng test đó chạy lại với timeout 20 giây PASS 1/1 (11 skipped); không sửa module update.  
Quyết định hoặc blocker: chỉ tái sử dụng publication có source revision còn khớp; tài liệu legacy thiếu trường này buộc refresh. Shared `compiled-context.md` là alias last-writer-wins; context theo session phải lấy từ đường dẫn manifest đã xác minh. Không chạy lại provider benchmark, giữ Phase 0 nguyên trạng. Không có blocker thuộc phạm vi 2.1.  
Bước tiếp theo: 2.2 — chọn nội dung liên quan và chặn tổng budget.

Bước: 2.2  
Trạng thái: done  
Người/agent phụ trách: Codex  
Đầu ra: `packages/core/src/context-allocation.ts`, `context-compiler.ts`, `prompt-pack.ts`, `types.ts`; `packages/cli/src/context-runtime.ts`, `commands/context.ts`, các đường ghi context và regression tests. Bộ biên dịch ưu tiên current request, constraints, next step, quyết định và file liên quan; lọc mục rỗng, dedupe, chặn tổng token trên Markdown đã render (bao gồm budget/omission metadata), phân biệt configured counter và script-aware estimate. Các phần lược bỏ có số đếm và đường dẫn tới snapshot nguồn theo session, hash theo chính nội dung, xác minh toàn vẹn; snapshot chỉ đưa file summary liên quan. Source revision có file summary liên quan để buộc refresh khi thay đổi, tránh làm mất hiệu lực vì file không liên quan. Nội dung thiết yếu vượt budget trả `essential_budget_exceeded` cùng đường dẫn task/request/handoff/constraints đầy đủ.  
Kiểm tra: core full suite 189/189 PASS (19 file); CLI full suite trừ `commands/ui.test.ts` 359/359 PASS (46 file), và sau chỉnh source revision chạy lại context runtime + context command + UI routes 115/115 PASS (3 file); CLI TypeScript + UI-client typecheck PASS. Riêng `commands/ui.test.ts` báo 24/24 bài test PASS nhưng tiến trình trả mã 1 vì fixture rebuild chạy `corepack pnpm` trong môi trường thiếu lệnh `pnpm` trên PATH, nên chưa xác nhận toàn bộ CLI suite exit 0. Đây là giới hạn kiểm thử dashboard độc lập với compiler/runtime.  
Quyết định hoặc blocker: không gọi provider, không thay đổi baseline Phase 0. Snapshot nguồn chứa quyết định/memory đã lọc tag, handoff, repo map và file summary liên quan; không đặt phần chưa tính token vào nội dung gửi agent. Chưa có blocker chức năng thuộc phạm vi 2.2; cần xử lý môi trường `pnpm` nếu yêu cầu toàn suite CLI exit 0.  
Bước tiếp theo: 2.3 — áp dụng tìm trước, đọc sau và output ngắn.

Bước: 2.3  
Trạng thái: done (18/10/2026)  
Người/agent phụ trách: Codex  
Đầu ra: `packages/adapters/src/managed-section.ts` bổ sung quy tắc `rg --files`/`rg -n` trước khi đọc, loại vendor/generated, giới hạn đoạn mã và dependency trực tiếp; áp dụng cho Codex, Claude và Antigravity. `packages/core/src/log-compressor.ts` ưu tiên lỗi/stack frame ở bất kỳ vị trí nào, giới hạn dòng/ký tự, đếm dòng bị lược và chẩn đoán bị thiếu/cắt, giữ redaction. `packages/cli/src/commands/optimize.ts` ghi preview theo `--output`, bảo toàn log gốc, trả đường dẫn tuyệt đối cùng lệnh PowerShell/`rg` truy xuất; chặn ghi đè log gốc và giới hạn không hợp lệ. README và regression tests đã cập nhật.  
Minh chứng thực thi task mẫu: dùng `rg -n` tìm trực tiếp `compressLogPreview` và command `optimize logs`, không nạp toàn repo; CLI thật xử lý `docs/phase2-3-evidence/tool-output-full.txt` (124 dòng) với `--max-lines 3 --max-chars 180 --output docs/phase2-3-evidence/tool-output-preview.txt`. Preview giữ dòng 91–93 gồm Error và hai stack frame, thông báo còn thiếu 1 dòng chẩn đoán, có `Get-Content -LiteralPath` và `rg -ni -C 2` chỉ tới bản đầy đủ. Lệnh `rg` thực tế khôi phục được lỗi và frame ở dòng 91–94. Hai artifact giữ lại để đối chiếu.  
Kiểm tra: core full 193/193 PASS (19 file), adapters full 57/57 PASS (9 file), CLI log tests 2/2 PASS, các CLI suites `optimize-logs`, `request` và `followup-concurrency` chạy riêng 11/11 PASS; core/adapters/CLI build và lint PASS. Full CLI suite chưa xác nhận: lượt chạy song song gặp `ENOTEMPTY` ở fixture request, thay đổi source revision trong bài concurrency và process kết thúc với Windows exit `3221225477`; lượt chạy với 1 hoặc 2 worker cũng kết thúc mã `3221225477`. Các bài gây lỗi ở lượt đầu đều PASS khi chạy riêng; chưa xác định nguyên nhân crash toàn suite và không sửa phạm vi ngoài 2.3.  
Quyết định hoặc blocker: tiêu chí 2.3 về tìm-trước/đọc-sau, log ưu tiên lỗi và truy xuất artifact đã được kiểm chứng. Không gọi provider hay thay đổi baseline Phase 0; full CLI runner crash cần điều tra riêng nếu yêu cầu toàn suite exit 0. Workspace hiện không có `.git`, nên không có commit.  
Bước tiếp theo: 2.4 — tái sử dụng context khi còn hợp lệ, chưa bắt đầu.

Bước: 2.4  
Trạng thái: done (18/10/2026)  
Người/agent phụ trách: Codex  
Đầu ra: `packages/cli/src/context-runtime.ts`, `graph-brief.ts`, regression tests, `packages/adapters/src/managed-section.ts`, [chính sách reuse/invalidation](docs/phase2-4-context-reuse.md). Manifest lưu path/hash của source liên quan, null khi thiếu; context revision bao gồm source revision và file hashes. Locate/startup từ chối source sửa/xóa/tạo lại và publication legacy thiếu provenance; file không liên quan không gây invalidation. Brief có hash cũ chặn compile cho đến khi refresh; rebuild lấy symbol/import từ source hiện tại. Managed instructions quy định provenance cho kết quả đọc và kiểm tra lại trước sửa/kết luận; đây là chính sách agent, không phải interceptor của mọi shell read.  
Kiểm tra: baseline trước sửa 22/22 PASS; CLI context runtime/context command/graph brief sau sửa 31/31 PASS, exit 0; adapter managed-section/startup 7/7 PASS, exit 0; CLI lint và build, adapter build PASS. Full adapters báo 57/57 tests PASS nhưng worker process-runner shutdown timeout, chưa xác nhận exit sạch; không mở rộng sửa runner. Không chạy lại full CLI do các giới hạn runner đã ghi ở 2.3.  
Quyết định hoặc blocker: tái sử dụng publication và brief hiện có; hash verification vẫn cần đọc byte nhưng tránh nạp/diễn giải source lần nữa. Source ngoài tập file liên quan cần agent tự ghi provenance; graph đổi quan hệ cần graph rebuild và brief-auto --all. Không gọi provider, không thay baseline Phase 0. Workspace không có .git.  
Bước tiếp theo: 3.1 — hợp nhất checkpoint tối thiểu; chưa triển khai.

Bước: 3.1  
Trạng thái: done (18/10/2026)  
Người/agent phụ trách: Codex  
Đầu ra: checkpoint hiện có lưu snapshot goal/quyết định, completed và symbol; CLI --done, trả checkpointId.  
Kiểm tra: managed-task 9/9 PASS; memory build PASS; baseline checkpoint/handoff CLI 12/12 PASS trước sửa.  
Quyết định hoặc blocker: tái sử dụng payload SQLite và fingerprint, không thêm kho trạng thái.  
Bước tiếp theo: 3.2 in_progress — đọc trạng thái tiếp tục và xác minh nguồn.


Bước: 3.2  
Trạng thái: done (18/10/2026)  
Người/agent phụ trách: Codex  
Đầu ra: task resume --task --session --agent --revision; packet đọc SQLite, xác minh repository/branch, session binding, revision và file hashes.  
Kiểm tra: resume/task CLI 2/2 PASS; CLI lint PASS. Fresh store/session giữ next step và not_run, source đổi bị báo cần đọc lại; revision sai bị từ chối.  
Quyết định hoặc blocker: không tự chuyển owner hay thực thi slash command của provider.  
Bước tiếp theo: 3.3 in_progress — contract và kiểm chứng bàn giao khác agent.


Bước: 3.3  
Trạng thái: done (18/10/2026, kiểm chứng bàn giao trạng thái bằng API/CLI)  
Người/agent phụ trách: Codex  
Đầu ra: handoff inspect contract v1 tham chiếu checkpointId/task/revision, current contract/constraints, results/evidence, blockers/next, owner/leases và source verification; managed instructions và docs/phase3-checkpoint-resume.md.  
Kiểm tra: memory managed + legacy 55/55 PASS; CLI handoff/task/resume 6/6 PASS; resume sau chỉnh status action 2/2 PASS; adapters managed-section 4/4 PASS. Memory, CLI và adapters build PASS; CLI lint PASS trước bổ sung inspect, build cuối xác minh cả TypeScript/UI. Bàn giao Codex sender sang Claude receiver chạy trên SQLite thật trong fixture: nhả claim, mở lại store, claim cùng task; task count 1, blocker/constraints/not_run không mất; CLI inspect đúng checkpointId.  
Quyết định hoặc blocker: không gọi hai model/provider thật; bằng chứng xác nhận cơ chế lưu/đọc/bàn giao trạng thái, không xác nhận model tự thực hiện next step hay hiệu quả token. Không chạy full CLI suite do giới hạn runner đã ghi ở Phase 2; không đổi baseline Phase 0. Workspace không có .git.  
Bước tiếp theo: 4.1 — chưa triển khai; nếu cần nghiệm thu hành vi model qua hai provider, chạy smoke riêng theo quy trình đã ghi.


Bước: 4.1  
Trạng thái: done (18/10/2026)  
Người/agent phụ trách: Codex  
Đầu ra: packages/cli/src/task-check-plan.ts, task check-plan, docs/phase4-quality-control.md; tái sử dụng checkpoint command/exit/evidence/contractVersion và file hashes.  
Kiểm tra: baseline managed task/resume/CLI 12/12 PASS; check-plan và managed CLI 2/2 PASS, exit 0. Xác minh chọn scope, mở rộng có lý do, source revision đổi khi sửa, từ chối file ngoài repo hoặc không có rule.  
Quyết định hoặc blocker: rule khai báo rõ, không đoán dependency; required checks không bị bỏ khi chỉ chọn targeted checks. Không chạy provider benchmark.  
Bước tiếp theo: 4.2 in_progress — verdict review và gate done.

Bước: 4.2  
Trạng thái: done (18/10/2026)  
Người/agent phụ trách: Codex  
Đầu ra: migration v39, task_quality_reviews, record/listManagedReviews, task review --file, gate done yêu cầu pass đúng contract/checkpoint revision; scope nhiều mục yêu cầu reviewer session độc lập.  
Kiểm tra: managed lifecycle + CLI + dashboard trước mở rộng 11/11 PASS; bổ sung regression review history/rework/blocked/restart và stale verdict (kết quả ghi ở checkpoint cuối Phase 4).  
Quyết định hoặc blocker: review được khai báo cùng diffRef, limitations và checkpoint; API kiểm tra binding/metadata, người review chịu trách nhiệm đọc nội dung artifact. Verdict cũ được giữ sau rework nhưng vô hiệu hóa.  
Bước tiếp theo: 4.3 in_progress — policy và attempt có giới hạn.

Bước: 4.3  
Trạng thái: done (18/10/2026)  
Người/agent phụ trách: Codex  
Đầu ra: migration v40, task-retry-policy.ts, task_attempts/task_retry_policies, task attempt policy/begin/end; managed instructions cho ba provider và docs/phase4-quality-control.md.  
Kiểm tra: regression cuối 203/203 PASS, 23/23 file, exit 0; memory/adapters/CLI build từng lệnh exit 0; UI-client typecheck exit 0. SQLite fixture dừng sau hai failure cùng operation, từ chối continue, lưu checkpoint/reason/escalate và blocked qua restart; không reset policy khi đổi session. Test riêng xác nhận ngưỡng attempt/token/time; CLI fixture hoàn tất check-plan → attempt → review → done. Migration v38→v40 giữ contract/claim.  
Quyết định hoặc blocker: gate theo lifecycle begin/end, không ngắt provider trực tiếp; token thiếu là null, token gate chỉ tính lower bound đã biết. Mọi attempt có hypothesis và checkpoint/evidence/next step trước end; không bỏ acceptance. Hai failure cùng operation cho phép đổi operation sau quyết định change_direction/escalate và unblock, tổng budget không reset. Không gọi provider và không thay baseline Phase 0.  
Bước tiếp theo: 5.1 — chưa triển khai, ngoài phạm vi lượt này.

Kiểm chứng cuối 4.1–4.3 (18/10/2026): docs/phase4-quality-control.md ghi lệnh, kết quả và giới hạn thực tế. Bổ sung invalidation khi checkpoint ghi source hash thay đổi hoặc test failed: xóa acceptance/check proofs, chặn verify lại checkpoint cũ. Review pass bắt buộc đúng revision và còn hiệu lực; rework/blocked bảo toàn lịch sử. Multi-scope dùng reviewerSession độc lập theo metadata; API không xác nhận người review đã đọc artifact hoặc chạy model khác. Gate done dùng chung SQLite cho CLI/dashboard, nhập verdict qua CLI/API. Full CLI suite chưa chạy do giới hạn runner đã ghi ở Phase 2; 203 tests liên quan đều PASS. Workspace không có .git, không tạo commit. Phase 4 đóng; Phase 5 chưa mở.

Bước: 5.1  
Trạng thái: in_progress  
Người/agent phụ trách: Codex  
Đầu ra: validator phân rã và mẫu task.  
Kiểm tra: baseline managed-task/session-leases/task-quality 14/14 PASS.  
Quyết định hoặc blocker: tái sử dụng contract và SQLite.  
Bước tiếp theo: kiểm chứng coverage acceptance và kiểm tra tích hợp.

Bước: 5.1  
Trạng thái: done  
Người/agent phụ trách: Codex  
Đầu ra: task-planning.ts, migration v41, API set/getTaskDecomposition, docs/phase5-task-planning.md.  
Kiểm tra: task-planning.test.ts 1/1 PASS; bao gồm coverage, thiếu output, revision, integration check, owner và chu trình phân rã.  
Quyết định hoặc blocker: coverage ngữ nghĩa cần reviewer; không tự tạo task trùng.  
Bước tiếp theo: 5.2 in_progress — dependency và invalidation xuyên lifecycle.

Bước: 5.2  
Trạng thái: done  
Người/agent phụ trách: Codex  
Đầu ra: dependency gate khi start/attempt/review/proof/done; reopen có lý do, invalidation bắc cầu và chặn xóa task đang được tham chiếu.  
Kiểm tra: planning + managed-task + task-quality 16/16 PASS; memory lint PASS.  
Quyết định hoặc blocker: legacy predecessor done giữ tương thích; managed predecessor cần review pass còn hiệu lực.  
Bước tiếp theo: 6.1 in_progress — kiểm chứng lease và recovery.

Bước: 6.1  
Trạng thái: done  
Người/agent phụ trách: Codex  
Đầu ra: lease normalization, exact owner renewal/release, expired leases cần explicit recovery; recoverSessionFileLeases kiểm tra terminal run/PID và checkpoint khớp byte hiện tại trước nhả lease.  
Kiểm tra: session-leases + sqlite-store 49/49 PASS; kiểm tra tranh chấp, batch rollback, reader isolation, TTL, live PID, checkpoint mismatch và restart.  
Quyết định hoặc blocker: recovery không sửa/xóa file; PID chỉ kiểm chứng host cục bộ.  
Bước tiếp theo: 6.2 in_progress — reservation nguyên tử và budget/concurrency.

Bước: 6.2  
Trạng thái: done  
Người/agent phụ trách: Codex  
Đầu ra: migration v42, ManagedDispatchRepository, reservation API; atomic claim/lease/attempt/run, concurrency và token budget có overhead leader/reviewer/handoff.  
Kiểm tra: managed-dispatch/session-leases/planning 9/9 PASS, memory lint PASS; hai SQLite connection không tạo run trùng; dependency/scope/budget/lease lỗi rollback toàn bộ.  
Quyết định hoặc blocker: cần evidence lợi ích để concurrency >1; reservation chưa khởi chạy provider, host thực thi sau khi nhận runId. Token bound không phải hard cap của provider.  
Bước tiếp theo: 6.3 in_progress — settlement, stop/recovery/resume và integration.

Bước: 6.3  
Trạng thái: done (18/10/2026)  
Người/agent phụ trách: Codex  
Đầu ra: `packages/memory/src/managed-dispatch.ts`, `lease-snapshot.ts`, repository/store gates và migration v42; `packages/adapters/src/process-runner.ts` dùng reserved run với claim launch nguyên tử; CLI `task decomposition set/show`, `task dispatch policy/reserve/launch/stop/reap/settle/overhead/report` và `file recover`; [Phase 5](docs/phase5-task-planning.md), [Phase 6](docs/phase6-managed-dispatch.md).  
Kiểm tra: memory full 199/199 PASS (18 file), adapters full 58/58 PASS (9 file, một worker, exit sạch), CLI liên quan 13/13 PASS (7 file, một worker), core orchestrator/context-compiler 72/72 PASS (2 file): tổng 342/342 PASS, 36 file, mọi lệnh exit 0. Build memory, adapters, CLI (gồm UI-client TypeScript) từng lệnh exit 0. CLI `node packages/cli/dist/index.js task dispatch --help` exit 0, hiển thị tám command mới. CLI lint và memory lint đã PASS; build cuối kiểm tra lại toàn bộ TypeScript sau các chỉnh sửa.  
Quyết định hoặc blocker: fixture Codex/Claude kiểm tra child review, parent integration failed không thể done rồi integration passed/review mới hoàn tất; failed run restart giữ claim và retry history. Adapter fixture chạy hai Node process thật với hai scope riêng, kiểm tổng output kết hợp, settlement dùng đúng reserved run và từ chối double launch/spawn managed không reserve. Đây là bằng chứng process/host lifecycle; không phải hai model thật. Migration v40→v42 giữ contract/owner/progress; directory snapshot phát hiện file chưa checkpoint. Usage thiếu giữ null và tính reservation bảo thủ; monetary cost null, không kết luận hiệu quả token.  
Bước tiếp theo: Phase 7.1 — chưa mở, ngoài phạm vi lượt này.

Kiểm chứng cuối Phase 5–6 (18/10/2026): dependency gate áp dụng ở start/unblock/attempt/proof/review/done; reopen/source failure invalidation bắc cầu, tăng contract version để từ chối checkpoint cũ; đổi decomposition yêu cầu integration evidence mới. Lease normalize và kiểm tra ownership tại repository; batch rollback, scope thư mục chặn file con, lease hết hạn cần explicit cleanup thay vì tự chiếm. Recovery chỉ release sau terminal run/PID/checkpoint/disk checks, không ghi đè thay đổi. Dispatch reservation và claim launch là hai giao dịch nguyên tử; crash giữa launch claim và PID vẫn giữ reservation/lease, host phải xác minh và recovery, không tự spawn lại. Settlement không tự chấp nhận task; mỗi child và parent vẫn qua Phase 4. Scope/lease là giao thức hợp tác cùng store, không phải OS sandbox; token bound không ngắt provider ngay khi vượt. Full CLI suite không chạy do giới hạn runner đã ghi ở Phase 2; không gọi provider, không thay baseline Phase 0. Workspace không có .git, không tạo commit. Phase 5 và 6 đóng theo bằng chứng host/API/process trên; Phase 7 chưa triển khai.
Bước: 7.1
Trạng thái: done (18/10/2026)
Người/agent phụ trách: Codex
Đầu ra: model-routing.ts, agent-selector routing opt-in, regression tests, scripts/phase7-routing-smoke.mjs, docs/phase7-model-cache-memory.md và docs/phase7-evidence/routing-smoke.*.
Kiểm tra: routing/selector 18/18 PASS; core lint PASS; Codex thật hoàn thành hàm sumPositive, ba acceptance checks đạt, raw usage có input/cached/output; cost null. Baseline core trước sửa 193/193 PASS.
Quyết định hoặc blocker: policy theo cấu hình caller, không giả định model thương mại; retry-inclusive usage có lower bound và null khi thiếu. Smoke không chứng minh lợi ích chi phí hoặc mọi nhóm task.
Bước tiếp theo: 7.2 in_progress — cache telemetry và cấu trúc prompt.
Bước: 7.2
Trạng thái: done (18/10/2026)
Người/agent phụ trách: Codex
Đầu ra: shared prompt instructions, task ID trong prefix, normalizeProviderUsage hỗ trợ cache_write_input_tokens/reasoning_output_tokens/input_tokens_details; smoke gửi renderPromptPack thật và lưu prompt/raw/normalized usage.
Kiểm tra: cache/context/usage 34/34 PASS; core build PASS; Codex thật acceptance PASS, input 13766, cache read 0, cache write 0, output 58; cost null. Cache fields lấy từ terminal usage, không suy từ marker.
Quyết định hoặc blocker: lượt này không có cache hit, không kết luận tiết kiệm. Anthropic cache_control chỉ là helper opt-in, chưa xác minh provider đó; provider không báo field giữ null. Không trộn nội dung task trong prefix.
Bước tiếp theo: 7.3 in_progress — provenance, TTL, invalidation và bảo toàn lịch sử.
Bước: 7.3
Trạng thái: done (18/10/2026)
Người/agent phụ trách: Codex
Đầu ra: reusable-memory.ts; evidence.reuse (key/scope/revision/expiresAt/invalidation), atomic add/dedupe/supersede trong repository; CLI memory add --repo --evidence; compileContext memoryReuse opt-in; docs/phase7-model-cache-memory.md.
Kiểm tra: memory full 202/202 PASS, core full 201/201 PASS; CLI memory-reuse/context-runtime/context 26/26 PASS; sau chặn upsertLatestMemory sửa reusable row, reusable-memory/sqlite-store 49/49 PASS. Memory/core/CLI build PASS, CLI lint và UI-client typecheck PASS. Tests kiểm scope/revision/TTL, credential rejection, dedupe/conflict/history, không mất task khi xóa knowledge và giữ current request.
Quyết định hoặc blocker: tái sử dụng evidence JSON, không migration hoặc kho memory trùng. Routing và reusable memory bật qua core API; CLI cho ghi evidence nhưng publication chưa tự suy verification scope/revision nên không tự nạp reusable memory mới. Legacy giữ tương thích. Conflict tự giải quyết theo key/type/scope, khác key cần reviewer; sensitive pattern detector không bảo đảm nhận diện mọi bí mật. Provider thật đã chạy task mẫu và ghi raw usage; cache read lượt cuối 0, cost null, không khẳng định tiết kiệm. Full CLI không chạy vì giới hạn runner đã ghi ở Phase 2.
Bước tiếp theo: Phase 8.1 chưa mở; đo telemetry tổng thể và protocol so sánh trong phạm vi riêng.

Kiểm chứng cuối Phase 7 (18/10/2026): 7.1–7.3 hoàn tất với routing cấu hình opt-in, model smoke thật, provider cache telemetry và memory có provenance/TTL/invalidation. Chi tiết phạm vi, lệnh, dữ liệu và giới hạn ở docs/phase7-model-cache-memory.md. Không thay baseline Phase 0. Workspace không có .git, không tạo commit.

Bước: 8.1
Trạng thái: done (18/10/2026)
Người/agent phụ trách: Codex
Đầu ra: packages/core/src/task-telemetry.ts; usage observer/process runner; CLI usage-ledger/request/report usage; docs/phase8-task-telemetry.md.
Kiểm tra: baseline 3/3 PASS; regression telemetry/core/adapter/process/request/ledger 33/33 PASS, 6 file, exit 0. Build core/adapters/CLI (gồm UI-client TypeScript) exit 0; CLI build sau thay đổi coverage lifecycle cuối exit 0.
Quyết định hoặc blocker: raw usage gắn task/session/run/managed attempt/model/contract revision; phân biệt inclusive/exclusive/unknown, reasoning không cộng trùng; failed retries được giữ. Báo cáo có token, run duration, supported tool calls, managed retries/rework và completion rate SQLite. Pricing/cost/savings null; metadata legacy, request CLI usage và công cụ không hỗ trợ giữ thiếu dữ liệu. Contract revision không thay source hash checkpoint. Không gọi provider thật, không thay baseline Phase 0/7, không kết luận tiết kiệm. Chi tiết lệnh và giới hạn ở docs/phase8-task-telemetry.md.
Bước tiếp theo: 8.2 — chưa triển khai, ngoài phạm vi yêu cầu này.


Bước: 8.2
Trạng thái: in_progress (18/10/2026)
Người/agent phụ trách: Codex
Đầu ra: benchmarks/task-management/compare-run.mjs, compare-audit.mjs; docs/phase8-2-20261018/provider-preflight.json, controls/report.json, round.json.
Kiểm tra: provider preflight PASS, model gpt-6-luna/medium, ordinary quota available, no paid fallback; native stdio 4/4 PASS; evaluator controls 10/10 PASS; build memory/core/adapters/CLI gồm UI-client PASS.
Quyết định hoặc blocker: round B/S mới, B lấy runtime immutable Phase 0 revision 5; S build hiện tại, full/manual lifecycle; không thay evidence hoặc pointer Phase 0. M chưa mở trong dataset này; routing/memory opt-in không bật tự động.
Bước tiếp theo: chạy và review smoke B/S trước formal 50 invocations xen kẽ; dừng nếu infrastructure failure, giữ partial usage.


Bước: 8.2
Trạng thái: blocked (18/10/2026)
Người/agent phụ trách: Codex
Đầu ra: docs/phase8-comparison.md; docs/phase8-2-20261018/{round,provider-preflight,shell-preflight,incident,comparison-report}.json; benchmarks/task-management/{compare-run,compare-audit,compare-report,comparison,comparison.test,shell-preflight}.mjs.
Kiểm tra: build memory/core/adapters/CLI gồm UI-client PASS; native stdio 4/4 PASS; calculator 5/5 PASS; native-supervisor/codex-adapter tests exit 0; evaluator controls 10/10 PASS; provider preflight PASS. B-small smoke 2/2 acceptance PASS. Ba completed smoke records mechanical audit PASS nhưng smoke quality không đạt; shell probe FAIL độc lập, không inference. Bốn provider launch đều có native stop proof, zero active writers. Formal 0/50.
Quyết định hoặc blocker: PowerShell location C:\ dù process cwd đúng workspace; relative project IO thất bại và Set-Location bị từ chối D:\TAILIEU. B-handoff-1 chưa triển khai, acceptance 0/2, thiếu RESULT/handoff. Host dừng B-handoff-2 và S-small; S-small thiếu mandatory usage. Giữ nguyên original state/raw usage và ghi incident riêng; không replay hoặc reseed. Report có partial observed lower bound, total/ratios thiếu giữ null; không kết luận tiết kiệm hoặc chất lượng S, cost null. Runner bổ sung gate shell trước inference; round frozen chỉ còn dùng audit/report, không tiếp tục.
Bước tiếp theo: chẩn đoán/sửa native shell cwd bằng probe không model và boundary checks, freeze round B/S mới, chạy lại đủ reviewed smoke rồi formal 50 lượt xen kẽ. 8.2 chưa done; không mở 8.3 hoặc Phase 9.


Bước: 8.2 — sửa hạ tầng PowerShell cwd
Trạng thái: done cho bản sửa compatibility; 8.2 chưa done (18/10/2026)
Người/agent phụ trách: Codex
Đầu ra: benchmarks/task-management/powershell-cwd.mjs và powershell-cwd.test.mjs; sửa compare-run/compare-audit/shell-preflight; protocol revision 6; docs/phase8-shell-cwd-fix.md; docs/phase8-2-20261018/shell-preflight-fixed-v2.json và shell-native-regression.json.
Kiểm tra: native probe trên D-drive PASS relative read/write; shell thường và -NoProfile PASS trên workspace có khoảng trắng; năm protected sentinels bị chặn cả đọc/ghi, native receipts zero writers. Native/helper audit 2/2 PASS; stdio/calculator 9/9 PASS; native-supervisor/sandbox baseline 4/4 PASS. Syntax checks PASS. Không inference trong lượt sửa.
Quyết định hoặc blocker: PSDrive bootstrap trong mỗi PowerShell tool call, cùng chỉ dẫn cho B/S; runner/audit từ chối lệnh thiếu bootstrap. Không đổi ACL ancestors hoặc cấu hình provider toàn cục; grant thử nghiệm đã gỡ. Đây là compatibility contract của harness, chưa xác minh model tuân thủ bằng smoke mới. Không replay round lỗi hoặc sửa evidence cũ.
Bước tiếp theo: freeze round revision 6 mới và kiểm model tool-call qua smoke B/S trước formal; giữ checkbox 8.2 chưa hoàn tất, không mở 8.3/Phase 9.


Bước: 8.2 — chạy lại revision 6
Trạng thái: in_progress (18/10/2026)
Người/agent phụ trách: Codex
Đầu ra: docs/phase8-2-20261018/retry-v6/provider-preflight.json, controls/report.json; round mới theo pointer hiện hành, round cũ lưu round-history.
Kiểm tra: provider preflight mới PASS (gpt-6-luna/medium, quota primary 1%, no paid fallback); build memory/core/adapters/CLI gồm UI-client PASS; shell/stdIO/calculator 11/11 PASS; controls 10/10 PASS.
Quyết định hoặc blocker: freeze chung bootstrap PSDrive cho B/S; review nội dung có timestamp thực đo; báo cáo tách incident theo round để không nhập lỗi cũ vào round mới. Không đổi product source hoặc acceptance.
Bước tiếp theo: smoke sáu invocation có audit/review; chỉ mở formal 50 lượt sau smoke PASS.


Bước: 8.2 — kết quả chạy lại revision 6
Trạng thái: blocked / content rework (18/10/2026)
Người/agent phụ trách: Codex
Đầu ra: docs/phase8-comparison-retry-v6.md; docs/phase8-2-20261018/retry-v6/{result,comparison-report,formal-gate}.json; round b0e47b39-f93d-4483-83de-795ab3f1acec theo pointer hiện hành; raw protocol/usage/source snapshots, smoke-audit.json, smoke-content-review.json, smoke-review.json trong round.
Kiểm tra: sáu provider smoke hoàn tất, acceptance 12/12 PASS, mechanical audit 6/6 PASS, content review 2 PASS/4 REWORK. Bootstrap được model dùng thật; không infrastructure failure/cwd violation. Cả sáu launch và evaluator native stop PASS, zero writers; task/session/source continuity đúng. Lệnh formal bị gate từ chối đúng vì reviewed smoke chưa PASS, state hash và sáu provider invocations không đổi; formal 0/50.
Quyết định hoặc blocker: handoff B/S chưa lưu source revision và decision-reason đủ rubric; stage-1 RESULT thiếu test evidence. S-stage2 thực sự hash source trước sửa nhưng handoff vẫn không lưu revision. Không bỏ qua review vì tests PASS, không sửa artifacts hộ agent hoặc trộn round lỗi cũ. Sáu implementation first attempts, chưa có implementation reattempt; không claim đã kiểm chứng retry/rework end-to-end. Token smoke mới 1147310 input+output, gồm cache; reasoning không cộng thêm. Cost null, threshold/efficiency conclusions null.
Bước tiếp theo: xử lý luồng bàn giao manual/default và quy trình rework có hỗ trợ, freeze đúng instrumentation rồi chạy reviewed smoke đạt trước formal 50 lượt. 8.2 vẫn chưa done; không mở 8.3 hoặc Phase 9.


Bước: 8.2 — xử lý rework và bằng chứng bàn giao
Trạng thái: in_progress (18/10/2026)
Người/agent phụ trách: Codex
Đầu ra: comparison-attempts.mjs/.test.mjs; runner/audit/review/report hỗ trợ invocation riêng cho attempt 2, feedback có hash binding, continuation source/session, gate theo latest attempt; protocol revision 7; docs/phase8-2-20261018/rework-v7/provider-preflight.json và controls/report.json.
Kiểm tra: regression baseline shell/stdIO/calculator 11/11 PASS; attempt-control/source-evidence/calculator mới 11/11 PASS; syntax checks PASS; evaluator controls 10/10 PASS; provider preflight mới PASS, không paid fallback. Baseline runtime handoff create --payload-file đã xác minh hỗ trợ.
Quyết định hoặc blocker: không sửa artifact round cũ. Round mới áp dụng cùng rubric evidence rõ ràng cho B/S; retry giữ source thật và task, mở fresh thread/session, tối đa hai attempts; không mở successor trước review PASS. RESULT và canonical handoff do agent viết, host không tạo lời giải/bằng chứng hộ.
Bước tiếp theo: chạy/review smoke revision 7; dùng attempt 2 khi rework; formal chỉ sau latest smoke attempts PASS và tất cả attempts được audit/review.


Bước: 8.2 — smoke revision 7 đạt gate
Trạng thái: formal in_progress (18/10/2026)
Đầu ra: round 636fb2b9-5171-47a7-a4fe-b7f86ac66940, smoke-audit.json, smoke-content-review.json, smoke-review.json.
Kiểm tra: 6/6 logical smoke latest PASS; 8 provider invocations gồm 2 rework; toàn bộ 8 attempts được audit/review, mechanicalIntegrityPassed=true. Hai rework giữ source/task và mở session mới; stage 2 tiếp tục đúng final PASS stage 1.
Quyết định: gate formal đã mở bằng evidence thật; không kết luận tiết kiệm từ smoke. Các lỗi bookkeeping managed API trong S được lưu là limitation của manual/default experiment.
Bước tiếp theo: hoàn thành/review 50 formal logical slots theo lịch; không mở 8.3/9.


Bước: 8.2 — kết quả rework revision 7
Trạng thái: quality_failed / chưa hoàn tất (18/10/2026)
Đầu ra: docs/phase8-comparison-rework-v7.md; docs/phase8-2-20261018/rework-v7/comparison-report.json; round 636fb2b9-5171-47a7-a4fe-b7f86ac66940.
Kiểm tra: smoke latest 6/6 PASS qua 8 invocations; formal 3/50 logical slots qua 6 invocations, latest small/debug PASS và multi REWORK. Cả 14 provider invocations acceptance 28/28 PASS, observed integrity PASS; full formal audit thiếu 47 scheduled slots. Không infrastructure failure/cwd violation; zero live invocations.
Quyết định hoặc blocker: formal multi attempt 2 vẫn bỏ sót failed handoff/checkpoint evidence đã được feedback yêu cầu. Runner chặn đúng max 2, formal-review blocked; không chạy attempt 3 hoặc sửa artifact hộ. All-attempt input+output 5003869, cost null, thresholds null, chưa có formal B/S pair hoàn chỉnh.
Bước tiếp theo: giữ round đã dừng và toàn bộ raw/review; giải quyết độ tin cậy ghi failed-check evidence trong một thay đổi và round mới có provenance riêng. Không đánh dấu 8.2 done hoặc mở 8.3/9.


Ngày: 19/10/2026
Bước: 8.2 — triển khai evidence/rollover revision 8 theo docs/plan.md
Trạng thái: sửa harness và kiểm chứng không model hoàn tất; phép đo vẫn blocked.
Đầu ra: docs/phase8-comparison-evidence-v8.md; docs/phase8-2-20261018/evidence-v8/{result,comparison-report,source-final,final-integrity}.json và checkpoint.md; round 22bd2565-c84b-4f87-a830-11f0470cef6f.
Kiểm tra: baseline 11 tests PASS; suite cuối 17 PASS; controls 10/10 PASS trước freeze và sau sửa source cuối; fresh provider/shell preflight PASS. Rollover nhận formal terminal failure với smoke PASS; v7 archived pointer/artifacts giữ nguyên hash. Hai invocations smoke small B cùng source/task, mỗi acceptance 2/2 PASS, partial audit cả hai PASS; attempt 2 giữ đủ chín lỗi trong ledger/RESULT/full canonical evidence.
Kết quả: attempt 2 vượt uncached-input+output cap 103059/100000, turn interrupted/product failure; RESULT còn nhầm original pre-edit với predecessor FINAL hash. Round quality_failed, smoke latest PASS 0/6, formal 0/50; không attempt 3/successor/round tự động. Usage round mới 761983 input+output gồm rework; pricing/thresholds null, releasePassed=false. Host schema ambiguity output/actualOutput đã gây rework và được ghi limitation, không đổi verdict cũ.
Source cuối sau stop chấp nhận alias actualOutput, làm rõ FINAL hash và kiểm helper/raw binding; 17 tests/10 controls PASS nhưng chưa gọi model trên snapshot này, cần freeze mới nếu thử tiếp. Không dùng kết quả cũ chứng nhận source mới.
Bước tiếp theo: giữ 8.2 blocked, phân tích overhead evidence/verification và claim hash sai trong budget hiện có; chưa mở 8.3/9 hoặc tự lặp round để tìm PASS.

Ngày: 19/10/2026
Bước: 8.2 — chẩn đoán offline overhead evidence/verification và source claim v8
Trạng thái: chẩn đoán hoàn tất; phép đo vẫn blocked.
Đầu ra: docs/phase8-evidence-diagnosis-v8.md; docs/phase8-2-20261018/diagnosis-v8/{analyze.mjs,analysis.json,checkpoint.md}.
Kiểm tra: comparison suite hiện tại PASS (18 dot tests); analyzer đối chiếu full raw/event outputs, usage/state, actual source hashes, continuity, retained error IDs và input hashes không đổi. Không inference hoặc sửa harness/artifact v8.
Kết quả: attempt 2 dùng 50388 metric cap tới acceptance và 52671 sau đó; sau verification cuối 98831, cập nhật sau release 103059 vượt cap 100000. Các khoảng usage gồm context/generation, không phải token cost độc lập của command. Source giữ nguyên; RESULT chép original-before thay predecessor-final dù đã đọc hash đúng. Serialization và hiểu sai canonical schema tạo vòng sửa evidence.
Giới hạn: ba source files đã drift so với source-final v8 và live runner dùng weighted cap; giữ nguyên thay đổi có sẵn, không áp dụng cách tính mới hồi tố. Không tính savings hoặc đổi verdict/accounting.
Bước tiếp theo: sửa contract evidence với script/module format rõ ràng, schema canonical/CURRENT chính xác, kiểm quan hệ các vai trò hash và output verification gọn; kiểm chứng offline trước mọi freeze/preflight riêng. Giữ 8.2 blocked, không mở 8.3/9.

Ngày: 19/10/2026
Bước: 8.2 — evidence contract revision 9, P1–P5 offline
Trạng thái: contract offline hoàn tất; phép đo Phase 8.2 vẫn blocked.
Đầu ra: docs/phase8-evidence-contract-v9.md; docs/phase8-2-20261018/contract-v9/{baseline,checks,source-final,final-integrity}.json, raw checks, controls và checkpoint.md.
Kiểm tra: baseline 18 PASS; suite cuối 22 PASS; syntax 4 modules PASS; controls evaluator 10/10; 6757 historical files không đổi. Không model invocation, runtime/build/fixtures không đổi.
Thay đổi: phân biệt payload/canonical/CURRENT và module format; bind full referenced artifacts; gate bốn vai trò source hash, absent predecessor và đồng nhất claim artifact/RESULT/CURRENT; lifecycle lấy task ID thật. Giữ human content assessment, historical errors, cap/attempt/cleanup.
Blocker: v8 frozen weight 1 khác live output weight 8; phải chốt budget contract cho phép đo tương lai trước freeze. Không hồi tố v8, không suy savings hoặc mở 8.3/9.
Bước tiếp theo: đánh giá thí nghiệm riêng với source freeze/fingerprint mới và prerequisites/preflight đúng interface; không tiếp tục round v8 hoặc tự lặp round.

Ngày: 19/10/2026
Bước: 8.2 — chốt budget theo chỉ đạo người dùng
Quyết định: tất cả phép so sánh mới dùng runner hiện tại; uncached input + output × 8, cap 200000 mỗi attempt cho B/S smoke/formal. Đã sửa compare-run freeze config và protocol, đóng blocker lựa chọn budget. Giữ guard 1000000 input+output, 10 phút, hai attempts, cleanup và quality gates; không hồi tố v8 hoặc gộp round khác budget thành cùng cohort.
Kiểm tra: suite 23 tests PASS, syntax runner PASS, controls 10/10 PASS. Commands/raw outputs/source hashes: docs/phase8-2-20261018/contract-v9/budget-200k/checks.json. Không model invocation.
Bước tiếp theo: chuẩn bị source freeze/fingerprint và preflight cho phép đo mới theo budget 200k; Phase 8.2 vẫn cần đạt smoke/formal audit và review trước chuyển phase.

Ngày: 19/10/2026
Bước: 8.2 — thực hiện docs/phase8-2-pass-plan-200k.md
Trạng thái: blocked; round 200k infrastructure_failed trước inference, releasePassed=false.
Đầu ra: docs/phase8-2-pass-200k-report.md và docs/phase8-2-20261018/pass-200k/; round adfc9f60-1050-4f9e-a239-deebcb80ed8f, protocolHash ab28d63f29b6558d30fc1714d7d831748939ca46808eed65a278f43b511f7916.
Kiểm tra: 23 comparison/claim tests PASS, shell/native compatibility PASS, bốn syntax checks PASS, controls 10/10 PASS, build bốn packages PASS, CLI integration thực B/S × 2 stages PASS; fresh provider/shell preflight và validateRollover PASS. Đối chiếu 6757 historical files không đổi; pointer v8 archive nguyên bytes. Thay đổi source duy nhất trước freeze: làm rõ đoạn 100k lịch sử trong protocol.
Blocker: ENOSPC khi copy codex.exe vào evidence B-0-small-1; slot preflight_failed với launch=null, không model invocation; smoke 0/6 completed, formal 0/50. Partial audit không PASS do không có completed slots, không có content review để finalize; reporter giữ metrics/thresholds null, monetaryCost=null.
Bước tiếp theo: giải quyết dung lượng và đánh giá capacity cho binary/runtime/raw snapshots. Giữ round terminal và mọi evidence; không replay, không tự mở round mới tìm PASS. Round riêng cần chỉ đạo mới sau xử lý hạ tầng. 8.2 chưa done, chưa mở 8.3/9.

Ngày: 19/10/2026
Bước: chạy lại baseline và 8.2 theo chỉ đạo sau khi dọn dung lượng
Trạng thái: phục hồi hạ tầng và baseline build hoàn tất; phép đo baseline/8.2 vẫn blocked tại smoke quality_failed.
Đầu ra: docs/phase8-2-recovery-report-20261019.md; docs/phase8-recovery-20261019/validated/ chứa source/provenance, build/tests, baseline pointer, fresh preflight, assessments, terminal accounting/report và final integrity. Runtime/adapter cần cho harness phục hồi từ lịch sử phiên; B dựng riêng từ ZIP 11/10 và 29 thay đổi ghi trước Phase 1, không xác nhận byte-identical revision 5 đã mất. Compare-run hỗ trợ --baseline-pointer và hash-bound provenance mới; B được thu lại trong lịch B/S xen kẽ, không dùng candidate làm baseline.
Kiểm tra: build B/S bốn packages và UI PASS; runtime 85 tests PASS, comparison/shell/native 29 tests PASS, syntax bốn modules PASS, controls 10/10, CLI integration B/S bốn stages/22 commands PASS; fresh provider/shell preflight PASS. Actual model/effort hai attempts đúng gpt-6-luna/medium. Frozen source/candidate package source không drift; raw binding, zero writers/leases và session cleanup PASS. Không có artifact lịch sử để tái khẳng định unchanged-file inventory cũ.
Kết quả: round 427b0981-093e-44bb-ac74-aa9e1b41a4b9, hash c50beabc5fe06f422074e5d3669c7530b85227339957bed04d4705f80999d6d0. Smoke B-small attempt 1 REWORK vì incomplete raw failure evidence và artifact bị overwritten. Attempt 2 blocked: total input+output 1023939 vượt guard 1000000 dù weighted 185303 dưới cap 200000; turn interrupted, continuation source claim vẫn absent/null với actualBefore sai, old output có bỏ lửng và một số lỗi mới thiếu ledger. Acceptance hai attempts đều 2/2; partial mechanical audit PASS không thay full smoke/content gate. Scheduler quality_failed; không attempt 3 hoặc invocation S/formal.
Accounting: hai provider invocations, input 1532649/cached 1412480/output 31563/uncached 120169; reasoning 4923 là subset output; monetaryCost=null. Một smoke logical slot đã chạy, zero latest PASS; formal 0/50, baseline B chưa đủ 25 stages. Thresholds null, releasePassed=false; không kết luận hiệu quả S.
Bước tiếp theo: chẩn đoán riêng evidence/rework, full actual output và source-role binding cho continuation; giảm repeated reads làm total input tăng mạnh. Giữ round terminal và raw/assessments; không sửa frozen source, nâng guard hoặc tự mở round tìm PASS. 8.2 chưa done, chưa mở 8.3/9.


Ngày: 19/10/2026 — remediation theo docs/phase8-2-remediation-plan-20261019.md
Trạng thái: P1/P2 triển khai một phần; Phase 8.2 vẫn blocked, không mở 8.3/9.
Thay đổi: host path/env/budget/model policy, cohort pointer plumbing, immutable command/verification primitives và evidence ID/hash lookup; offline test/control/CLI capture và cleanup logs. Kiểm mới: 29/29 tests, controls 10/10, 12 source-role CLI cases trên B/S và hai identities; chưa phải model/native permission proof.
Blockers: AppContainer provisioning chưa có root write proof; agy profile riêng chưa đăng nhập, chưa xác nhận Flash 3.8 High; benchmark agy transport và nhiều checklist P1/P2 còn thiếu. Diagnostics/smoke/formal mới=0, releasePassed=false. Chi tiết/giới hạn: docs/phase8-2-remediation-20261019/reports/remediation-report.md.


Ngày: 19/10/2026 — thử identity có sẵn và agy theo chỉ đạo bổ sung
Kết quả: native sandbox existing-profile probe PASS, không tạo profile/đổi ACL ngoài root; ACL scan 27908 entries zero errors/matches; Node/PowerShell IO/cwd/env và native stop PASS. agy host xác thực, có gemini-3.8-flash-high; agy bên trong AppContainer vẫn yêu cầu sign-in. Tests 33/33 PASS. Không có inference mới; 8.2 vẫn blocked ở auth broker và các gates còn thiếu. Proof là scope cụ thể, chưa phải toàn cohort. Xem docs/phase8-2-remediation-20261019/reports/isolation-agy-retry-report.md.


Ngày: 20/10/2026 — tiếp tục remediation
Kết quả offline: 54/54 tests, 10/10 controls, 12 CLI cases/112 receipts; B/S build độc lập với 12 checks PASS. Shared immutable command/verification helpers, strict raw binding, agy transport component và native grace đã bổ sung; chưa hoàn tất provider scheduler.
Fresh Luna preflight auth/model/effort/quota PASS nhưng confinement FAIL: ba CryptnetUrlCache MetaData timestamps ngoài root thay đổi. Existing-profile canary PASS trước đây không chứng minh strict root confinement. agy native auth vẫn blocked. Không inference/diagnostics/smoke/formal mới; releasePassed=false. Giữ thất bại hậu xử lý và corrected followup, không sửa historical evidence.
Báo cáo: docs/phase8-2-remediation-20261019/reports/continuation-report-20261020.md; bước tiếp theo: chứng minh deny private storage và supported agy auth, rồi mới operational freeze và inference. Phase 8.2 chưa hoàn tất; chưa mở 8.3/9.


Ngày: 20/10/2026 — triển khai ngoại lệ AppContainer private storage theo chỉ đạo người dùng
Policy workspace-and-appcontainer-storage-v1: artifacts/temp do runner ở project; cho phép storage riêng của đúng profile/SID, audit mọi thay đổi, không mở toàn bộ AppData. Gate giữ native boundary/stop và bind workspace/profile; B/S không chia sẻ identity.
Kiểm chứng: 59/59 tests, controls10/10 và syntax7 modules PASS. Fresh Luna preflight luna-pf-038ba3bbcf1c4cfe PASS theo policy mới, ba cache metadata changes được ghi là allowed; strict-root/profile-unchanged vẫn false. Giữ lượt moniker-case mismatch thất bại và toàn bộ lịch sử. Scratch được cleanup; borrowed existing profile được giữ nguyên.
Không inference mới; agy native auth, identity-pool/preflight cho campaign và generic scheduler còn thiếu. Phase8.2 chưa hoàn tất, releasePassed=false. Chi tiết: docs/phase8-2-remediation-20261019/reports/appcontainer-storage-policy-20261020.md


Ngày: 20/10/2026 — tìm phương án agy auth
Fresh non-inference diagnosis agy-auth-cb7d2c2a8ddc4677: same copied binary/home mới models PASS host nhưng sign-in required trong AppContainer; CredReadW target UUID không tồn tại trả1168 host,5 Access denied trong sandbox. Builtin --sandbox models trên host PASS auth, chưa chứng minh command/file containment.
Đề xuất đánh giá trusted host coordinator + builtin terminal sandbox, cần chấp nhận trust-boundary change và kiểm canary/native receipts trước inference; chưa kích hoạt mode này. Giữ nguyên policy/transport hiện hành, không host agent execution/inference, credential copy hoặc API-key/ADC fallback. Scope audit39322 entries zero matches/errors; native stop/cleanup PASS. Chi tiết docs/phase8-2-remediation-20261019/reports/agy-auth-options-20261020.md


Ngày: 20/10/2026 — người dùng cho phép trusted host coordinator + builtin sandbox cho agy
Đã thêm WindowsHostJob riêng, settings/argv và gated builtin transport; không dùng dangerously-skip-permissions, không mở host-run qua WindowsSandbox. Tests65/65 PASS; native Job lifecycle/auth/model list PASS, empty stream init đúng Flash3.8High/proceed-in-sandbox, native AppContainer regression PASS.
Agy normalize settings và bỏ hai optional keys; generator chỉ giữ supported keys, so semantic hash để nhận formatting-only changes. No-paid-fallback hiệu lực chưa có proof. Empty stream/hook injection không chạy tool; command/file/native sandbox proof thiếu nên preflight/campaign vẫn blocked. Không model turn/inference mới hoặc tự nới gate. Full source/raw/cleanup và giới hạn tại docs/phase8-2-remediation-20261019/reports/agy-builtin-implementation-20261020.md


Ngày: 20/10/2026 — thu hẹp Phase 8.2 theo chỉ đạo người dùng
Scope hiện hành: chỉ gpt-6-luna/medium cho B/S; tạm hoãn toàn bộ suite/probe/diagnostics/smoke/formal riêng agy. Agy giữ deferred/out-of-scope, không chặn nghiệm thu Luna và không tính vào mẫu số; giữ nguyên code/evidence/pointers/verdict lịch sử.
Schedule Luna:6 smoke +50 formal logical slots, tối đa2 attempts/slot, baseline B đo mới25 stages. Giữ unbounded, watchdog60phút+grace60giây, quality/audit/review và năm thresholds. Trước chạy cần selectors/CLI profile chỉ Codex/Luna, native proof/identity cho từng workspace và freeze mới; chưa chạy test hoặc model trong đợt sửa plan.
Plan hiện hành: docs/phase8-2-remediation-plan-20261019.md. Phase8.2 chưa hoàn tất chỉ vì scope đã giảm; Luna vẫn phải đạt đủ gates. Tái đưa agy vào test cần chỉ đạo mới.
