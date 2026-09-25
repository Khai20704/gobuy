# Canonical bytes v1

SHA-256, domain separation, fixed-width fields; Rust và TypeScript cùng định dạng.

Proposal:
`UTF8("gobuy:proposal:v1") || UUID[16] || amount:u64LE || currency:u8 || asset_type:u8 || marketplace:u8 || seller_claim:bool_u8 || asset_id_hash[32] || evidence_hash[32] || metadata_hash[32] || expires_at:i64LE`.

- currency 1 = DEVNET_SOL_LAMPORTS (9 decimals); 2 reserved, bị mandate currency rule từ chối.
- asset 1 = NFT, 2 = RWA.
- marketplace 1 = DEMO_MARKET, 2 = DEMO_GALLERY.
- UUID bỏ dấu gạch, đọc từng cặp hex theo thứ tự (không đổi endian).
- asset_id_hash = SHA256(UTF8(assetId)).
- evidence_hash = SHA256(UTF8(JSON.stringify([source, claimedVerified, reference, disclaimer]))).
- metadata_hash = SHA256(UTF8(JSON.stringify([title, imageUrl, description, demo]))).
- JSON arrays cố định thứ tự; chuỗi giữ nguyên UTF-8, không Unicode normalization.
- Prompt và reference image không thuộc proposal hay hash.

Policy:
`UTF8("gobuy:policy:v1") || max_amount:u64LE || currency:u8 || asset_type:u8 || marketplace:u8 || require_seller:bool_u8 || autonomy:bool_u8`.

Policy hash tính từ hard constraints; không hash toàn bộ JSON hay preferences cá nhân.
Version truyền riêng và ghi vào ActionRecord. PDA replay key dùng UUID, không dùng hash hoặc version.
Hash chỉ ràng buộc dữ liệu đã gửi, không chứng thực sự thật bên ngoài.
