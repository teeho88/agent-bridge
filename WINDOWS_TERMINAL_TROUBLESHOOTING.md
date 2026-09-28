# Khắc phục lỗi thiếu `wt.exe` khi mở Agent CLI

## Hiện tượng

Khi nhấn **Open Agent CLI** trong Work Board, giao diện báo:

```text
Open failed: Windows Terminal (wt.exe) is required to open a visible agent terminal.
```

Work Board dùng Windows Terminal (`wt.exe`) để tạo cửa sổ PowerShell hiển thị phiên Agent CLI. Lỗi xuất hiện khi Windows Terminal chưa được cài đặt hoặc tiến trình Agent Bridge không tìm thấy `wt.exe` trong `PATH`.

## 1. Kiểm tra `wt.exe`

Mở PowerShell và chạy:

```powershell
where.exe wt.exe
Get-Command wt.exe -ErrorAction SilentlyContinue
```

Nếu một trong hai lệnh trả về đường dẫn tới `wt.exe`, chuyển tới bước 4. Nếu không có kết quả, tiếp tục bước 2.

## 2. Cài Windows Terminal

Cài bằng `winget`:

```powershell
winget install --id Microsoft.WindowsTerminal --exact --source winget
```

Hoặc mở Microsoft Store, tìm **Windows Terminal** của Microsoft và chọn **Install**.

Sau khi cài xong, đóng toàn bộ cửa sổ PowerShell đang mở rồi mở một cửa sổ mới.

## 3. Sửa `PATH` nếu Windows Terminal đã được cài

Thông thường, alias `wt.exe` nằm trong thư mục:

```text
%LOCALAPPDATA%\Microsoft\WindowsApps
```

Kiểm tra thư mục và giá trị `PATH` của người dùng:

```powershell
Test-Path "$env:LOCALAPPDATA\Microsoft\WindowsApps\wt.exe"
[Environment]::GetEnvironmentVariable("Path", "User") -split ";"
```

Nếu thư mục `Microsoft\WindowsApps` chưa có trong `PATH` người dùng:

1. Mở **Settings** và tìm **Environment Variables**.
2. Chọn **Environment Variables...**.
3. Trong **User variables**, sửa biến `Path`.
4. Thêm `%LOCALAPPDATA%\Microsoft\WindowsApps`.
5. Lưu thay đổi và mở lại PowerShell.

Nếu file tồn tại nhưng lệnh vẫn không được nhận diện, mở **Settings > Apps > Advanced app settings > App execution aliases** và bảo đảm alias của Windows Terminal đang bật.

Không sao chép thủ công `wt.exe` sang thư mục khác vì đây là alias do Windows quản lý.

## 4. Xác nhận và khởi động lại Agent Bridge

Trong một cửa sổ PowerShell mới, chạy lại:

```powershell
where.exe wt.exe
Get-Command wt.exe
```

Sau đó:

1. Dừng tiến trình Agent Bridge/Work Board đang chạy.
2. Mở PowerShell mới để tiến trình nhận `PATH` mới.
3. Khởi động lại Work Board bằng lệnh bạn vẫn dùng.
4. Tải lại trang Work Board và nhấn **Open Agent CLI**.

Kết quả đúng là một cửa sổ Windows Terminal mới mở tại thư mục dự án và chạy Agent CLI đã chọn.

## Nếu lỗi vẫn còn

Thu thập kết quả của các lệnh sau để chẩn đoán:

```powershell
$PSVersionTable.PSVersion
where.exe wt.exe
Get-Command wt.exe -ErrorAction SilentlyContinue | Format-List Name,Source,CommandType
$env:PATH -split ";" | Where-Object { $_ -like "*WindowsApps*" }
```

Nếu `where.exe wt.exe` chạy được trong PowerShell mới nhưng Work Board vẫn báo lỗi, Agent Bridge nhiều khả năng vẫn là tiến trình cũ. Hãy đóng hoàn toàn tiến trình đó rồi khởi động lại từ chính cửa sổ PowerShell vừa kiểm tra thành công.
