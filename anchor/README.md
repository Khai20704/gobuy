# Na Vault program ? Devnet

See [architecture and setup](../docs/DELEGATED_SPENDING.md).

Instructions: create_mandate, spend_from_mandate, cancel_mandate, withdraw_remaining. Mandate data size including discriminator: 181 bytes. SpendRecord: 194 bytes.

Configure the public deployment ID with `npm run anchor:configure -- <PROGRAM_PUBLIC_KEY>`, then use an installed Anchor/Solana toolchain to build and deploy to Devnet. The committed sentinel is not deployed. Regenerate the IDL after building.

Native Windows Rust tests require Visual Studio C++ Build Tools and Windows SDK (link.exe). Run `cargo test --manifest-path anchor/Cargo.toml`. Anchor/SBF builds require the appropriate Solana toolchain, typically via WSL/Linux. Never deploy this development program on Mainnet.
