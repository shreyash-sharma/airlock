import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { STATUS_LABEL, type ConsoleStatus } from "../pages/model.js";
import { Icon, type IconName } from "./icons.js";

export type Tone = "ok" | "cloud" | "masked" | "blocked" | "attention" | "neutral" | "primary";

export function Chip({ tone = "neutral", icon, children, title }: { tone?: Tone; icon?: IconName; children: ReactNode; title?: string }) {
  return (
    <span className={`ac-chip ac-tone-${tone}`} title={title}>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </span>
  );
}

const STATUS_VIEW: Record<ConsoleStatus, { tone: Tone; icon: IconName }> = {
  awaiting: { tone: "attention", icon: "alert" },
  analyzing: { tone: "cloud", icon: "cpu" },
  sending: { tone: "cloud", icon: "send" },
  protected: { tone: "ok", icon: "policies" },
  restored: { tone: "ok", icon: "circle-check" },
  passed: { tone: "neutral", icon: "check" },
  blocked: { tone: "blocked", icon: "ban" },
  denied: { tone: "neutral", icon: "x" },
  failed: { tone: "blocked", icon: "circle-x" },
};

export function StatusChip({ status }: { status: ConsoleStatus }) {
  const v = STATUS_VIEW[status];
  return (
    <Chip tone={v.tone} icon={v.icon}>
      {STATUS_LABEL[status]}
    </Chip>
  );
}

/** Where a step ran, taken from the audit's `where`, never guessed. */
export function ProvenanceChip({ where }: { where: "on_device" | "in_cloud" | "code" | undefined }) {
  if (where === "on_device") return <Chip tone="ok" icon="cpu">On-device</Chip>;
  if (where === "in_cloud") return <Chip tone="cloud" icon="cloud">Cloud</Chip>;
  if (where === "code") return <Chip tone="neutral" icon="shield">Code, no AI</Chip>;
  return null;
}

export function Btn({
  variant = "secondary",
  size = "md",
  icon,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "soft" | "ghost" | "danger"; size?: "sm" | "md" | "lg"; icon?: IconName }) {
  return (
    <button type="button" {...rest} className={`ac-btn ac-btn-${variant} ac-btn-${size} ${rest.className ?? ""}`}>
      {icon && <Icon name={icon} size={size === "sm" ? 16 : 18} />}
      {children}
    </button>
  );
}

export function IconBtn({ icon, label, onClick, pressed }: { icon: IconName; label: string; onClick: () => void; pressed?: boolean }) {
  return (
    <button type="button" className="ac-iconbtn" aria-label={label} title={label} onClick={onClick} aria-pressed={pressed}>
      <Icon name={icon} size={20} />
    </button>
  );
}

export function Cradle({ icon, tone = "primary", size = 44 }: { icon: IconName; tone?: Tone; size?: 32 | 36 | 40 | 44 }) {
  return (
    <span className={`ac-cradle ac-tone-${tone}`} style={{ width: size, height: size }}>
      <Icon name={icon} size={size >= 40 ? 20 : 18} />
    </span>
  );
}

export function Card({ title, caption, aside, children, className = "", testId }: { title?: ReactNode; caption?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; testId?: string }) {
  return (
    <section className={`ac-card ${className}`} data-testid={testId}>
      {(title || aside) && (
        <header className="ac-card-head">
          <div>
            {title && <h2 className="ac-h2">{title}</h2>}
            {caption && <p className="ac-caption">{caption}</p>}
          </div>
          {aside && <div className="ac-card-aside">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  testId,
}: {
  options: ReadonlyArray<{ value: T; label: string; count?: number }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
  testId?: string;
}) {
  return (
    <div className="ac-seg" role="group" aria-label={label} data-testid={testId}>
      {options.map((o) => (
        <button key={o.value} type="button" className="ac-seg-btn" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
          {o.count !== undefined && <span className="ac-seg-count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: ReadonlyArray<{ value: T; label: string }>; value: T; onChange: (v: T) => void; label: string }) {
  const move = (dir: number): void => {
    const i = tabs.findIndex((t) => t.value === value);
    onChange(tabs[(i + dir + tabs.length) % tabs.length].value);
  };
  return (
    <div
      className="ac-tabs"
      role="tablist"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") move(1);
        if (e.key === "ArrowLeft") move(-1);
      }}
    >
      {tabs.map((t) => (
        <button key={t.value} type="button" role="tab" className="ac-tab" aria-selected={t.value === value} tabIndex={t.value === value ? 0 : -1} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="ac-empty">
      <Cradle icon={icon} tone="primary" />
      <p className="ac-empty-title">{title}</p>
      {children && <p className="ac-muted">{children}</p>}
      {action}
    </div>
  );
}

export function CopyBtn({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Btn
      variant="ghost"
      size="sm"
      icon={done ? "check" : "copy"}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? "Copied" : label}
    </Btn>
  );
}

/** Render text with [PLACEHOLDER_1] tokens as chips. */
export function Placeholders({ text }: { text: string }) {
  const parts = text.split(/(\[[A-Z_]+_\d+\])/g);
  return (
    <>
      {parts.map((p, i) => (/^\[[A-Z_]+_\d+\]$/.test(p) ? <mark key={i} className="ac-token">{p}</mark> : <span key={i}>{p}</span>))}
    </>
  );
}

/** A modal confirm dialog on the native <dialog> element: focus is trapped, Escape cancels, and focus returns to the opener. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="ac-dialog" aria-labelledby={titleId} onCancel={(e) => { e.preventDefault(); onCancel(); }} data-testid="confirm-dialog">
      <div className="ac-dialog-body">
        <h2 className="ac-h2" id={titleId}>{title}</h2>
        <div className="ac-dialog-text">{children}</div>
        <div className="ac-btn-row ac-dialog-actions">
          <Btn variant="secondary" onClick={onCancel} autoFocus>Cancel</Btn>
          <Btn variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={confirmDisabled} data-testid="confirm-dialog-ok">{confirmLabel}</Btn>
        </div>
      </div>
    </dialog>
  );
}

/** A labelled select. */
export function Select({ label, value, options, onChange, disabled, testId }: { label: string; value: string; options: ReadonlyArray<{ value: string; label: string }>; onChange: (v: string) => void; disabled?: boolean; testId?: string }) {
  return (
    <select className="ac-select" aria-label={label} value={value} disabled={disabled} data-testid={testId} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** A list of validation errors, each prefixed by the field path it is about. Nothing here ever shows a value. */
export function ErrorList({ errors, title = "Not saved: fix these first" }: { errors: readonly string[]; title?: string }) {
  if (errors.length === 0) return null;
  return (
    <div className="ac-banner ac-banner-blocked ac-errors" role="alert" data-testid="validation-errors">
      <b>{title}</b>
      <ul>
        {errors.map((e) => (
          <li key={e} className="ac-mono">{e}</li>
        ))}
      </ul>
    </div>
  );
}
