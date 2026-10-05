# GoBuy — Na asset acquisition

Na Vault now replaces the old signed spending policy. The owner funds a Devnet PDA once; a designated agent can settle SOL within on-chain budget/expiry/category/recipient limits. Revoke and reclaim are owner-signed. This demo does not autonomously acquire NFTs/RWAs; marketplace buys still require their own Phantom transaction. See [Na Vault setup, tests and execution limits](docs/DELEGATED_SPENDING.md). A new program deployment is required; the committed program ID is a placeholder.

The active chat discovers NFT marketplace listings by theme and SOL budget, then offers an explicitly labeled **Devnet simulation** and tracks the representation in **My Assets**. Phantom ownership is verified by a signed challenge. Embedded-wallet integration remains pending; Mainnet execution is disabled. Start with the [current architecture, configuration, local flow and limitations](docs/ASSET_ACQUISITION.md).

Default discovery is `NFT_DISCOVERY_MODE=marketplace`. The generated four-item gallery is only available with explicit `NFT_DISCOVERY_MODE=mock`. There is no automatic mock fallback.

The active Na page now requires an account, verified phone and delivery profile. Run `npm run dev:auth` for a local Firebase Auth Emulator demo (no real SMS), or configure real Firebase and use `npm run dev`. See [account setup and testing](docs/ACCOUNTS.md).

The following describes retained legacy research/authority components, not the active NFT chat. See the
[research implementation and setup guide](docs/NA_RESEARCH.md) for providers, environment variables,
Commerce Twin persistence, evidence/ranking rules, API contracts and the file inventory.
Product research is the default chat mode. Select **Authority demo** for the original scenarios and image-upload demo.
Na compares offers internally and selects one best fit, or reports insufficient evidence. Missing search credentials never enable fixtures; synthetic data requires explicit `SEARCH_PROVIDER_MODE=mock`. Live intent/explanations use a provider-independent router with OpenAI, Anthropic, Gemini, Groq and optional local Ollama. A limited deterministic parser and structured search remain available when all LLMs fail. Live search never silently uses fixtures. See [LLM failover and configuration](docs/NA_LLM_ROUTER.md).
Approving a research card saves a preference and hands the selected item to **Your authority** for review.
The current Devnet contract supports its existing demo assets only; live/physical products remain blocked at the review boundary.

Đọc [flow và bản đồ file](docs/PROJECT_MAP.md) trước nếu bạn muốn hiểu từng phần và cách kết nối ví.

MVP gồm frontend React/Vite, proposal API Express, contracts dùng chung và source Anchor.
**Chưa deploy Devnet.** Program ID frontend mặc định để trống; app chạy bằng mock adapters qua API.
Research API keys are optional and server-only. Không có ví backend. Không mua tài sản, swap, escrow hay chuyển token.

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

1. Mở Talk to Na; chọn **Authority demo**, nhập yêu cầu và tùy chọn đính kèm PNG/JPEG/WebP tối đa 2 MiB.
2. Chọn scenario: within budget / over budget / thiếu seller claim / marketplace khác / RWA.
3. Backend trả proposal có UUID, giá là chuỗi integer lamports, expiry 10 phút, evidence và metadata demo.
4. Bảng bên phải là **local rule preview**, không phải on-chain authorization.
5. Record demo rule preview tạo lịch sử session với hash, version và reason; không có signature giả.
6. My mandate chỉnh boundaries demo hoặc ký initialize/update khi kết nối một program Devnet thực tế.
7. Khi có mandate Devnet: Send proposal to Na → Phantom ký → RPC Devnet xác nhận → đọc ActionRecord → hiển thị APPROVED/REJECTED và Explorer.

In Authority demo, MockLLMProvider và MockMarketplaceAdapter **không phân tích nội dung text/ảnh**. Scenario chọn fixture.
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
- `/api/mandate` dựng và gửi giao dịch chủ ví đã ký; program account là nguồn ngân sách và trạng thái mandate.
- Vault nhận ngân sách được cấp, giới hạn tổng chi tích lũy và trả số dư khi thu hồi/rút. Phí transaction/rent dùng **Devnet SOL**.
- Giá, asset ID và seller claim do adapter cung cấp; người gửi có thể cung cấp dữ liệu ngoài chain không đúng.
  Program chỉ kiểm tra fields so với policy, **không chứng thực marketplace, seller, quyền sở hữu hay giá ngoài đời**.
- Chưa có oracle/attestation hoặc CPI mua tài sản từ vault; demo vault chỉ chuyển SOL tới địa chỉ đã ủy quyền.

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

- Build TypeScript/Vite và strict TypeScript cho cả source/tests đã qua; 39/39 Node tests và 9/9 Playwright tests (Edge headless) đã qua. Coverage includes single-product selection, required evidence, price/website/review assessment, persistent Twin decisions, mobile cards, existing demos, and Phantom connection stubs. Provider tests use fixtures; live credentials have not been validated.
- Cargo test đã được thử nhưng môi trường Windows thiếu MSVC linker `link.exe`.
- Không có Anchor CLI, Solana CLI hoặc WSL trong môi trường hiện tại.
- Chưa build SBF, chưa tạo IDL từ Rust, chưa deploy, chưa ký giao dịch Phantom thật và chưa chạy integration tests trên Devnet.
- `11111111111111111111111111111111` trong Rust/Anchor.toml là sentinel chưa cấu hình, **không phải GoBuy Program ID**; frontend từ chối giá trị này.
- `npm run test:anchor` bỏ qua suite nếu không bật GOBUY_RUN_DEVNET_TESTS; skip không phải test pass.
- Audit dependency còn cảnh báo transitive từ SDK Anchor/web3 (toml, jayson/stream-json/uuid). Không dùng `npm audit fix --force` vì npm đề xuất downgrade SDK không tương thích. React Router đã được nâng lên bản vá. Các parser TOML/stream không nhận dữ liệu người dùng trong ứng dụng này; đây vẫn là hạn chế cần rà soát trước triển khai ngoài demo.

Tài liệu API đã đối chiếu: [Anchor TypeScript client](https://www.anchor-lang.com/docs/clients/typescript),
[Anchor 1.2.0](https://www.anchor-lang.com/docs/updates/release-notes/1-2-0),
[Phantom transactions](https://docs.phantom.com/solana/sending-a-transaction).

## Application persistence

Firebase remains the identity provider; MongoDB stores private profiles, NFT orders and Commerce Twins; Solana remains the on-chain source of truth. Configure backend MongoDB before `npm run dev`. See [MongoDB setup, migration and emulator guide](docs/MONGODB.md). `npm run dev:auth` keeps an explicit isolated file mode by default.
