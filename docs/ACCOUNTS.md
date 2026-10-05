# Na accounts and delivery profiles

The active flow is `/login` → Google or email/password → phone verification → shipping address → `/na`. `/account` lets the user edit the address or sign out. Returning users keep their Firebase login and load their saved profile from the backend.

Phone numbers are normalized to E.164 using the selected country. Firebase reCAPTCHA and SMS phone linking verify the number on the existing account. The UI supports incorrect/expired codes, resending after a cooldown, changing the number before verification, provider failures, and password reset. The country list does not promise SMS availability in every country: Firebase project region policy and carrier availability still apply.

## Try locally without credentials or paid SMS

From `gobuy`:

```powershell
npm run dev:auth
```

This starts the official Firebase Auth Emulator plus both app services. First run downloads Firebase CLI 15.32.1 through npm. Open the Vite URL and register an email/password account. OTPs appear in the emulator terminal, not on a real phone. The Google button opens an emulator account picker, not a real Google account. Test accounts reset when the emulator stops; test addresses are isolated in `backend/.data/accounts-emulator`. The Firebase emulator banner identifies this mode.

Ports 9099 (Auth), 4400/4500 (emulator support), 3001 (API), and 5173 (web) must be available. Stop existing development servers first. `Ctrl+C` stops this local session. Emulator use is restricted to loopback hosts and `demo-` Firebase project IDs; the frontend refuses it in production builds and the backend refuses it with `NODE_ENV=production`.

## Enable real Google login, email/password and SMS

1. Create a Firebase project and register a Web app. In Authentication, enable **Email/Password**, **Google**, and **Phone** providers. Configure the Google support email and authorized app domains.
2. Configure a password policy (at least 10 characters) in Firebase as well as the client UI. Enable email enumeration protection. Na uses email as the login name; email verification is not an additional onboarding requirement in this version.
3. Enable billing for SMS and set an SMS region allowlist for the countries you actually support. Serve phone authentication on an authorized hosted domain; Firebase's phone-auth docs do not support localhost as a hosted SMS domain. Use the emulator locally. See [phone-auth setup](https://firebase.google.com/docs/auth/web/phone-auth) and [SMS billing requirements](https://firebase.google.com/docs/auth/faq-and-troubleshooting).
4. Put public Web configuration in `frontend/.env.local`:

```dotenv
VITE_FIREBASE_API_KEY=<web-api-key>
VITE_FIREBASE_AUTH_DOMAIN=<project>.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=<project>
VITE_FIREBASE_APP_ID=<web-app-id>
```

5. Put backend configuration in `backend/.env`:

```dotenv
FIREBASE_PROJECT_ID=<same-project>
GOOGLE_APPLICATION_CREDENTIALS=C:/private/firebase-service-account.json
APP_STORAGE=mongo
MONGODB_URI=<private-atlas-connection-string>
MONGODB_DB_NAME=gobuy
```

Use an appropriately scoped Firebase Admin credential or workload identity/ADC in hosting. Keep service-account JSON outside the repository and never put it in `VITE_` variables. Remove emulator variables for real authentication. Set `NODE_ENV=production` when hosting the backend.

6. Run `npm run dev`, or build/deploy with the existing commands. Missing configuration shows a setup message and blocks login; there is no fake-success fallback. No Firebase project, billing plan, domain, real Google account or SMS has been provisioned by this change.

## Backend enforcement and storage

- Each request to `/api/account/*` verifies the Firebase ID token with revocation checking and loads the current user from Firebase Admin. Disabled/revoked identities are rejected. Only accounts containing Google or password credentials are accepted.
- `GET /api/account/me` derives verified phone status from Firebase; the browser cannot set a `phoneVerified` flag.
- `PUT /api/account/address` requires a verified phone and validates recipient, ISO country, street, city/locality and optional region/address line/postal code. Unknown fields such as `uid` are rejected. The destination account always comes from the verified token.
- NFT chat/submit/order endpoints require completed onboarding. Metadata and artwork stay public so the NFT can render. Orders and browser pending-order keys are scoped to the account UID. Orders created before account support have no owner UID and are not silently assigned to whoever knows their ID.
- Profiles now use `MongoProfileStore` with unique `users.firebaseUid` and embedded addresses. Firebase remains the source of verified identity and phone state. File storage is available only through explicit development/test configuration. See [MongoDB setup and safe migration](MONGODB.md) for Atlas, indexes, data import, emulator isolation and security details.
- Phone verification here is contact verification, not an MFA challenge on every login. Existing research/demo endpoints retain their previous session system; the active NFT purchase endpoints are protected by this account flow.

## Shipping scope

The address is a saved delivery profile for future physical purchases. This change does not integrate a carrier, validate delivery serviceability, calculate shipping, or dispatch parcels. Devnet NFTs still go to the Phantom wallet; an address never changes their destination. A future physical checkout must capture an address snapshot and verified contact for each order rather than reading a profile that can change later.

## Tests

```powershell
npm test
npm run lint
npm run build
# Terminal 1:
npx --yes firebase-tools@15.32.1 emulators:start --only auth --project demo-na
# Terminal 2:
npx playwright test --config playwright.auth.config.ts
```

Backend tests cover unauthenticated/forged requests, phone/address requirements, attempted client-side verification flags, address validation, account isolation and disk persistence. Chrome tests exercise registration, wrong/correct OTP, address persistence, logout/login, the emulator Google popup, and Devnet wallet/approval/rejection flows after login. Actual Google OAuth, reCAPTCHA on the hosted domain and real SMS delivery still require verification with the configured Firebase project.

Historical pre-Mongo verification: 92 unit/API tests and five Chrome tests passed against the official Auth Emulator. See MONGODB.md for the new storage test boundaries. `npm run dev:auth` also passed startup health checks for Auth, the backend and frontend proxy. Desktop login and mobile address previews are saved under `test-results/` when the browser suite runs. The production build retains a bundle-size warning.
