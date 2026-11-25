import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { NanoAnalyzer } from "../ai/local.js";
import { DEFAULT_RULES } from "../flows/rules.js";
import type { InspectionStore } from "../inspect/session.js";
import type { AirlockHandle } from "../net/guard.js";
import { Console } from "./console/Console.js";
import type { ConsoleSource } from "./console/data.js";

/** Adapt the engine handle to the two observable objects the console reads. */
export type MountHandle = AirlockHandle & { inspection?: InspectionStore | null; inspectHosts?: readonly string[]; defaultRules?: typeof DEFAULT_RULES };

export function sourceOf(handle: MountHandle): ConsoleSource {
  return {
    registry: handle.registry,
    loadRules: () => handle.rules(),
    defaultRules: handle.defaultRules ?? DEFAULT_RULES,
    inspection: handle.inspection ?? null,
    inspectHosts: handle.inspectHosts ?? [],
    store: handle.store,
    audit: handle.audit,
    profileErrors: () => handle.profileErrors(),
    isReady: () => handle.engine.isReady(),
    setProtectedTerms: (terms) => handle.setProtectedTerms(terms),
    clearLocalData: () => handle.engine.clearLocalData(),
  };
}

/** The console docked beside the host app, with an Expand control that fills the viewport and hides the app. */
function Docked({ el, handle, analyzer, initialTerms }: { el: HTMLElement; handle: MountHandle; analyzer: NanoAnalyzer | null; initialTerms: string }) {
  const [expanded, setExpanded] = useState(false);
  const source = useMemo(() => sourceOf(handle), [handle]);
  useEffect(() => {
    el.toggleAttribute("data-al-expanded", expanded);
    const others = [...(el.parentElement?.children ?? [])].filter((c) => c !== el);
    others.forEach((c) => c.toggleAttribute("inert", expanded));
    return () => others.forEach((c) => c.removeAttribute("inert"));
  }, [el, expanded]);
  return <Console source={source} analyzer={analyzer} initialTerms={initialTerms} expanded={expanded} onToggleExpand={() => setExpanded((e) => !e)} />;
}

/** Render the AIRLOCK console into an element, docked beside the host app. */
export function mountInspector(el: HTMLElement, handle: MountHandle, analyzer: NanoAnalyzer | null, initialTerms: string): () => void {
  const root = createRoot(el);
  root.render(<Docked el={el} handle={handle} analyzer={analyzer} initialTerms={initialTerms} />);
  return () => root.unmount();
}
