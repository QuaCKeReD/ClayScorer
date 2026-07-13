// Firebase web app config for ClayScorer cloud sync.
//
// 1. Create a Firebase project.
// 2. Add a Web app in Project settings.
// 3. Enable Authentication > Sign-in method > Google.
// 4. Create a Firestore database and apply the rules in FIREBASE_SETUP.md.
// 5. Paste the config below and set FIREBASE_ENABLED to true.

export const FIREBASE_ENABLED = true;

export const FIREBASE_CONFIG = {
    apiKey: "AIzaSyBGoc_I0BJrQh2gidF6N-hdPX7vUQlVDbM",
    authDomain: "clayscorer.firebaseapp.com",
    projectId: "clayscorer",
    storageBucket: "clayscorer.firebasestorage.app",
    messagingSenderId: "66255196642",
    appId: "1:66255196642:web:380824f13e43dde4b1a9bb"
};
