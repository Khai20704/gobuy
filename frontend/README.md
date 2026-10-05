# Na frontend

The active `/na` page uses semantic NFT discovery, explicit Devnet simulation, verified wallet linking and My Assets. See [the current acquisition guide](../docs/ASSET_ACQUISITION.md). The older research/authority components described below remain in the repository but are not the active chat. Run `npm run test:e2e:acquisition` from the root for current browser integration coverage.

Product research is the default chat mode, with one best-match evidence card and Approve/Reject/View Product actions. Insufficient evidence produces an explanation without a recommendation.
Use **Authority demo** for the existing proposal scenarios and reference-image flow.
My mandate also contains Commerce Twin preferences; Activity shows saved browser research decisions separately from Devnet verdicts.
See [Na research](../docs/NA_RESEARCH.md) for setup and the transaction review boundary.

React + TypeScript + Vite; giữ nhận diện GoBuy, routes /na, /na/mandate, /na/activity.
Từ root chạy `npm run dev`; tại frontend chạy `npm run dev`.
Cần backend đang chạy trên cổng 3001 cho discovery demo. Không fallback giả khi API lỗi.
.env.example mô tả public Devnet config. Thiếu program/IDL thì vẫn dùng demo preview.
Phantom ký phía browser; Anchor client tải khi connect. Không lưu wallet secrets.
Xem README gốc và anchor/README.md để build/test/deploy.

Mandate v2 removes the persistent budget, adds active/revoked state and collection/protocol/risk controls. My mandate includes extension pairing and revocation; chat includes structured search without AI. See [v2 setup](../docs/NA_ARCHITECTURE_V2.md).
