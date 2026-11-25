import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaV3Provider } from "firebase/app-check";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from "firebase/ai";
import { CLOUD_MODEL_NAME, createHybridModels } from "./firebase-models.js";

export { AUTHORING_GENERATION_CONFIG, AUTHORING_MODE, CLASSIFIER_MODE, CLOUD_MODEL_NAME } from "./firebase-models.js";

const env = import.meta.env;
const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  appId: env.VITE_FIREBASE_APP_ID,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
});

// App Check with the debug provider (accepted for submissions). The SDK prints a debug token to the
// console on first run; register it in the Firebase console. Never commit the token.
(self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
initializeAppCheck(app, { provider: new ReCaptchaV3Provider("debug-placeholder"), isTokenAutoRefreshEnabled: true });

const ai = getAI(app, { backend: new GoogleAIBackend() });

/** Cloud model used by the demo host app, exactly as the Firebase docs show it. */
export const cloudModel = getGenerativeModel(ai, { mode: InferenceMode.ONLY_IN_CLOUD, model: CLOUD_MODEL_NAME });

// The on-device and hybrid models (see firebase-models.ts for the hybrid-inference design and mode labels).
const models = createHybridModels(() => ai);
export const getLocalJsonModel = models.getLocalJsonModel;
export const getLocalClassifierModel = models.getLocalClassifierModel;
export const getAuthoringModel = models.getAuthoringModel;
