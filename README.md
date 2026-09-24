# GoBuy — Na workspace

## Chạy trong VS Code

Cần Node.js 22 hoặc 24 và npm. Mở thư mục chứa package.json gốc:

```sh
npm install
npm run dev
```

Mở URL terminal hiển thị. App tự chuyển tới /na.

```sh
npm run build
```

## Bản này đã có
- Giao diện Na: hội thoại, đính kèm ảnh (PNG/JPEG/WebP, tối đa 5 MB).
- Chỉnh giới hạn mandate, quyền tự động, yêu cầu nguồn xác minh.
- Đề xuất cố định từ demo adapter; kiểm tra rule cục bộ và lịch sử trong session.
- Hai scenario: trong giới hạn và vượt giới hạn.
- Responsive layout, strict TypeScript, npm workspaces và lockfile.

## Giới hạn
Đây là frontend prototype. Agent chưa đọc hiểu tin nhắn/ảnh. Không có kết nối Phantom, live marketplace, backend, AI, Anchor hay giao dịch. Các đơn vị demo không phải tiền. Làm mới trang sẽ xóa dữ liệu session. Không tạo tx hash giả.

## Design pattern
- Feature-first: frontend/src/features/na
- Presentation: NaWorkspacePage và components/AuthorityPanel.
- Domain: domain/types.ts gồm contracts và hàm evaluate thuần.
- Adapter: services/demoAgent.ts; thay bằng adapter thật khi triển khai backend.
- Composition: app/App.tsx chỉ quản lý routing.
- Backend/Anchor/shared là scaffolding dành cho các phase tiếp theo, chưa chạy.

Không đặt business rule hoặc API key trong CSS/UI. Hàm evaluate chỉ minh họa phản hồi giao diện; không là cơ chế bảo mật. Enforcement thực tế cần chương trình on-chain và bằng chứng nguồn hợp lệ.
