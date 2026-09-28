# Kế hoạch: cập nhật Agent Bridge từ Git và thông báo phiên bản trên UI

## Mục tiêu

Thêm cơ chế để bản Agent Bridge được cài từ source checkout có thể:

- kiểm tra bản phát hành mới từ remote Git;
- so sánh phiên bản đang chạy với phiên bản mới nhất;
- hiển thị thông báo cập nhật rõ ràng trên Work Board;
- cho phép người dùng chủ động cập nhật, build lại và khởi động lại UI;
- từ chối cập nhật khi trạng thái Git không an toàn và phục hồi bản cũ nếu build bản mới thất bại.

## Hiện trạng

- Agent Bridge được cài trên Windows bằng cách clone repository, cài dependency, build monorepo và tạo wrapper trong `bin/` trỏ tới `packages/cli/dist/index.js`.
- `agent-bridge upgrade` hiện chỉ làm mới managed section, Claude hooks và Antigravity hooks của một workspace. Lệnh này không cập nhật source checkout của Agent Bridge.
- Phiên bản `0.1.0` đang được lặp lại trong root package, bốn package con và hard-code trong `packages/cli/src/index.ts`.
- Repository chưa có Git tag phát hành.
- Work Board polling `/api/state` mỗi 2 giây và đã có toast stack, nhưng chưa có trạng thái hay UI dành cho cập nhật ứng dụng.
- Workspace đang được hiển thị trên Work Board có thể khác repository cài Agent Bridge. Cơ chế cập nhật phải thao tác trên installation root, không thao tác trên workspace hiện tại.

## Quyết định thiết kế

### 1. Phân biệt `update` và `upgrade`

- Thêm `agent-bridge update` để kiểm tra hoặc cập nhật chính Agent Bridge từ Git.
- Giữ nguyên `agent-bridge upgrade` để làm mới tích hợp trong workspace, bảo toàn tương thích ngược.
- UI gọi cùng service mà lệnh `update` sử dụng; không nhân bản logic Git trong route hoặc client.

### 2. Chỉ phát hành phiên bản có tag

- Dùng Semantic Versioning với tag dạng `vMAJOR.MINOR.PATCH`.
- Một bản cập nhật chỉ được công bố khi version trong các `package.json` khớp tag.
- Commit mới trên `main` nhưng chưa có tag được xem là chưa phát hành và không tạo thông báo cập nhật.
- `PATCH` dành cho sửa lỗi tương thích, `MINOR` cho tính năng tương thích, `MAJOR` cho thay đổi phá vỡ tương thích.
- Bản prerelease như `v0.2.0-beta.1` không xuất hiện ở kênh stable; có thể bổ sung kênh prerelease sau.

### 3. Một nguồn phiên bản duy nhất

- Root `package.json` là nguồn version chuẩn.
- Thêm script release để cập nhật đồng bộ root package và bốn package con, đồng thời kiểm tra lockfile.
- CLI lấy version từ module version dùng chung hoặc package metadata trong build, không giữ chuỗi hard-code trong `index.ts`.
- Release command phải từ chối tạo tag nếu working tree bẩn, version không đồng bộ, build/test thất bại hoặc tag đã tồn tại.

### 4. Kiểm tra cập nhật không nằm trong polling 2 giây

- Tạo endpoint riêng `GET /api/update/status`.
- Lần kiểm tra mạng chạy khi UI mở, khi người dùng bấm kiểm tra lại và theo chu kỳ 30 phút.
- Server cache kết quả tối thiểu 15 phút để nhiều tab không liên tục chạy `git fetch`.
- `/api/state` chỉ trả trạng thái update đã cache nếu UI cần render chung; nó không được tự gọi mạng.
- Lỗi mạng không làm `/api/state` hoặc Work Board lỗi. UI giữ trạng thái hiện tại và hiển thị lần kiểm tra gần nhất.

### 5. Người dùng chủ động áp dụng cập nhật

- Không tự động sửa checkout chỉ vì phát hiện phiên bản mới.
- Banner có nút `Update now`; thao tác này gọi `POST /api/update/apply`.
- CLI hỗ trợ `agent-bridge update --check`, `agent-bridge update --apply` và `--json` cho automation.
- Trước khi apply, server trả preflight cụ thể để UI giải thích vì sao có thể hoặc chưa thể cập nhật.

## Mô hình trạng thái

Service trả một payload ổn định:

```ts
interface ApplicationUpdateStatus {
  installationMode: "git-source" | "unsupported";
  state:
    | "checking"
    | "current"
    | "available"
    | "updating"
    | "restart-required"
    | "dirty"
    | "diverged"
    | "offline"
    | "failed"
    | "unsupported";
  currentVersion: string;
  currentCommit?: string;
  latestVersion?: string;
  latestTag?: string;
  latestCommit?: string;
  releaseNotes?: string[];
  checkedAt?: string;
  canApply: boolean;
  reason?: string;
}
```

Quy tắc chính:

