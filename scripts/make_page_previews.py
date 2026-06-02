"""
Composite preview: wordmark on sidebar + page title for trade/agent/balance
Uses the actual logo PNGs on a dark background representative of the sidebar.
"""
from PIL import Image, ImageDraw
import os

LOGOS = r"C:\arc-swap-v9\assets\logos"
OUT   = r"C:\arc-swap-v9"

wm = Image.open(os.path.join(LOGOS, "wordmark-oneliq.png")).convert("RGBA")
mk = Image.open(os.path.join(LOGOS, "mark-oneliq.png")).convert("RGBA")

BG_MAIN  = (11, 26, 48)    # #0B1A30  page bg
BG_SIDE  = (8, 17, 33)     # #08111F  sidebar bg
BORDER   = (20, 45, 80)    # sidebar border

PAGES = [
    (".preview-trade.png",   "TRADE",   "Swap · Bridge · All-in-one"),
    (".preview-agent.png",   "AGENT",   "Auto-Replenish · Move USDC"),
    (".preview-balance.png", "BALANCE", "Unified Balance · Circle Gateway"),
]

def make_preview(filename, title, subtitle):
    W, H = 800, 200
    img = Image.new("RGB", (W, H), BG_MAIN)
    draw = ImageDraw.Draw(img)

    # Sidebar strip
    draw.rectangle([0, 0, 178, H], fill=BG_SIDE)
    draw.line([(178, 0), (178, H)], fill=BORDER, width=1)

    # Wordmark in sidebar (top-left, like the real UI)
    wm_h = 22
    r = wm_h / wm.height
    wm_r = wm.resize((int(wm.width * r), wm_h), Image.LANCZOS)
    img.paste(wm_r, (18, 20), wm_r)

    # TESTNET pill (approximated as a teal rect)
    pill_x, pill_y = 18, 50
    draw.rounded_rectangle([pill_x, pill_y, pill_x+62, pill_y+14],
                           radius=7, fill=(8, 40, 52), outline=(30, 140, 150))

    # Page title in main area
    draw.rectangle([180, 0, W, H], fill=BG_MAIN)

    # Title text (large, bold-ish using default font — Pillow default is small)
    # Use a simple large rectangle as a placeholder title block
    draw.text((220, 55), title,    fill=(245, 247, 251), font=None)
    draw.text((220, 80), subtitle, fill=(100, 130, 160), font=None)

    out_path = os.path.join(OUT, filename)
    img.save(out_path, "PNG")
    print(f"Saved {out_path}")

for fn, title, subtitle in PAGES:
    make_preview(fn, title, subtitle)

print("Done.")
