# Na frontend

React + TypeScript + Vite; giữ nhận diện GoBuy, routes /na, /na/mandate, /na/activity.
Từ root chạy `npm run dev`; tại frontend chạy `npm run dev`.
Cần backend đang chạy trên cổng 3001 cho discovery demo. Không fallback giả khi API lỗi.
.env.example mô tả public Devnet config. Thiếu program/IDL thì vẫn dùng demo preview.
Phantom ký phía browser; Anchor client tải khi connect. Không lưu wallet secrets.
Xem README gốc và anchor/README.md để build/test/deploy.
