import { getGenerativeModel, InferenceMode, Schema, type AI } from "firebase/ai";
import { ACTIONS, CATEGORIES } from "./airlock/profiles/types.js";

/**
 * The Firebase AI Logic hybrid models AIRLOCK uses, defined once and built on whichever `AI` instance the caller has:
 * the web app (firebase.ts, with App Check) and the Chrome extension page (ext/page/models.ts, no App Check, built
 * lazily so nothing runs at document_start).
 *
 * Hybrid inference by data sensitivity (the labels the panel and README use):
 * - ONLY_ON_DEVICE for any prompt that holds real values (field classification): a missing local model throws.
 * - PREFER_ON_DEVICE for structure-only prompts (profile authoring): on-device first, automatic cloud fallback
 *   through the SDK. That is safe only because the prompt builder never emits a captured value.
 * - ONLY_IN_CLOUD stays for the Gemini task in the demo host app (firebase.ts).
 */

/** Cloud model used by the demo host app and the authoring fallback, exactly as the Firebase docs show it. */
export const CLOUD_MODEL_NAME = "gemini-3.5-flash-lite";

export const CLASSIFIER_MODE = "ONLY_ON_DEVICE";
export const AUTHORING_MODE = "PREFER_ON_DEVICE";

const selectionSchema = Schema.object({
  properties: {
    relevant: Schema.array({
      items: Schema.object({ properties: { id: Schema.string(), reason: Schema.string() } }),
    }),
  },
});

const classifierJsonSchema = {
  type: "object",
  properties: {
    fields: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, class: { type: "string", enum: [...CATEGORIES] }, reason: { type: "string" } },
        required: ["path", "class", "reason"],
      },
    },
  },
  required: ["fields"],
};

const authoringFieldSchema = (withFlow: boolean) =>
  Schema.object({
    properties: withFlow
      ? {
          path: Schema.string(),
          category: Schema.enumString({ enum: [...CATEGORIES] }),
          flow: Schema.object({ properties: { action: Schema.enumString({ enum: [...ACTIONS] }) } }),
        }
      : { path: Schema.string() },
  });

/** Mirrors the whitelisted profile shape: name, kind, match {hosts, paths, methods}, request.fields, response.fields. */
const authoringSchema = Schema.object({
  properties: {
    name: Schema.string(),
    kind: Schema.enumString({ enum: ["saas", "ai"] }),
    match: Schema.object({
      properties: { hosts: Schema.array({ items: Schema.string() }), paths: Schema.array({ items: Schema.string() }), methods: Schema.array({ items: Schema.string() }) },
    }),
    request: Schema.object({ properties: { fields: Schema.array({ items: authoringFieldSchema(true) }) } }),
    response: Schema.object({ properties: { fields: Schema.array({ items: authoringFieldSchema(false) }) } }),
  },
});

/** The generation config of the authoring model's cloud request. The structure-only release matches it exactly. */
export const AUTHORING_GENERATION_CONFIG = { responseMimeType: "application/json", responseSchema: authoringSchema };

// AIRLOCK only ever sends text on the device. The SDK's default also asks for image input, and a browser that cannot
// open an image-capable session then refuses to open any session (seen in Chrome 158), so ask for text only.
const TEXT = { type: "text" as const, languages: ["en"] };
const textOnly = () => ({ expectedInputs: [TEXT], expectedOutputs: [TEXT] });

export function createHybridModels(ai: () => AI) {
  let localJson: ReturnType<typeof getGenerativeModel> | undefined;
  let localClassifier: ReturnType<typeof getGenerativeModel> | undefined;
  let authoring: ReturnType<typeof getGenerativeModel> | undefined;
  return {
    /** On-device model with a JSON schema for clause selection. ONLY_ON_DEVICE means a missing local model throws instead of falling back to the cloud. */
    getLocalJsonModel() {
      localJson ??= getGenerativeModel(ai(), {
        mode: InferenceMode.ONLY_ON_DEVICE,
        generationConfig: { responseMimeType: "application/json", responseSchema: selectionSchema },
        onDeviceParams: { createOptions: textOnly() },
      });
      return localJson;
    },
    /** On-device only, JSON schema {fields: [{path, class, reason}]}. Receives real values, so it can never reach the cloud. */
    getLocalClassifierModel() {
      localClassifier ??= getGenerativeModel(ai(), {
        mode: InferenceMode.ONLY_ON_DEVICE,
        onDeviceParams: { createOptions: textOnly(), promptOptions: { responseConstraint: classifierJsonSchema } },
      });
      return localClassifier;
    },
    /**
     * Hybrid model for structure-only authoring: PREFER_ON_DEVICE, so Nano answers when it can and the SDK falls back
     * to the cloud model otherwise. response.inferenceSource says which one wrote the profile. The prompt holds no value.
     * No on-device responseConstraint: measured in real Chrome, Nano did not finish this nested schema in 270 s, while
     * the same prompt unconstrained takes about 37 s. The reply is validated by code either way; the cloud request
     * still carries the response schema.
     */
    getAuthoringModel() {
      authoring ??= getGenerativeModel(ai(), {
        mode: InferenceMode.PREFER_ON_DEVICE,
        onDeviceParams: { createOptions: textOnly() },
        inCloudParams: { model: CLOUD_MODEL_NAME, generationConfig: AUTHORING_GENERATION_CONFIG },
      });
      return authoring;
    },
  };
}
