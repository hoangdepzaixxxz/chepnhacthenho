# Chép Nhạc Thẻ Nhớ

Ứng dụng Windows có giao diện để tải Video 720p hoặc Voice MP3 từ danh sách link YouTube.

## Chạy và tạo bộ cài

```powershell
npm start
npm run build:exe
```

Bộ cài nằm tại `dist-desktop\Chep Nhac The Nho Setup <version>.exe`. Cài bộ này, không dùng thư mục `win-unpacked` để phát hành.

## Bật nút cập nhật

Nút cập nhật tải installer mới từ GitHub Releases. Sau khi cài app lần đầu, mở file `update-config.json` cạnh file EXE và thay bằng:

```json
{
  "url": "https://github.com/TEN-TAI-KHOAN/TEN-REPO/releases/latest/download"
}
```

Repository phải public (hoặc phải có một máy chủ HTTPS công khai tương đương) để app không cần lưu mật khẩu GitHub của người dùng. Mỗi lần có code mới:

1. Tăng phiên bản bằng cách tạo tag, ví dụ `v1.2.0`.
2. Push tag lên GitHub: `git push origin v1.2.0`.
3. Workflow `.github/workflows/release.yml` sẽ tự build installer, tạo `latest.yml` và đưa chúng vào GitHub Release.
4. Người dùng mở EXE, bấm **Kiểm tra cập nhật**, rồi **Cài và khởi động lại**.

Như vậy người dùng không phải build hay tải EXE thủ công. Mỗi thay đổi vẫn cần một phiên bản phát hành mới: phần code được đóng gói trong installer và cần được thay thế an toàn khi cập nhật.
