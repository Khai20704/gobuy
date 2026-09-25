# Anchor tests

authorization.test.ts là integration suite Devnet opt-in, dùng IDL từ anchor build.
Chạy theo anchor/README.md. Mặc định skip khi chưa bật GOBUY_RUN_DEVNET_TESTS=1.
Rust rules.rs có 16 rule cases; hash_tests.rs có 2 golden-vector cases đối chiếu TypeScript. Chạy bằng cargo test khi toolchain/linker đầy đủ.
Không coi skip hay kiểm tra TypeScript là bằng chứng chương trình đã chạy trên chain.
