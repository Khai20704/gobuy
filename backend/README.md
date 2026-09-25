# Proposal API

Từ root chạy `npm run dev:backend`; hoặc tại backend chạy `npm run dev`.
GET /api/health và POST /api/proposals/search. Request gồm text, image tùy chọn (mimeType + base64), scenario.
Request JSON tối đa 3 MiB, text 2000 ký tự, ảnh 2 MiB và kiểm tra MIME magic bytes.
Zod strict schemas từ @gobuy/shared. Không lưu request/image, không log body hoặc trả stack trace.
MockLLMProvider/MockMarketplaceAdapter hoạt động mặc định, không cần API key.
Không có ví backend, authorize endpoint, marketplace transaction hoặc mandate database.
Xem README gốc để chạy tests và cấu hình.
