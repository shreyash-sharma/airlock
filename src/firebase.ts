import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from "firebase/ai";
import { CLOUD_MODEL_NAME, createHybridModels } from "./firebase-models.js";
import { loadOwnFirebase } from "./own-firebase.js";

export { AUTHORING_GENERATION_CONFIG, AUTHORING_MODE, CLASSIFIER_MODE, CLOUD_MODEL_NAME } from "./firebase-models.js";

const env = import.meta.env;
// A visitor of the hosted demo may paste their own web config ("Use my own Firebase"); otherwise the build's config.
const own = loadOwnFirebase();
const app = initializeApp(
  own ?? {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    appId: env.VITE_FIREBASE_APP_ID,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  },
);

// App Check. On this machine: the debug provider (the SDK prints a token to register in the console; never commit it).
// Anywhere else: reCAPTCHA Enterprise with the site key of whichever project is in use. A visitor's project without a key runs without it.
const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
const siteKey: string | undefined = own ? own.recaptchaSiteKey : env.VITE_RECAPTCHA_SITE_KEY;
if (local) (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
if (local || siteKey) {
  initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(siteKey || "debug-placeholder"), isTokenAutoRefreshEnabled: true });
}

const ai = getAI(app, { backend: new GoogleAIBackend() });

/** Cloud model used by the demo host app, exactly as the Firebase docs show it. */
export const cloudModel = getGenerativeModel(ai, { mode: InferenceMode.ONLY_IN_CLOUD, model: CLOUD_MODEL_NAME });

// The on-device and hybrid models (see firebase-models.ts for the hybrid-inference design and mode labels).
const models = createHybridModels(() => ai);
export const getLocalJsonModel = models.getLocalJsonModel;
export const getLocalClassifierModel = models.getLocalClassifierModel;
export const getAuthoringModel = models.getAuthoringModel;
