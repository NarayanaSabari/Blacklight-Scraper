#!/usr/bin/env python3
"""Capture LinkedIn session cookies for the centralD scraper account pool.

Flow:
  1. Asks for the account's proxy (the SAME proxy you'll set on the account in
     centralD — LinkedIn should see one consistent IP for login + scraping).
  2. Opens a real Chromium/Chrome window routed through that proxy.
  3. You log in to LinkedIn by hand (solve any 2FA / checkpoint).
  4. Once login is detected (the `li_at` auth cookie appears), it grabs the
     LinkedIn cookies, formats them as the JSON array centralD expects, and
     copies it to your clipboard.
  5. Paste into centralD -> Add Account -> "cookies" field.

Setup (one time):
    pip install playwright pyperclip
    playwright install chromium     # only needed if you don't have Chrome

Run:
    python scraper/scripts/capture_linkedin_cookies.py
"""

import json
import sys
import time

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("Missing dependency. Run:  pip install playwright pyperclip  &&  playwright install chromium")

LINKEDIN_LOGIN = "https://www.linkedin.com/login"
AUTH_COOKIE = "li_at"  # LinkedIn sets this only after a successful login
LOGIN_TIMEOUT_S = 600  # 10 minutes to finish logging in


def parse_proxy(raw):
    """Parse a proxy string into a Playwright proxy dict (or None if blank).

    Accepts any of:
      host:port:user:pass            (provider style — Decodo/Smartproxy/etc.)
      host:port
      user:pass@host:port
      http://[user:pass@]host:port   (scheme optional; https/socks5 also fine)
    """
    raw = raw.strip()
    if not raw:
        return None
    scheme = "http"
    if "://" in raw:
        scheme, raw = raw.split("://", 1)
    user = pw = None
    if "@" in raw:
        creds, raw = raw.rsplit("@", 1)
        user, _, pw = creds.partition(":")
        pw = pw or None
    parts = raw.split(":")
    if len(parts) == 4 and user is None:  # host:port:user:pass
        host, port, user, pw = parts
    elif len(parts) >= 2:  # host:port[:...]
        host, port = parts[0], parts[1]
    else:  # host only
        host, port = parts[0], None
    if not host:
        return None
    server = f"{scheme}://{host}" + (f":{port}" if port else "")
    proxy = {"server": server}
    if user:
        proxy["username"] = user
    if pw:
        proxy["password"] = pw
    return proxy


def prompt_proxy():
    """Ask for the account's proxy. Returns a Playwright proxy dict or None."""
    print("=== Proxy for this account ===")
    print("Use the SAME proxy you will assign to this account in centralD.")
    raw = input("Proxy (host:port:user:pass  OR  http://[user:pass@]host:port), blank for none: ").strip()
    if not raw:
        confirm = input("No proxy — real accounts should use one. Continue without? [y/N]: ").strip().lower()
        if confirm != "y":
            sys.exit("Aborted. Re-run and supply a proxy.")
        return None

    proxy = parse_proxy(raw)
    if not proxy or not proxy.get("server"):
        sys.exit(f"Could not parse proxy: {raw!r}")

    # Creds not in the string -> ask separately.
    if "username" not in proxy:
        user = input("Proxy username (blank if none): ").strip()
        if user:
            proxy["username"] = user
            pw = input("Proxy password (blank if none): ").strip()
            if pw:
                proxy["password"] = pw

    masked = "•••" if proxy.get("password") else "-"
    print(f"\nUsing proxy: {proxy['server']}  (user: {proxy.get('username', '-')}, pass: {masked})")
    return proxy


def copy_to_clipboard(text):
    """Copy text to the OS clipboard. Returns True on success."""
    try:
        import pyperclip

        pyperclip.copy(text)
        return True
    except Exception:
        pass
    # macOS fallback without pyperclip.
    try:
        import subprocess

        subprocess.run(["pbcopy"], input=text.encode(), check=True)
        return True
    except Exception:
        return False


def launch_browser(p, proxy):
    """Prefer real Chrome (least detectable); fall back to bundled Chromium."""
    args = ["--disable-blink-features=AutomationControlled"]
    kwargs = {"headless": False, "args": args}
    if proxy:
        kwargs["proxy"] = proxy
    try:
        return p.chromium.launch(channel="chrome", **kwargs)
    except Exception:
        return p.chromium.launch(**kwargs)


def main():
    proxy = prompt_proxy()

    with sync_playwright() as p:
        browser = launch_browser(p, proxy)
        context = browser.new_context(locale="en-US")
        page = context.new_page()

        print(f"\nOpening LinkedIn login{' via proxy' if proxy else ''} ...")
        try:
            page.goto(LINKEDIN_LOGIN, wait_until="domcontentloaded", timeout=60_000)
        except Exception as err:
            print(f"⚠️  Could not load LinkedIn ({err}). Check the proxy and try again.")
            browser.close()
            sys.exit(1)

        print("\n>>> Log in to LinkedIn in the opened window (solve any 2FA / checkpoint). <<<")
        print("    Waiting for login to complete — I'll detect it automatically...\n")

        deadline = time.time() + LOGIN_TIMEOUT_S
        logged_in = False
        while time.time() < deadline:
            try:
                if any(c["name"] == AUTH_COOKIE for c in context.cookies()):
                    logged_in = True
                    break
            except Exception:
                pass  # page mid-navigation; retry
            time.sleep(2)

        if not logged_in:
            print(f"Timed out after {LOGIN_TIMEOUT_S // 60} min — no `{AUTH_COOKIE}` cookie. Aborting.")
            browser.close()
            sys.exit(1)

        # Let the remaining session cookies settle, then capture.
        time.sleep(3)
        cookies = [c for c in context.cookies() if "linkedin.com" in c.get("domain", "")]
        payload = json.dumps(cookies, indent=2)

        has_auth = any(c["name"] == AUTH_COOKIE for c in cookies)
        print(f"\n✅ Captured {len(cookies)} LinkedIn cookies (li_at present: {has_auth}).")

        if copy_to_clipboard(payload):
            print("📋 Copied to your clipboard — paste into centralD → Add Account → cookies field.")
            print("   (Set the SAME proxy on that account, and a profile_key like li-acct-1.)")
        else:
            print("⚠️  Clipboard unavailable — copy this JSON manually:\n")
            print(payload)

        input("\nPress Enter to close the browser...")
        browser.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted.")
