"""Demo 1: the AI path. A contract goes to cloud Gemini; on-device Nano picks the passages; the user approves the exact payload.

    python scripts/demo/demo_ai.py          (dev server on 5173 and Chrome from scripts/chrome-nano.ps1 must be running)
"""
import os
import sys
import time

import pyautogui

sys.path.insert(0, os.path.dirname(__file__))
from demo_kit import Page, Recorder, move_click, raise_window, wait_for, window_rect  # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "..", "out", "demo")
page = Page("127.0.0.1:5173")
page.navigate("http://127.0.0.1:5173/")
time.sleep(3)
page.front()
time.sleep(1.5)
win = raise_window("AIRLOCK")
wait_for(lambda: "Ask Gemini" in page.text(), "the app", 60)

rec = Recorder(OUT, "demo-ai")
rec.start(window_rect(win))
try:
    rec.scene(
        "This is a sample employment contract, made-up data, with a salary, a bank account, a social security number and an API key. I want cloud AI to help me with it, "
        "but I do not want to hand it all over.",
        lambda: pyautogui.moveTo(1280, 700, duration=1.2),
    )

    def ask():
        move_click(page.screen_xy(text="Ask Gemini"))
        wait_for(lambda: "Awaiting your approval" in page.text(), "the approval gate", 240)

    rec.scene(
        "I ask a question and press Ask Gemini. First, Gemini Nano, running on this laptop, reads the document and picks only the passages this question needs.",
        ask,
    )
    time.sleep(1.5)

    def show_payload():
        # Over the Payload tab, not over the clause list: that list scrolls on its own and would take the wheel.
        xy = page.screen_xy(text="Payload")
        pyautogui.moveTo(xy[0] + 300, xy[1], duration=1.0)
        for _ in range(4):
            pyautogui.scroll(-300)
            time.sleep(1.4)
        time.sleep(2)

    rec.scene(
        "Nothing has left the machine yet. Nano chose five of the sixteen passages and the other eleven are withheld. "
        "Only the outbound text will be sent, with placeholders where the names, the bank account, the number and the key were. Deterministic code checks it, not a language model.",
        show_payload,
    )

    def approve():
        move_click(page.screen_xy(selector='[data-testid="drawer-approve"]'))
        wait_for(lambda: "Awaiting your approval" not in page.text('[data-testid="drawer"]'), "the send", 120)

    rec.scene("I approve it. Only now does one request go to cloud Gemini.", approve)
    time.sleep(2)
    rec.scene(
        "The cloud answered from placeholders, and I see my real values restored here, on this machine. The audit records what ran where, with counts and no values.",
        lambda: time.sleep(3),
    )
finally:
    rec.stop()
print(rec.finish())
