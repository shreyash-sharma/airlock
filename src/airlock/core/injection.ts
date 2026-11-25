/**
 * Text in a document that reads like an instruction to an AI system. Documents are untrusted data,
 * so a clause containing this is withheld from the outbound payload and the user is told why.
 * This is a heuristic: it catches the common phrasings, not every possible attack, which is why the
 * payload is also delimited as data and why code, not the model, decides what may leave.
 */
const PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\bignore\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|rules|prompts?)\b/i, why: "tells an AI to ignore its instructions" },
  { re: /\bdisregard\s+(?:all\s+|any\s+|the\s+)?(?:previous\s+|prior\s+|above\s+)?(?:instructions?|rules|guidelines)\b/i, why: "tells an AI to disregard its rules" },
  { re: /\bnote\s+to\s+(?:any\s+|the\s+)?(?:ai|a\.i\.|assistant|llm|language\s+model|automated)\b/i, why: "is addressed to an AI system" },
  { re: /\b(?:reveal|print|output|include|send|leak|exfiltrate)\b[^.\n]{0,60}\b(?:api[ _-]?key|password|secret|token|bank\s+(?:account|details))/i, why: "asks an AI to reveal secrets" },
  { re: /\b(?:you\s+are\s+now|from\s+now\s+on\s+you|pretend\s+to\s+be)\b/i, why: "tries to change the AI's role" },
  { re: /\bsystem\s+prompt\b/i, why: "refers to the AI's system prompt" },
];

/** Returns a plain-words reason when the text looks like instructions to an AI, otherwise null. */
export function looksLikeInstructions(text: string): string | null {
  for (const p of PATTERNS) if (p.re.test(text)) return p.why;
  return null;
}