- `current`: không có tag stable mới hơn.
- `available`: có tag SemVer mới hơn và commit của tag nằm trên nhánh remote được theo dõi.
- `dirty`: source checkout có thay đổi tracked hoặc untracked; không apply.
- `diverged`: checkout có local commit, sai branch, detached HEAD hoặc không thể fast-forward tới release; không apply.
- `offline`: fetch timeout hoặc remote không truy cập được; tiếp tục chạy bản hiện tại.
- `unsupported`: CLI không chạy từ Git source checkout, ví dụ một package được đóng gói theo cách khác.

## Luồng kiểm tra cập nhật

1. Xác định installation root từ vị trí module CLI đang chạy; không dùng `process.cwd()` làm source root.
2. Đọc current version và current commit.
3. Xác định remote/branch theo upstream của checkout, ưu tiên `origin/main` khi upstream chưa được cấu hình.
4. Chạy Git bằng `execFile` với mảng tham số, timeout và giới hạn output; không dùng shell command ghép chuỗi.
5. Fetch tag và remote ref cần thiết.
6. Lọc tag stable hợp lệ, chọn SemVer cao nhất và xác nhận tag commit thuộc remote release branch.
7. Đọc version tại tag và yêu cầu nó khớp tên tag.
8. So sánh current version với latest version, tạo release notes ngắn từ commit subject giữa hai tag và cache kết quả.

## Luồng áp dụng cập nhật

### Preflight

Chỉ cho phép apply khi:

- installation mode là `git-source`;
- có phiên bản mới;
- working tree của installation root sạch;
- HEAD nằm trên branch được theo dõi;
- target release là fast-forward của HEAD;
- không có update khác đang chạy;
- không có orchestration/agent run đang hoạt động nếu việc restart UI có thể làm gián đoạn điều phối;
- Node, Corepack và pnpm dùng được.

### Update worker

`POST /api/update/apply` khởi chạy một worker tách khỏi process UI để request hiện tại có thể trả kết quả trước khi server dừng. Worker nhận installation root, workspace, port, old commit và target tag, sau đó:

1. ghi progress vào file trạng thái dưới `.agent-memory/update/` của installation root;
2. fetch chính xác target tag;
3. fast-forward branch tới target commit;
4. chạy `corepack pnpm install --frozen-lockfile`;
5. chạy `corepack pnpm -r build`;
6. smoke-test `node packages/cli/dist/index.js --version` và yêu cầu version khớp target tag;
7. khởi động lại Work Board với workspace và port cũ;
8. ghi kết quả thành công để UI mới hiển thị.

Nếu install, build hoặc smoke-test thất bại, worker chỉ rollback khi preflight đã xác nhận checkout sạch. Nó đưa branch về đúng `old commit`, khôi phục dependency/build của phiên bản cũ, ghi log lỗi và khởi động lại UI cũ. Log phải chỉ rõ bước lỗi và đường dẫn file log; không xóa dữ liệu workspace.

Process update cần lock file để CLI và nhiều tab UI không thể chạy hai update đồng thời.

## Thiết kế UI

### Banner cố định

Thêm update banner gần header chung của Work Board:

- Ẩn khi trạng thái là `current`.
- Khi `available`, hiển thị `Agent Bridge 0.1.0 → 0.2.0`, release notes ngắn, `Update now` và `Later`.
- Khi `dirty` hoặc `diverged`, hiển thị lý do và command chẩn đoán; không render nút apply đang hoạt động.
- Khi `updating`, hiển thị bước hiện tại và khóa thao tác lặp.
- Khi `restart-required`, thông báo UI sẽ kết nối lại; client retry status sau khi server khởi động.
- Khi `failed`, hiển thị lỗi tóm tắt và link/nút mở phần log trong UI.

### Thông báo một lần

- Khi phát hiện version mới, tạo toast một lần cho mỗi `latestVersion`.
- Lưu version đã thông báo trong `localStorage` để polling hoặc reload không tạo toast lặp.
- Dismiss banner chỉ ẩn version đó trên trình duyệt hiện tại; nút `Check for updates` trong khu vực Tools/Settings vẫn truy cập được.
- Không dùng `alert()` cho luồng update.

### Khả năng truy cập

- Banner dùng `role="status"`; lỗi apply dùng `role="alert"`.
- Nút có trạng thái disabled và text progress rõ ràng.
- Không chỉ dùng màu để phân biệt available, blocked và failed.

## API và module dự kiến

### Service dùng chung

Thêm module dưới CLI, ví dụ `packages/cli/src/application-update.ts`, chịu trách nhiệm:

- tìm installation root;
- đọc và so sánh SemVer;
- chạy Git an toàn;
- kiểm tra preflight;
- cache status;
- khởi chạy update worker.

Tách update worker thành script/module riêng để có thể test command construction mà không thực sự sửa repository.

### CLI

- `packages/cli/src/commands/update.ts`: đăng ký `agent-bridge update`.
- `packages/cli/src/index.ts`: dùng version chuẩn và đăng ký command mới.
- `packages/cli/src/commands/upgrade.ts`: giữ nguyên hành vi hiện tại.

### HTTP routes

