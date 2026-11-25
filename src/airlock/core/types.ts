import type { DetectedEntity, EntityType } from "../../vendor/doccloak/types.js";

export type { DetectedEntity, EntityType };

/** Entity types AIRLOCK masks by default. DATE and CURRENCY are deliberately absent: a negotiation
 *  task needs salaries and dates, so they are "needed-for-task" rather than "sensitive". */
export const MASK_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  "EMAIL",
  "PHONE",
  "SSN",
  "CREDIT_CARD",
  "IBAN",
  "API_KEY",
  "SECRET",
  "IP_ADDRESS",
  "ADDRESS",
  "PERSON",
]);

export interface Clause {
  id: string;
  heading: string;
  text: string;
  /** Offsets into the exact document string that was split. End is exclusive. */
  start: number;
  end: number;
  tokens: number;
}

export type SelectionSource = "on_device" | "deterministic";

export interface Selection {
  ids: string[];
  reasons: Record<string, string>;
  source: SelectionSource;
  latencyMs: number;
  calls: number;
}

export class LocalAIError extends Error {
  readonly kind: "unavailable" | "not-ready" | "failed" | "malformed";
  constructor(kind: LocalAIError["kind"], message: string) {
    super(message);
    this.name = "LocalAIError";
    this.kind = kind;
  }
}

export interface Analyzer {
  /** Pick the clauses a task needs. Must throw LocalAIError when on-device inference cannot do it. */
  select(task: string, clauses: Clause[]): Promise<Selection>;
}
