import "@fontsource/plus-jakarta-sans/400.css";
import "@fontsource/plus-jakarta-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./host/base.css";
import "./host/host.css";
import { createRoot } from "react-dom/client";
import { installAirlock } from "./airlock/index.js";
import { getLocalJsonModel } from "./firebase.js";
import { App } from "./host/App.js";

// The one AIRLOCK line: install before any SDK request so every guarded call is held and inspected.
installAirlock({
  localModel: getLocalJsonModel,
  protectedTerms: ["Maria Sofia Alvarez", "Daniel Alvarez", "47 Linden Row"],
  mount: document.getElementById("airlock-root")!,
});

createRoot(document.getElementById("host-root")!).render(<App />);
