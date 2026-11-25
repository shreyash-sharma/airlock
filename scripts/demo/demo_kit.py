"""Small kit for recording a narrated demo of AIRLOCK on the real machine.

What it does, with nothing faked:
  - drives the visible Chrome window with the real mouse and keyboard (pyautogui); Chrome DevTools is used only to
    read where an element is on screen and what the page says, never to click for the demo;
  - records the desktop with ffmpeg (gdigrab);
  - narrates with the Windows speech synthesizer (SAPI) and burns the captions in with ffmpeg.

Synthetic data only. Needs: Python 3.11, pyautogui, websockets, Pillow (already used by this project's scripts), ffmpeg
on PATH, and Chrome started with scripts/chrome-nano.ps1 (remote debugging on 9222).
"""
import asyncio
import ctypes
import json
import os
import subprocess
import threading
import time
import urllib.request
import wave

import pyautogui
import websockets

ctypes.windll.user32.SetProcessDPIAware()
pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0.02

PORT = int(os.environ.get("CDP_PORT", "9222"))
FONT = "C\\:/Windows/Fonts/segoeui.ttf"


class Page:
    """One Chrome tab over DevTools, used for reading only."""

    def __init__(self, url_part):
        tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
        tab = next(t for t in tabs if t["type"] == "page" and url_part in t["url"])
        self.id = tab["id"]
        self.ws_url = tab["webSocketDebuggerUrl"]
        self.loop = asyncio.new_event_loop()
        self.ws = self.loop.run_until_complete(websockets.connect(self.ws_url, max_size=None))
        self.n = 0

    def send(self, method, params=None):
        self.n += 1
        mid = self.n

        async def go():
            await self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
            while True:
                msg = json.loads(await self.ws.recv())
                if msg.get("id") == mid:
                    return msg.get("result", {})

        return self.loop.run_until_complete(go())

    def js(self, expr):
        r = self.send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
        return r.get("result", {}).get("value")

    def front(self):
        self.send("Page.bringToFront")

    def maximize(self):
        w = self.send("Browser.getWindowForTarget", {"targetId": self.id})
        self.send("Browser.setWindowBounds", {"windowId": w["windowId"], "bounds": {"windowState": "maximized"}})

    def navigate(self, url):
        self.send("Page.navigate", {"url": url})

    def text(self, selector="body"):
        return self.js(f"document.querySelector({json.dumps(selector)})?.innerText ?? ''") or ""

    def screen_xy(self, selector=None, text=None, nth=0):
        """Centre of an element in physical screen pixels, found by CSS selector or by visible text."""
        find = (
            f"[...document.querySelectorAll({json.dumps(selector)})][{nth}]"
            if selector
            else f"[...document.querySelectorAll('button,a,[role=tab],summary,label')].filter(e => e.offsetParent && e.textContent.trim().includes({json.dumps(text)}))[{nth}]"
        )
        r = self.js(
            f"""(() => {{ const e = {find}; if (!e) return null; e.scrollIntoView({{block: 'center', behavior: 'instant'}});
            const b = e.getBoundingClientRect();
            return {{x: b.x + b.width / 2, y: b.y + b.height / 2, sx: window.screenX, sy: window.screenY,
              chrome: window.outerHeight - window.innerHeight, dpr: window.devicePixelRatio}}; }})()"""
        )
        if not r:
            return None
        return ((r["sx"] + r["x"]) * r["dpr"], (r["sy"] + r["chrome"] + r["y"]) * r["dpr"])


def raise_window(title_part):
    """Bring one named Chrome window (the dedicated automation one) to the front and maximize it. Other windows are not touched."""
    import win32con
    import win32gui

    found = []
    win32gui.EnumWindows(lambda h, _: found.append(h) if title_part in win32gui.GetWindowText(h) and win32gui.GetClassName(h) == "Chrome_WidgetWin_1" else None, None)
    if not found:
        raise RuntimeError(f"no window titled like {title_part!r}")
    h = found[0]
    win32gui.ShowWindow(h, win32con.SW_RESTORE)
    win32gui.ShowWindow(h, win32con.SW_MAXIMIZE)
    pyautogui.press("alt")  # lets SetForegroundWindow succeed from a background process
    try:
        win32gui.SetForegroundWindow(h)
    except Exception:
        pass
    time.sleep(1.0)
    return h


def window_rect(h):
    """The visible part of a window, clipped to the screen (a maximized window overhangs by its border)."""
    import win32gui

    l, t, r, b = win32gui.GetWindowRect(h)
    sw, sh = pyautogui.size()
    l, t, r, b = max(l, 0), max(t, 0), min(r, sw), min(b, sh - 60)  # keep the taskbar out
    return (l, t, r - l, b - t)