- `GET /api/update/status`: trả cache; query `refresh=1` buộc kiểm tra mới nếu không có check đang chạy.
- `POST /api/update/apply`: chạy preflight, trả `409` cùng status nếu bị chặn, hoặc `202` với update id nếu worker đã bắt đầu.
- `GET /api/update/progress`: trả bước, thời gian và lỗi của worker để client theo dõi qua polling.

Các route đặt trong module riêng và được đăng ký trong route table hiện tại. Không đặt network fetch trực tiếp vào `routeGetState`.

### Release tooling

Thêm script như `scripts/release-version.mjs` và npm scripts:

- `release:check`: xác minh mọi package version đồng bộ, build/test pass và tag chưa tồn tại;
- `release:version -- <major|minor|patch|x.y.z>`: cập nhật version và lockfile;
- việc push commit/tag vẫn là thao tác phát hành có chủ đích của maintainer.

## Các giai đoạn triển khai

### Giai đoạn 1: chuẩn hóa version

1. Chọn root `package.json` làm nguồn chuẩn.
2. Đồng bộ version package con và lockfile.
3. Bỏ version hard-code khỏi CLI.
4. Thêm validator và tài liệu quy trình tạo tag release đầu tiên.

Kết quả: `agent-bridge --version`, package metadata và Git tag luôn thống nhất.

### Giai đoạn 2: update service và CLI

1. Cài parser/comparator SemVer đủ cho stable tags mà không phụ thuộc shell.
2. Thêm detection, fetch, status cache và preflight.
3. Thêm `agent-bridge update --check/--apply/--json`.
4. Thêm worker, lock, progress log, restart và rollback.

Kết quả: cập nhật được kiểm tra và áp dụng hoàn toàn từ CLI trước khi nối UI.

### Giai đoạn 3: routes và UI notification

1. Thêm ba update routes.
2. Thêm banner, toast một lần, nút check/apply và progress state.
3. Thêm reconnect flow sau restart.
4. Bổ sung update status vào fingerprint riêng của UI để render đúng mà không làm toàn bộ dashboard rerender không cần thiết.

Kết quả: người dùng thấy và áp dụng phiên bản mới trực tiếp từ Work Board.

### Giai đoạn 4: release và tài liệu vận hành

1. Tạo tag đầu tiên theo version hiện tại sau khi validation pass.
2. Ghi hướng dẫn release, update, xử lý dirty/diverged và rollback trong README.
3. Kiểm thử end-to-end bằng một bare remote Git tạm, không dùng repository thật làm fixture.

## Kiểm thử

### Unit tests

- chọn đúng tag stable cao nhất và bỏ qua malformed/prerelease tag;
- so sánh current/latest version;
- phát hiện installation root khác workspace root;
- phân loại clean, dirty, detached và diverged checkout;
- xác minh target tag thuộc remote branch và version trong tag khớp;
- cache, timeout, offline và concurrent check;
- command args không qua shell và không nhận ref tùy ý từ client;
- update lock ngăn hai worker chạy đồng thời.

### Route tests

- status route trả đầy đủ payload ở trạng thái current/available/blocked/offline;
- apply trả `202` khi preflight pass;
- apply trả `409` và lý do cụ thể khi dirty, diverged hoặc có run đang hoạt động;
- progress route không lộ nội dung log hoặc path ngoài phạm vi cho phép;
- lỗi check update không làm `/api/state` thất bại.

### UI tests

- banner chỉ xuất hiện khi cần;
- toast chỉ xuất hiện một lần cho mỗi version;
- nút apply disabled đúng theo `canApply`;
- progress và reconnect render đúng;
- dismiss không ngăn manual check;
- nội dung version được escape trước khi render.

### Integration tests

Tạo source repo và bare remote trong thư mục temp, sau đó kiểm tra:

1. checkout ở `v0.1.0` phát hiện `v0.2.0`;
2. fast-forward update thành công và CLI báo `0.2.0`;
3. dirty checkout bị từ chối mà file người dùng không đổi;
4. local commit/divergence bị từ chối;
5. build giả lập thất bại kích hoạt rollback về exact old commit;
6. remote offline giữ ứng dụng hoạt động;
7. worker restart server với đúng workspace và port.

## Tiêu chí hoàn thành

- Maintainer có quy trình tạo version/tag nhất quán và tự kiểm tra được.
- `agent-bridge --version` khớp package version và release tag.
- CLI phát hiện version mới từ remote mà không phụ thuộc workspace hiện tại.
- Work Board hiển thị banner và toast khi có release mới, không spam theo polling.
- Người dùng có thể chủ động apply update từ CLI hoặc UI.
- Checkout dirty, detached hoặc diverged không bị thay đổi.
- Update lỗi phục hồi được bản cũ và giữ nguyên dữ liệu `.agent-memory` của workspace.
- Các unit, route, UI và integration tests nêu trên đều pass; monorepo build thành công.

## Ngoài phạm vi phiên bản đầu

- cập nhật nền không cần xác nhận;
- kênh nightly hoặc cập nhật theo từng commit chưa gắn tag;
- package registry/npm update;
- auto-update trên macOS/Linux trước khi worker/restart flow được kiểm chứng trên Windows;
- bắt buộc signed tag; có thể bổ sung khi quy trình ký release được thiết lập.
