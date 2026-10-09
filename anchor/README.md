# Na Vault program ? Devnet

See [architecture and setup](../docs/DELEGATED_SPENDING.md).

Instructions: create_mandate, spend_from_mandate, cancel_mandate, withdraw_remaining. Mandate data size including discriminator: 181 bytes. SpendRecord: 194 bytes.

The existing Devnet program is `CHjdqooB7TrussJoZoboFP5TtdCspoHtvPpqoshbr5zE`. RPC verified an executable program and the existing funded mandate/Vault PDAs under this identity. Preserve this ID and the PDA seeds; do not generate a replacement program keypair. Correcting `declare_id!` does not establish that this source matches the deployed binary.

Deployment provenance remains unverified. Recover the original source commit, build toolchain, SBF artifact and deployment records before considering an upgrade. The observed upgrade authority is `6CndRMc647mRNyFLTXVefngq7kgouexvoVP6v4aZQ6JB`; an agent keypair is not evidence of control of that authority. A generated IDL describes an interface, not proof of binary equivalence. No deployment or upgrade is authorized by these setup notes.

Native Windows Rust tests require Visual Studio C++ Build Tools and Windows SDK (link.exe). Run `cargo test --manifest-path anchor/Cargo.toml`. Anchor/SBF builds require the appropriate Solana toolchain, typically via WSL/Linux. Never deploy this development program on Mainnet.
