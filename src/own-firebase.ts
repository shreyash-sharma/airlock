/**
 * "Use my own Firebase": an optional web config the visitor pastes, kept only in this browser's localStorage.
 * The pasted text is read with patterns, never evaluated.
 */
export const OWN_FIREBASE_KEY = "airlock.demo.firebase";

export interface OwnFirebase {
  apiKey: string;
  projectId: string;
  appId: string;
  authDomain?: string;
  messagingSenderId?: string;
  recaptchaSiteKey?: string;
}

const FIELDS = ["apiKey", "projectId", "appId", "authDomain", "messagingSenderId"] as const;

/** Accepts the snippet the Firebase console shows, or JSON. Returns null unless apiKey, projectId and appId are present. */
export function parseFirebaseConfig(text: string, recaptchaSiteKey = ""): OwnFirebase | null {
  const out: Partial<OwnFirebase> = {};
  for (const field of FIELDS) {
    const m = new RegExp(`["']?\\b${field}\\b["']?\\s*:\\s*["']([A-Za-z0-9_.:\\-]{1,200})["']`).exec(text);
    if (m) out[field] = m[1];
  }
  if (!out.apiKey || !out.projectId || !out.appId) return null;
  const key = recaptchaSiteKey.trim();
  if (key) out.recaptchaSiteKey = key;
  return out as OwnFirebase;
}

export function loadOwnFirebase(): OwnFirebase | null {
  try {
    const raw = localStorage.getItem(OWN_FIREBASE_KEY);
    return raw ? parseFirebaseConfig(raw, (JSON.parse(raw) as OwnFirebase).recaptchaSiteKey ?? "") : null;
  } catch {
    return null;
  }
}
