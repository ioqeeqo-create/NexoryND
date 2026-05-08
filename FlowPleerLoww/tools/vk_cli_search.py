#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import argparse
import html
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import quote_plus


def out(payload):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    print(json.dumps(payload, ensure_ascii=False))


def strip_html_tags(value):
    if not value:
        return ""
    return re.sub(r"<[^>]+>", "", str(value)).strip()


def is_authenticated(driver):
    try:
        cookies = driver.get_cookies() or []
        cookie_names = {str(c.get("name", "")).lower() for c in cookies}
        if "remixsid" in cookie_names or "remixsid6" in cookie_names:
            return True
    except Exception:
        pass
    try:
        html_src = (driver.page_source or "").lower()
        if 'name="email"' in html_src or 'name="login"' in html_src:
            return False
    except Exception:
        pass
    return False


def parse_audio_rows(page_html, limit, metadata_only=False):
    results = []
    seen = set()
    # VK stores metadata JSON in data-audio="[...]"
    for m in re.finditer(r'data-audio="([^"]+)"', page_html):
        raw = html.unescape(m.group(1))
        try:
            data = json.loads(raw)
        except Exception:
            continue
        if not isinstance(data, list) or len(data) < 6:
            continue

        track_id = data[0]
        url = str(data[2] or "")
        title = strip_html_tags(data[3] or "")
        artist = strip_html_tags(data[4] or "")

        if (not metadata_only) and (not url or "audio_api_unavailable" in url):
            continue
        if not title:
            continue

        uid = f"{data[1]}_{track_id}"
        if uid in seen:
            continue
        seen.add(uid)

        results.append(
            {
                "id": str(track_id),
                "title": title,
                "artist": artist or "—",
                "url": url if url and "audio_api_unavailable" not in url else None,
                "cover": None,
                "source": "vk",
            }
        )
        if len(results) >= limit:
            break
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--query", required=False, default="")
    parser.add_argument("--playlist-url", required=False, default="")
    parser.add_argument("--limit", type=int, default=20)
    args = parser.parse_args()
    limit = max(1, min(args.limit, 400))
    query = str(args.query or "").strip()
    playlist_url = str(args.playlist_url or "").strip()
    if not query and not playlist_url:
        out({"ok": False, "error": "query or playlist-url required"})
        return

    try:
        from selenium import webdriver
        from selenium.webdriver.common.by import By
        from selenium.webdriver.chrome.service import Service
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.support.ui import WebDriverWait
        from webdriver_manager.chrome import ChromeDriverManager
    except Exception as exc:
        out({"ok": False, "error": f"python deps missing: {exc}"})
        return

    options = webdriver.ChromeOptions()
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_argument("--start-maximized")

    profile_dir = Path(os.getenv("LOCALAPPDATA", ".")) / "Flow" / "vk_chrome_profile"
    profile_dir.mkdir(parents=True, exist_ok=True)
    options.add_argument(f"--user-data-dir={profile_dir}")

    driver = None
    try:
        driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=options)
        driver.get("https://vk.com/")

        # Wait until user is authenticated.
        auth_deadline = time.time() + 120
        while time.time() < auth_deadline:
            if is_authenticated(driver):
                break
            time.sleep(1.0)
        else:
            out({"ok": False, "error": "vk login timeout: войди в VK в открытом окне Chrome и повтори импорт"})
            return

        target_url = playlist_url if playlist_url else f"https://vk.com/audio?q={quote_plus(query)}&section=search"
        driver.get(target_url)

        try:
            WebDriverWait(driver, 15).until(EC.presence_of_element_located((By.CSS_SELECTOR, ".audio_row, [data-audio]")))
        except Exception:
            pass

        # Scroll to load more.
        for _ in range(6):
            driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
            time.sleep(0.8)

        metadata_only = bool(playlist_url)
        tracks = []
        # Primary path: extract data-audio directly from live DOM.
        try:
            rows = driver.execute_script(
                """
                const nodes = Array.from(document.querySelectorAll('[data-audio]'));
                return nodes.map(n => n.getAttribute('data-audio')).filter(Boolean);
                """
            ) or []
            for raw in rows:
                try:
                    data = JSON.parse(raw)
                except Exception:
                    continue
                if not isinstance(data, list) or len(data) < 6:
                    continue
                url = str(data[2] or "")
                if (not metadata_only) and (not url or "audio_api_unavailable" in url):
                    continue
                title = strip_html_tags(data[3] or "")
                artist = strip_html_tags(data[4] or "")
                if not title:
                    continue
                tracks.append({
                    "id": str(data[0]),
                    "title": title,
                    "artist": artist or "—",
                    "url": url if url and "audio_api_unavailable" not in url else None,
                    "cover": None,
                    "source": "vk",
                })
                if len(tracks) >= limit:
                    break
        except Exception:
            tracks = []

        # Fallback path: parse page HTML.
        if not tracks:
            tracks = parse_audio_rows(driver.page_source or "", limit, metadata_only=metadata_only)

        if playlist_url and not tracks:
            out({"ok": False, "error": "vk playlist bridge: треки не видны без авторизации VK"})
            return
        out({"ok": True, "tracks": tracks})
    except Exception as exc:
        out({"ok": False, "error": f"vk bridge failed: {exc}"})
    finally:
        if driver is not None:
            try:
                driver.quit()
            except Exception:
                pass


if __name__ == "__main__":
    main()
