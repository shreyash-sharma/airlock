export type AuditKind =
  | "request-held"
  | "local-analysis"
  | "local-failed"
  | "policy"
  /** A profile-driven request was protected field by field: profile id, author and per-action counts, never values. */
  | "protected"
  | "approved"
  | "denied"
  | "blocked"
  | "sent"
  | "response"
  | "error"
  /** A value-free, structure-only authoring prompt released to the cloud model without the approval gate. */
  | "internal-authoring"
  /** An unprofiled request to an inspected host was captured and held. Host, method, path and leaf count only. */
  | "inspection-held"
  /** The user released one held request with no protection. This is an explicit unprotected send. */
  | "unprotected-send"
  /** The user approved an authored profile and it was saved. Profile id, author and field count only. */
  | "profile-saved"
  /** A GET or HEAD with no body to a host the user allowed reads for left under that rule. Host, method, path, 0 bytes of body. */
  | "read-released"
  /** The user-set "allow reads without a body" rule is in force (or was withdrawn) for a host. Host names only. */
  | "read-policy"
  /** An inline-mode (CRM) request needs a later human look. Plain-word reasons, never a value. */
  | "review-flag";

export interface AuditEvent {
  id: number;
  ts: number;
  kind: AuditKind;
  requestId: string;
  /** Where the step ran: the SDK-reported source for on-device calls, "network" for the observed cloud request. */
  where?: "on_device" | "in_cloud" | "code";
  latencyMs?: number;
  /** Counts and categories only. Never original values. */
  detail?: Record<string, string | number | boolean | null>;
}

export class AuditLog {
  private events: AuditEvent[] = [];
  private listeners = new Set<() => void>();
  private nextId = 1;

  add(e: Omit<AuditEvent, "id" | "ts">): AuditEvent {
    const event: AuditEvent = { id: this.nextId++, ts: Date.now(), ...e };
    this.events = [...this.events, event];
    this.listeners.forEach((l) => l());
    return event;
  }

  snapshot(): readonly AuditEvent[] {
    return this.events;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** What has actually left the device, computed only from the audit log. */
export function egressSummary(events: readonly AuditEvent[]): { requests: number; bytes: number; withheld: number } {
  let requests = 0;
  let bytes = 0;
  let withheld = 0;
  for (const e of events) {
    if (e.kind === "sent") {
      requests += 1;
      bytes += Number(e.detail?.bytes ?? 0);
      withheld += Number(e.detail?.withheld ?? 0);
    } else if (e.kind === "read-released") {
      // A read with no body still leaves the device (the URL and headers do): count it, with no body bytes.
      requests += 1;
    } else if (e.kind === "unprotected-send") {
      // The one-time pass-through left this device with nothing withheld: it must show in the egress total.
      requests += 1;
      bytes += Number(e.detail?.bytes ?? 0);
    }
  }
  return { requests, bytes, withheld };
}
