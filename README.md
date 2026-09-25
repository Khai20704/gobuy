# GoBuy — Na authority workspace

Đọc [flow và bản đồ file](docs/PROJECT_MAP.md) trước nếu bạn muốn hiểu từng phần và cách kết nối ví.

MVP gồm frontend React/Vite, proposal API Express, contracts dùng chung và source Anchor.
**Chưa deploy Devnet.** Program ID frontend mặc định để trống; app chạy bằng mock adapters qua API.
Không có API key hoặc ví backend. Không mua tài sản, swap, escrow hay chuyển token.

## Chạy trên Windows PowerShell

Mở đúng repository hiện có (không tạo thêm thư mục `gobuy`):

```powershell
Set-Location C:\Users\khait\OneDrive\Desktop\Gobuy\gobuy
npm ci
```

Cần Node.js 22.18+ hoặc 24+. Trong hai terminal tại root repository:

```powershell
# Terminal 1 — backend
npm run dev:backend
# http://127.0.0.1:3001/api/health
```

```powershell
# Terminal 2 — frontend
npm run dev
# http://localhost:5173/na
```

Có thể chạy trực tiếp `npm run dev -w backend` / `npm run dev -w frontend`.
Vite proxy `/api` tới cổng 3001; nếu đổi PORT phải sửa proxy trong `frontend/vite.config.ts`.
Production build: `npm run build`; API: `npm start -w backend`; xem frontend: `npm run preview -w frontend`.
Khi tự host, cấu hình SPA fallback về index.html và reverse proxy /api tới backend.

## Demo sử dụng

1. Mở Talk to Na; nhập yêu cầu và tùy chọn đính kèm PNG/JPEG/WebP tối đa 2 MiB.
2. Chọn scenario: within budget / over budget / thiếu seller claim / marketplace khác / RWA.
3. Backend trả proposal có UUID, giá là chuỗi integer lamports, expiry 10 phút, evidence và metadata demo.
4. Bảng bên phải là **local rule preview**, không phải on-chain authorization.
5. Record demo rule preview tạo lịch sử session với hash, version và reason; không có signature giả.
6. My mandate chỉnh boundaries demo hoặc ký initialize/update khi kết nối một program Devnet thực tế.
7. Khi có mandate Devnet: Send proposal to Na → Phantom ký → RPC Devnet xác nhận → đọc ActionRecord → hiển thị APPROVED/REJECTED và Explorer.

MockLLMProvider và MockMarketplaceAdapter **không phân tích nội dung text/ảnh**. Scenario chọn fixture.
Ảnh/text chỉ ở bộ nhớ session/request, không lưu server hoặc localStorage; không đưa lên chain.
RWA chỉ hiển thị dữ liệu và luôn bị rule on-chain từ chối.
Kết nối Phantom chỉ xin public address và hoạt động độc lập với program deployment. Khi thiếu extension, UI hiển thị các bước cài/bật trong đúng Chrome profile. Có ví trên điện thoại không đủ để kết nối Chrome desktop bằng nút hiện tại.
Phantom ký mọi lệnh; autonomy là một hard constraint, không phải quyền bỏ qua bước ký của ví.

## Kiến trúc và ranh giới tin cậy

- `frontend/src/features/na/`: workspace, mandate form, authority panel, activity và state hook.
- `frontend/src/services/api/`: proposal client, kiểm tra response bằng Zod.
- `frontend/src/services/solana/`: Phantom, Anchor client, Devnet guard, confirmation, Explorer links.
- `backend/src/http/` → `application/` → `adapters/`: chỉ discovery/chuẩn hóa.
- `shared/src/`: schemas, binary canonicalization, rule preview **không có thẩm quyền**.
- `anchor/programs/gobuy_na/src/`: state, owner constraints, canonical hash, deterministic rules.
- Không có endpoint authorize hoặc endpoint lưu mandate ở backend. Program account là nguồn mandate.
- Chỉ tạo/cập nhật mandate và audit account. Phí transaction/rent dùng **Devnet SOL**.
- Giá, asset ID và seller claim do adapter cung cấp; người gửi có thể cung cấp dữ liệu ngoài chain không đúng.
  Program chỉ kiểm tra fields so với policy, **không chứng thực marketplace, seller, quyền sở hữu hay giá ngoài đời**.
