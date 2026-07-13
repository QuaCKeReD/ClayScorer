# Firebase setup for ClayScorer

ClayScorer stays offline-first. Firebase only adds optional Google sign-in plus Firestore upload/download of named rounds.

## Firebase console

1. Create a Firebase project.
2. Add a Web app and copy the app config.
3. Enable Authentication > Sign-in method > Google.
4. Create a Firestore database.
5. Paste the config into `assets/firebase-config.js` and set `FIREBASE_ENABLED` to `true`.

## Firestore rules

Use these rules so each signed-in Google user can only access their own rounds:

```js
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    match /clayScorerUsers/{userId}/rounds/{roundId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

## Data shape

Rounds are written to:

```text
clayScorerUsers/{firebaseAuthUid}/rounds/{disciplineId}_{encodedRoundKey}
```

Each document stores the discipline metadata, the local round key, the full round state, and update timestamps. Unnamed rounds are not uploaded because they do not have a stable round key.
