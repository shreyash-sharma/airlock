import { initializeApp } from "firebase/app";
import { getAI, GoogleAIBackend } from "firebase/ai";
import { AUTHORING_GENERATION_CONFIG, CLOUD_MODEL_NAME, createHybridModels } from "../../firebase-models.js";
import type { PageRuntimeEnv } from "./runtime.js";

/**
 * The Firebase AI Logic models for the extension's page engine: the same definitions as the web app
 * (firebase-models.ts), built lazily and WITHOUT App Check. Nothing here runs at document_start (App Check's
 * reCAPTCHA provider needs document.body and would load a Google iframe into the user's page). On-device calls need
 * no token. A cloud fallback of the structure-only authoring call has none either, so if the project enforces App
 * Check that call is refused and authoring fails visibly; App Check bound to the extension ID comes later.
 */
const env = import.meta.env;
let ai: ReturnType<typeof getAI> | undefined;
const lazyAi = () => {
  ai ??= getAI(
    initializeApp({
      apiKey: env.VITE_FIREBASE_API_KEY,
      authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: env.VITE_FIREBASE_PROJECT_ID,
      appId: env.VITE_FIREBASE_APP_ID,
      messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    }),
    { backend: new GoogleAIBackend() },
  );
  return ai;
};

const hybrid = createHybridModels(lazyAi);

export const pageModels: NonNullable<PageRuntimeEnv["models"]> = {
  localModel: hybrid.getLocalJsonModel,
  classifierModel: hybrid.getLocalClassifierModel,
  authoringModel: () => ({ model: hybrid.getAuthoringModel(), name: CLOUD_MODEL_NAME, generationConfig: AUTHORING_GENERATION_CONFIG }),
};
