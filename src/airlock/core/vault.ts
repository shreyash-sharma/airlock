import { AnonymizationSession } from "../../vendor/doccloak/session.js";
import type { DetectedEntity } from "./types.js";

/**
 * In-memory placeholder vault built on the vendored DocCloak session. Placeholders look like
 * [EMAIL_1] and are stable per value. Original values live only here: never put them in a request
 * body, a log line or an audit entry.
 */
export class Vault {
  private readonly session = new AnonymizationSession({ mode: "labeled" });

  /** Replace the given non-overlapping entities in `text` with placeholders. */
  mask(text: string, entities: DetectedEntity[]): string {
    return this.session.anonymizeText(text, entities);
  }

  /** Put originals back into text that came back from the cloud. */
  restore(text: string): string {
    return this.session.deanonymize(text);
  }

  /** Placeholders in `text` that the vault cannot resolve (the model altered or invented them). */
  unresolved(text: string): string[] {
    return this.session.unresolvedTokens(text);
  }

  originals(): string[] {
    return this.session.getEntries().map((e) => e.original);
  }

  /** Counts per entity type: safe to show or log, contains no values. */
  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.session.getEntries()) out[e.entityType] = (out[e.entityType] ?? 0) + 1;
    return out;
  }
}
