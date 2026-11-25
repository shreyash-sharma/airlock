"""Capture for the film: "Find it in the document. Now find it on the wire." Everything is real: pyautogui mouse and keyboard, Chrome's own PDF
viewer and Find bar, the exact request body Chrome sent (recorded by capture-wire.mjs from Chrome's network layer), ffmpeg window capture.

    node scripts/demo/make-offer-pdf.mjs                 (once)
    node scripts/demo/capture-wire.mjs &                 (start first; it exits after one request)
    python scripts/demo/demo_wire.py                     (RECORD=0 python ... to explore without video)

Writes scripts/out/demo/demo-wire-raw.mp4 and demo-wire-marks.json (seconds from the start of the recording for each beat).
"""
import json
import os
import sys
import time
import urllib.request

import pyautogui

sys.path.insert(0, os.path.dirname(__file__))
from demo_kit import Page, Recorder, move_click, raise_window, wait_for, window_rect  # noqa: E402

HERE = os.path.dirname(__file__)
OUT = os.path.abspath(os.path.join(HERE, "..", "out", "demo"))
PDF = os.path.abspath(os.path.join(HERE, "..", "out", "offer-letter.pdf"))
BODY = os.path.join(OUT, "wire-body.txt")
SHA = os.path.join(OUT, "wire-body.sha256.txt")
RECORD = os.environ.get("RECORD", "1") != "0"
assert os.path.exists(PDF), "run make-offer-pdf.mjs first"
if os.path.exists(BODY):
    os.remove(BODY)
if os.path.exists(SHA):
    os.remove(SHA)
marks = {}
t0 = time.time()


def mark(name):
    marks[name] = round(time.time() - t0, 2)
    print(name, marks[name], flush=True)


def shot(name):
    pyautogui.screenshot(os.path.join(OUT, f"wire-{name}.png"))


def tabs():
    return json.load(urllib.request.urlopen("http://127.0.0.1:9222/json"))


def close_tabs(part):
    for t in tabs():
        if t["type"] == "page" and part in t["url"]:
            urllib.request.urlopen("http://127.0.0.1:9222/json/close/" + t["id"])


def new_tab(path):
    urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:9222/json/new?file:///" + path.replace(os.sep, "/"), method="PUT"))
    time.sleep(2.5)


def find(term, hold=2.6):
    pyautogui.hotkey("ctrl", "f")
    time.sleep(0.8)
    pyautogui.hotkey("ctrl", "a")
    pyautogui.write(term, interval=0.07)
    pyautogui.press("enter")
    time.sleep(hold)


close_tabs("offer-letter.pdf")
close_tabs("wire-body")
new_tab(PDF)
pdf = Page("offer-letter.pdf")
app0 = Page("127.0.0.1:5173")
app0.front()
time.sleep(1)
win = raise_window("AIRLOCK")  # the window title is the active tab's title, so raise it while the app tab is in front
pdf.front()
time.sleep(1.5)

rec = None
if RECORD:
    rec = Recorder(OUT, "demo-wire")
    rec.start(window_rect(win))
mark("start")
try:
    # 1. the contract in Chrome's own PDF viewer; find the secrets
    time.sleep(3)
    for term in ("GB82", "536-90", "sk_live"):
        find(term)
        mark("find_" + term)
        shot("pdf-" + term)
    pyautogui.press("escape")
    time.sleep(1)

    # 2. the same PDF through AIRLOCK
    app = Page("127.0.0.1:5173")
    app.navigate("http://127.0.0.1:5173/")
    time.sleep(3)
    app.front()
    pyautogui.hotkey("ctrl", "1")  # the real keyboard switches to the first tab, the AIRLOCK app
    time.sleep(1.5)
    wait_for(lambda: "Open .txt or PDF" in app.text(), "the app", 60)
    mark("app_open")
    move_click(app.screen_xy(text="Open .txt or PDF"))
    import win32gui

    def dialog_open():
        found = []
        win32gui.EnumWindows(lambda h, _: found.append(h) if win32gui.GetClassName(h) == "#32770" and win32gui.IsWindowVisible(h) else None, None)
        return found

    wait_for(dialog_open, "the file dialog", 15)
    time.sleep(1.2)
    pyautogui.write(PDF, interval=0.01)
    pyautogui.press("enter")
    wait_for(lambda: "offer-letter.pdf" in app.text(), "the PDF to load", 60)
    time.sleep(1.5)
    mark("pdf_loaded")
    move_click(app.screen_xy(text="Ask Gemini"))
    mark("ask_clicked")
    wait_for(lambda: "Awaiting your approval" in app.text(), "the approval gate", 240)
    mark("gate")
    time.sleep(1.5)
    move_click(app.screen_xy(selector='[data-testid="drawer-approve"]'))
    mark("approve_clicked")
    wait_for(lambda: "Awaiting your approval" not in app.text('[data-testid="drawer"]'), "the send", 120)
    time.sleep(2.5)
    mark("answer")
    shot("after-answer")

    # 3. the exact bytes Chrome sent: search them with Chrome's own Find, then compare the hash
    wait_for(lambda: os.path.exists(BODY) and os.path.exists(SHA), "the captured request body (is capture-wire.mjs running?)", 20)
    new_tab(BODY)
    wire = Page("wire-body.txt")
    wire.front()
    time.sleep(2)
    mark("body_open")
    shot("body")
    for term in ("GB82", "536-90", "sk_live", "IBAN_1"):
        find(term)
        mark("wire_" + term)
        shot("wire-" + term)
    pyautogui.press("escape")
    new_tab(SHA)
    Page("wire-body.sha256.txt").front()
    time.sleep(3)
    mark("sha_open")
    shot("sha")
    pyautogui.hotkey("ctrl", "1")
    time.sleep(3)
    mark("hash_in_app")
    shot("hash-in-app")
    time.sleep(2)
finally:
    if rec:
        rec.stop()
    with open(os.path.join(OUT, "demo-wire-marks.json"), "w") as f:
        json.dump(marks, f)
print("done", marks)
if os.path.exists(SHA):
    print(open(SHA).read())
