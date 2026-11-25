/**
 * The page behind crm-ext.html: sends the same synthetic contact to the mock CRM (a stand-in for Salesforce or
 * HubSpot) through fetch and XMLHttpRequest, and shows what the page received. No AIRLOCK code is loaded here, so
 * anything that is held or protected is the Chrome extension's doing. Used by scripts/e2e-ext.mjs.
 */
const API = "/mock-crm/api/contacts";
const SAMPLE = {
  properties: {
    firstname: "Rohan",
    lastname: "Mehta",
    email: "rohan.mehta@example.com",
    phone: "9876543210",
    city: "Pune",
    plan: "Enterprise",
    salary: "68000",
    internal_note: "Renewal is at risk; the buyer wants a discount before signing.",
  },
};

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const errors: string[] = [];
const fail = (what: string, err: unknown): void => {
  errors.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
  $("errors").textContent = errors.join("\n");
};

async function viaFetch(method: string, body: string | null): Promise<void> {
  try {
    const res = await fetch(API, { method, headers: body === null ? {} : { "content-type": "application/json" }, body });
    $("out-fetch").textContent = `${method} via fetch -> HTTP ${res.status}\n${await res.text()}`;
  } catch (err) {
    fail(`${method} via fetch`, err);
  }
}

function viaXhr(method: string, body: string | null): void {
  const xhr = new XMLHttpRequest();
  xhr.open(method, API);
  if (body !== null) xhr.setRequestHeader("content-type", "application/json");
  xhr.onload = () => ($("out-xhr").textContent = `${method} via XHR -> HTTP ${xhr.status}\n${xhr.responseText}`);
  xhr.onerror = () => fail(`${method} via XHR`, new Error("network error (blocked or failed)"));
  xhr.send(body);
}

$("create-fetch").addEventListener("click", () => void viaFetch("POST", JSON.stringify(SAMPLE)));
$("create-xhr").addEventListener("click", () => viaXhr("POST", JSON.stringify(SAMPLE)));
$("clear-errors").addEventListener("click", () => {
  errors.length = 0;
  $("errors").textContent = "";
});
$("list-fetch").addEventListener("click", () => void viaFetch("GET", null));
