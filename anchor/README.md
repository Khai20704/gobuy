# Na — Anchor program (Devnet only)

Source dùng Anchor **1.2.0**; TypeScript client dùng `@anchor-lang/core 1.2.0` với `@solana/web3.js 1.x`.
Chưa có deployment/IDL được xác nhận. Cấu hình sentinel không phải địa chỉ program dùng được.

## State và instructions

- Mandate PDA: `["mandate", owner]`; initialize và update bắt buộc owner ký.
- Update kiểm tra expected_version, tăng version đúng 1, chống ghi đè khi UI giữ state cũ.
- Policy lưu max_amount u64, currency=1 (Devnet SOL lamports), asset type, marketplace, seller rule, autonomy và hash.
- ActionRecord PDA: `["action", mandate, proposal_id_16_bytes]`.
- authorize_proposal không nhận approved; Rust tính mask và reason.
- Rule failure trả instruction success và ghi record REJECTED; malformed fields/hash trả error, rollback account creation.
- Dùng init, không init_if_needed; cùng ID không thể chạy lại dù đổi hash, version hoặc giá.
- ID mới là proposal mới; MVP không khẳng định chống trùng cùng tài sản với ID khác.
- Các account không có close/reset instruction; audit là immutable.

Reason priority (first failing rule, tất cả rule vẫn có trong mask):

| Code | Reason |
| --- | --- |
| 0 | APPROVED |
| 1 | STALE_VERSION |
| 2 | EXPIRED (expires_at <= Clock time) |
| 3 | AUTONOMY_DISABLED |
| 4 | PRICE_EXCEEDED |
| 5 | CURRENCY_MISMATCH |
| 6 | ASSET_TYPE_MISMATCH |
| 7 | MARKETPLACE_DENIED |
| 8 | SELLER_EVIDENCE_REQUIRED |
| 9 | RWA_READ_ONLY |

Record chứa mandate address, owner, proposal ID/hash, submitted/current version, approved, reason, rule bitmask, timestamp.
Không chứa prompt, ảnh, title, lịch sử cá nhân hoặc policy JSON.
Seller verified chỉ là adapter claim, không có attestation/oracle.
Program không thực hiện purchase, swap, escrow, custody hoặc token instruction.

## Toolchain và build

Windows: dùng WSL2 hoặc môi trường Linux theo [hướng dẫn Anchor chính thức](https://www.anchor-lang.com/docs/installation).
Native cargo test trên Windows cần Visual Studio Build Tools C++/Windows SDK (VS Code không cung cấp linker).
Bản này pin Anchor 1.2.0; [release notes](https://www.anchor-lang.com/docs/updates/release-notes/1-2-0) khuyến nghị Solana 4.1.2.

Sau khi toolchain có sẵn, kiểm tra tại root:

```powershell
anchor --version
solana --version
cargo test --manifest-path anchor/Cargo.toml
```

Deployment dùng identity dành riêng Devnet do operator quản lý ngoài repository/hardware signer.
Không nhập seed phrase vào app, không gửi key cho backend hoặc commit key. Những chuỗi trong dấu <...> dưới đây là placeholder cần thay bằng public ID/signer URI thực tế, không chạy nguyên văn.

```powershell
# Cấu hình public ID tương ứng với program signer thực tế
npm run anchor:configure -- <ACTUAL_PROGRAM_PUBLIC_KEY>
Set-Location anchor
# --ignore-keys vì deployment signer nằm ngoài target/deploy; source ID đã cấu hình ở bước trên
anchor build --ignore-keys
Set-Location ..
npm run anchor:idl
```

Nếu build tạo keypair tạm trong target thì đó không phải ví người dùng hoặc deployment identity được cấu hình; target và *-keypair.json bị gitignore. Không dùng địa chỉ của keypair tạm thay cho ID thực tế ở source.

## Deploy và kiểm chứng

Chỉ tiếp tục khi source build/tests đã qua, signer được cấu hình riêng và có test SOL trên Devnet.
Giữ program signer bên ngoài repo. Chỉ triển khai Devnet:

```powershell
solana program deploy --url devnet --program-id <PROGRAM_SIGNER_URI> --keypair <DEVNET_DEPLOYER_SIGNER_URI> anchor/target/deploy/gobuy_na.so
solana program show --url devnet <ACTUAL_PROGRAM_PUBLIC_KEY>
```

Lưu signature thực tế từ CLI và kiểm tra executable account; không coi việc copy IDL là bằng chứng deploy.
Xem [Solana deployment documentation](https://solana.com/docs/programs/deploying) cho signer URI và nâng cấp.
Cập nhật frontend/.env.local: VITE_SOLANA_PROGRAM_ID bằng đúng public ID, RPC Devnet, URL IDL mặc định.
Frontend kiểm tra genesis hash, executable program, IDL address, account owner, confirmation và record hash/version.
Kết nối Phantom ở Devnet, có test SOL trả rent/fee → tạo mandate → gửi proposal → xem Activity/Explorer.

## Tests

Rust rule tests (16 cases) và Anchor macros:

```powershell
cargo test --manifest-path anchor/Cargo.toml
```

Sau khi đã deploy và copy/build IDL, chạy từ root:

```powershell
npm run build -w shared
$env:GOBUY_RUN_DEVNET_TESTS = "1"
$env:SOLANA_DEVNET_RPC_URL = "https://api.devnet.solana.com"
npm run test:anchor
```

Suite dùng signer ephemeral trong bộ nhớ và xin 1 Devnet SOL qua airdrop, không đọc hoặc ghi private key người dùng.
Public faucet có thể rate-limit; lỗi airdrop là test failure, không tự tạo kết quả.
Kiểm tra initialize/owner, unauthorized update/authorize, version increment/concurrent update,
price boundary/pass/fail, asset, market, seller, autonomy, expiry, stale version, hash mismatch,
duplicate ID với hash/version thay đổi và RWA read-only.
Đây là integration suite gọi program thật trên Devnet; mặc định bị skip, không tính như đã pass.