- Không có oracle/attestation, tổng ngân sách tích lũy hoặc quyền mua tài sản trong MVP này.

## Biến môi trường

Chỉ copy khi tệp đích chưa tồn tại, giữ nguyên cấu hình cá nhân đang dùng:

```powershell
if (!(Test-Path frontend/.env.local)) { Copy-Item frontend/.env.example frontend/.env.local }
if (!(Test-Path backend/.env)) { Copy-Item backend/.env.example backend/.env }
```

| Workspace | Biến | Mặc định / ý nghĩa |
| --- | --- | --- |
| frontend | VITE_SOLANA_PROGRAM_ID | trống; public ID của program đã deploy thật |
| frontend | VITE_SOLANA_RPC_URL | https://api.devnet.solana.com; kiểm tra genesis hash trước khi ký |
| frontend | VITE_ANCHOR_IDL_URL | /idl/gobuy_na.json; IDL tạo bởi Anchor build |
| backend | HOST | 127.0.0.1 |
| backend | PORT | 3001 |
| integration tests | GOBUY_RUN_DEVNET_TESTS | chỉ chạy khi bằng 1 |
| integration tests | SOLANA_DEVNET_RPC_URL | public Devnet RPC; genesis guard bắt buộc |

Restart Vite sau khi đổi env. Không đặt secrets trong biến VITE_ vì chúng công khai trong browser.
Mock mode không cần env, API key, program ID hoặc ví. Kết nối RPC/program/IDL lỗi sẽ hiện setup message, không dựng verdict.

## Kiểm thử

```powershell
npm run build
npm run lint
npm test
# Edge đã cài trên Windows, chạy headless
$env:PLAYWRIGHT_CHANNEL = "msedge"
npm run test:e2e
```

Nếu dùng Chromium do Playwright quản lý: `npx playwright install chromium`, bỏ biến PLAYWRIGHT_CHANNEL.
`lint` hiện là strict TypeScript checking (repo ban đầu không có ESLint).
Node tests kiểm tra API, giới hạn input/ảnh, hash/precision, Devnet guard và confirmation.
Playwright khởi chạy frontend/backend để kiểm thử request, image, mandate, demo audit, lỗi API, mobile và Phantom stub (thiếu deployment / từ chối kết nối). Phantom stub tests không phải giao dịch ví thật.
Xem [anchor/README.md](anchor/README.md) để build/deploy/test program thật.

## Trạng thái kiểm chứng thực tế

- Build TypeScript/Vite và strict TypeScript cho cả source/tests đã qua; 16/16 Node tests và 6/6 Playwright tests (Edge headless) đã qua, gồm kết nối/ngắt ví không cần deployment, thiếu extension và provider được nạp trễ.
- Cargo test đã được thử nhưng môi trường Windows thiếu MSVC linker `link.exe`.
- Không có Anchor CLI, Solana CLI hoặc WSL trong môi trường hiện tại.
- Chưa build SBF, chưa tạo IDL từ Rust, chưa deploy, chưa ký giao dịch Phantom thật và chưa chạy integration tests trên Devnet.
- `11111111111111111111111111111111` trong Rust/Anchor.toml là sentinel chưa cấu hình, **không phải GoBuy Program ID**; frontend từ chối giá trị này.
- `npm run test:anchor` bỏ qua suite nếu không bật GOBUY_RUN_DEVNET_TESTS; skip không phải test pass.
- Audit dependency còn cảnh báo transitive từ SDK Anchor/web3 (toml, jayson/stream-json/uuid). Không dùng `npm audit fix --force` vì npm đề xuất downgrade SDK không tương thích. React Router đã được nâng lên bản vá. Các parser TOML/stream không nhận dữ liệu người dùng trong ứng dụng này; đây vẫn là hạn chế cần rà soát trước triển khai ngoài demo.

Tài liệu API đã đối chiếu: [Anchor TypeScript client](https://www.anchor-lang.com/docs/clients/typescript),
[Anchor 1.2.0](https://www.anchor-lang.com/docs/updates/release-notes/1-2-0),
[Phantom transactions](https://docs.phantom.com/solana/sending-a-transaction).
