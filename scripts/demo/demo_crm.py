"""Demo 2: a REAL third-party CRM (EspoCRM, self-hosted in Docker) protected by the AIRLOCK extension, on the real machine.

    node scripts/demo/setup-crm.mjs      (prepares the state; see that file)
    python scripts/demo/demo_crm.py

The profile in use was authored by Gemini Nano in an earlier real run on this machine and corrected by the user; the video says so.
"""
import base64
import json
import os
import sys
import time
import urllib.parse
import urllib.request

import pyautogui

sys.path.insert(0, os.path.dirname(__file__))
from demo_kit import Page, Recorder, move_click, raise_window, wait_for, window_rect  # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "..", "out", "demo")
state = json.load(open(os.path.join(OUT, "crm-state.json")))
AUTH = "Basic " + base64.b64encode(b"admin:airlock-demo-admin").decode()
CRM = "http://localhost:8080"

ROHAN = dict(first="Rohan", last="Mehta", email="rohan.mehta@example.com", phone="+91 98765 43210", city="Pune", note="Renewal is at risk; wants a discount")

crm = Page("localhost:8080")
win = raise_window("Create Contact")
crm.front()
wait_for(lambda: crm.js("!!document.querySelector('input[data-name=\"firstName\"]')"), "the Contact form", 60)


def crm_panel_xy(text):
    return Page("sidepanel.html").screen_xy(text=text)


def type_into(sel, text):
    move_click(crm.screen_xy(selector=sel), duration=0.5)
    pyautogui.write(text, interval=0.045)


def rest_view():
    req = urllib.request.Request(f"{CRM}/api/v1/Contact?maxSize=5", headers={"Authorization": AUTH})
    c = json.load(urllib.request.urlopen(req))["list"][0]
    rows = {k: c.get(k) for k in ("name", "emailAddress", "phoneNumber", "addressCity", "description")}
    body = json.dumps(rows, indent=2)
    return (
        "<html><body style='font:20px Consolas,monospace;padding:28px;background:#101418;color:#e6edf3'>"
        "<h2 style='font-family:Segoe UI;margin:0 0 6px'>What EspoCRM stored</h2>"
        "<div style='color:#9aa7b4;font-family:Segoe UI;margin-bottom:18px'>GET /api/v1/Contact, straight from the CRM's own API, not through the page</div>"
        f"<pre style='white-space:pre-wrap'>{body}</pre></body></html>"
    )


rec = Recorder(OUT, "demo-crm")
rec.start(window_rect(win))
try:
    rec.scene(
        "This is EspoCRM, a real open source CRM running in Docker on this PC. It knows nothing about AIRLOCK. "
        "The AIRLOCK extension is watching this site, and a profile that Gemini Nano wrote on this machine, then corrected by me, is saved for it.",
        lambda: pyautogui.moveTo(1500, 700, duration=1.5),
    )

    def fill():
        type_into('input[data-name="firstName"]', ROHAN["first"])
        type_into('input[data-name="lastName"]', ROHAN["last"])
        type_into('.field[data-name="emailAddress"] input.email-address', ROHAN["email"])
        type_into('input[data-name="addressCity"]', ROHAN["city"])
        type_into('textarea[data-name="description"]', ROHAN["note"])

    rec.scene("I create a customer the way anyone would, with made-up details: a name, an email, a city and a private note.", fill)

    def save():
        move_click(crm.screen_xy(selector='button[data-action="save"]'))
        wait_for(lambda: "#Contact/view/" in (crm.js("location.hash") or ""), "the saved contact", 90)
        time.sleep(2)

    rec.scene("I press Save. It is saved at once. Nothing waits for me, and the CRM is not interrupted.", save)
    rec.scene(
        "EspoCRM shows me my real values, because AIRLOCK restores them on the way back.",
        lambda: pyautogui.moveTo(1400, 600, duration=1.2),
    )

    def show_rest():
        html = rest_view()
        path = os.path.abspath(os.path.join(OUT, "crm-rest.html"))
        with open(path, "w", encoding="utf8") as f:
            f.write(html)
        url = "file:///" + path.replace(os.sep, "/")
        urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:9222/json/new?" + url, method="PUT"))
        time.sleep(2)
        time.sleep(3)

    rec.scene(
        "Now what EspoCRM really stored, read straight from its own API. A stand-in name, a stand-in email, and a token for the note. None of what I typed.",
        show_rest,
    )

    def show_panel():
        url = f"chrome-extension://{state['extId']}/sidepanel.html?tab={state['tabId']}#/traffic"
        urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:9222/json/new?" + url, method="PUT"))
        time.sleep(3)
        move_click(crm_panel_xy("Traffic"))
        time.sleep(2)
        move_click(crm_panel_xy("Needs review"))
        time.sleep(2)

    rec.scene(
        "AIRLOCK's console lists what it did with every request, including that one. For a CRM it never blocks and never makes you wait. "
        "Anything worth a later look goes into a review queue.",
        show_panel,
    )
    rec.scene(
        "The limit is honest. Without a profile, only emails, phones and keys are caught, not names. The profile is what protects the rest, and it came from hybrid inference with me in the loop.",
        lambda: time.sleep(4),
    )
finally:
    rec.stop()
print(rec.finish())
