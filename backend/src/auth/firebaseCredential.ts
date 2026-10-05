import { applicationDefault, cert } from 'firebase-admin/app'

export function firebaseCredential() {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
  const privateKey = process.env.FIREBASE_PRIVATE_KEY
  return clientEmail && privateKey
    ? cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, '\n'),
    })
    : applicationDefault()
}