def move_click(xy, duration=0.7):
    pyautogui.moveTo(xy[0], xy[1], duration=duration, tween=pyautogui.easeInOutQuad)
    time.sleep(0.15)
    pyautogui.click()


def wait_for(fn, label, timeout=120, every=0.8):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = fn()
        if v:
            return v
        time.sleep(every)
    raise TimeoutError(f"timed out waiting for: {label}")


def tts(text, path):
    """Narration with the Windows speech synthesizer. Returns the wav duration in seconds."""
    ps = (
        "Add-Type -AssemblyName System.Speech;"
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        "$s.SelectVoice('Microsoft Zira Desktop'); $s.Rate = 0;"
        f"$s.SetOutputToWaveFile('{path}'); $s.Speak([Console]::In.ReadToEnd()); $s.Dispose()"
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], input=text.encode("utf8"), check=True)
    with wave.open(path) as w:
        return w.getnframes() / w.getframerate()


class Recorder:
    def __init__(self, out_dir, name):
        self.dir = out_dir
        os.makedirs(out_dir, exist_ok=True)
        self.name = name
        self.raw = os.path.join(out_dir, f"{name}-raw.mp4")
        self.cues = []  # (start, end, text, wav)
        self.t0 = None
        self.proc = None

    def start(self, rect=None):
        """rect = (x, y, w, h) in physical pixels: record only that region (the browser window), never the whole desktop."""
        region = []
        if rect:
            x, y, w, h = [int(v) for v in rect]
            region = ["-offset_x", str(x), "-offset_y", str(y), "-video_size", f"{w - w % 2}x{h - h % 2}"]
        self.proc = subprocess.Popen(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "gdigrab", "-framerate", "30", "-draw_mouse", "1", *region, "-i", "desktop",
             "-vf", "scale=1920:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", self.raw],
            stdin=subprocess.PIPE,
        )
        self.t0 = time.time()
        time.sleep(1.0)

    def stop(self):
        self.proc.stdin.write(b"q")
        self.proc.stdin.flush()
        self.proc.wait(timeout=60)

    def scene(self, text, action=None, min_gap=0.4):
        """Say a line while an action runs. The scene lasts until both the speech and the action are done."""
        wav = os.path.join(self.dir, f"{self.name}-{len(self.cues):02d}.wav")
        dur = tts(text, wav)
        start = time.time() - self.t0
        err = []
        th = None
        if action:
            def run():
                try:
                    action()
                except Exception as e:  # surfaced after the scene so the narration is not cut off
                    err.append(e)

            th = threading.Thread(target=run)
            th.start()
        time.sleep(dur)
        if th:
            th.join()
        if err:
            raise err[0]
        self.cues.append((start, start + dur, text, wav))
        time.sleep(min_gap)

    def finish(self, final_name=None):
        """Burn the captions in and lay the narration over the recording."""
        final = os.path.join(self.dir, final_name or f"{self.name}.mp4")
        inputs = ["-i", self.raw]
        filters = []
        for _, _, _, wav in self.cues:
            inputs += ["-i", wav]
        draw = []
        for start, end, text, _ in self.cues:
            safe = text.replace("\\", "").replace("'", "’").replace(":", "\\:").replace("%", "\\%").replace(",", "\\,")
            # wrap at about 70 characters
            words, lines, cur = safe.split(" "), [], ""
            for w in words:
                if len(cur) + len(w) > 70:
                    lines.append(cur)
                    cur = ""
                cur += (" " if cur else "") + w
            lines.append(cur)
            tf = os.path.join(self.dir, f"{self.name}-cap{len(draw):02d}.txt")
            with open(tf, "w", encoding="utf8") as f:
                f.write("\n".join(l.replace("\\:", ":").replace("\\,", ",").replace("\\%", "%") for l in lines))
            draw.append(
                f"drawtext=fontfile='{FONT}':textfile='{tf.replace(os.sep, '/').replace(':', chr(92) + ':')}':fontsize=30:fontcolor=white:"
                f"box=1:boxcolor=black@0.62:boxborderw=14:x=(w-text_w)/2:y=h-text_h-48:enable='between(t,{start:.2f},{end + 0.3:.2f})'"
            )
        vf = ",".join(draw) if draw else "null"
        amix = []
        for i, (start, _, _, _) in enumerate(self.cues):
            amix.append(f"[{i + 1}:a]adelay={int(start * 1000)}|{int(start * 1000)}[a{i}]")
        mixin = "".join(f"[a{i}]" for i in range(len(self.cues)))
        fc = f"[0:v]{vf}[v];" + ";".join(amix) + f";{mixin}amix=inputs={len(self.cues)}:normalize=0[a]"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", fc, "-map", "[v]", "-map", "[a]",
             "-c:v", "libx264", "-preset", "medium", "-crf", "21", "-c:a", "aac", "-b:a", "160k", "-shortest", final],
            check=True,
        )
        return final
