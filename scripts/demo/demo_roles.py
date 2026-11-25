"""Capture for the film: one stored record, three viewer roles, flipped live with the real mouse and keyboard in the real extension panel.

    node scripts/demo/setup-crm.mjs && node scripts/demo/capture-roles.mjs     (prepares EspoCRM, the extension and one contact)
    python scripts/demo/demo_roles.py

Writes scripts/out/demo/demo-roles-raw.mp4 and demo-roles-marks.json. Tabs: 1 = AIRLOCK web app, 2 = EspoCRM, 3 = extension panel (Policies).
"""
import json
import os
import sys
import time
import urllib.request

import pyautogui

sys.path.insert(0, os.path.dirname(__file__))
from demo_kit import Page, Recorder, move_click, raise_window, wait_for, window_rect  # noqa: E402

OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "out", "demo"))
state = json.load(open(os.path.join(OUT, "crm-state.json")))
RECORD = os.environ.get("RECORD", "1") != "0"
marks = {}
t0 = time.time()


def mark(name):
    marks[name] = round(time.time() - t0, 2)
    print(name, marks[name], flush=True)


def tabs():
    return json.load(urllib.request.urlopen("http://127.0.0.1:9222/json"))


# keep only the web app tab and the CRM tab; the panel opens third
for t in tabs():
    if t["type"] == "page" and "127.0.0.1:5173" not in t["url"] and "localhost:8080" not in t["url"]:
        urllib.request.urlopen("http://127.0.0.1:9222/json/close/" + t["id"])
panel_url = f"chrome-extension://{state['extId']}/sidepanel.html?tab={state['tabId']}#/policies"
urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:9222/json/new?" + panel_url, method="PUT"))
time.sleep(3)

crm = Page("localhost:8080")
crm.navigate("http://localhost:8080/")
time.sleep(1)
# land on the saved contact (setup left the hash on the new-contact form; capture-roles created the record)
cid = open(os.path.join(OUT, "crm-contact-id.txt")).read().strip()
crm.js(f"location.hash = '#Contact/view/{cid}'; true")
crm.front()
time.sleep(4)
win = raise_window("Rohan Mehta")
panel = Page("sidepanel.html")


def role_value():
    return panel.js("document.querySelector('[data-testid=\"viewer-role\"]')?.value")


def choose(downs):
    pyautogui.hotkey("ctrl", "3")
    time.sleep(1.5)
    if not panel.js("!!document.querySelector('[data-testid=\"viewer-role\"]')"):
        move_click(panel.screen_xy(text="Policies"), duration=0.7)  # the panel may have opened on another page
        time.sleep(1.5)
    wait_for(lambda: panel.js("!!document.querySelector('[data-testid=\"viewer-role\"]')"), "the Viewer role picker", 30)
    move_click(panel.screen_xy(selector='[data-testid="viewer-role"]'), duration=0.8)
    time.sleep(0.8)
    for _ in range(downs):
        pyautogui.press("down")
        time.sleep(0.35)
    pyautogui.press("enter")
    time.sleep(2)


def show_record():
    pyautogui.hotkey("ctrl", "2")
    time.sleep(1)
    pyautogui.press("f5")
    time.sleep(7)


rec = None
if RECORD:
    rec = Recorder(OUT, "demo-roles")
    rec.start(window_rect(win))
mark("start")
try:
    pyautogui.hotkey("ctrl", "2")
    time.sleep(4)
    mark("owner_view")
    time.sleep(1)
    choose(1)  # owner -> support
    mark("picked_" + str(role_value()))
    show_record()
    time.sleep(3)
    mark("support_view")
    choose(2)  # support -> analyst -> auditor
    mark("picked_" + str(role_value()))
    show_record()
    time.sleep(3)
    mark("auditor_view")
    time.sleep(1)
finally:
    if rec:
        rec.stop()
    with open(os.path.join(OUT, "demo-roles-marks.json"), "w") as f:
        json.dump(marks, f)
print("done", marks)
