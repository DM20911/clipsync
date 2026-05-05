#!/usr/bin/env python3
"""Composite QR code + credits onto the ClipSync architecture image."""
import qrcode
from PIL import Image, ImageDraw, ImageFont
import os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC  = os.path.join(ROOT, "..", "clipsync_architecture.png")
OUT  = os.path.join(ROOT, "assets", "architecture.png")

if not os.path.exists(SRC):
    print(f"source not found: {SRC}", file=sys.stderr); sys.exit(1)

img = Image.open(SRC).convert("RGBA")
W, H = img.size  # 3200 × 2000

# --- QR code linking to GitHub ---
qr = qrcode.QRCode(box_size=12, border=2, error_correction=qrcode.constants.ERROR_CORRECT_M)
qr.add_data("https://github.com/DM20911")
qr.make(fit=True)
qr_img = qr.make_image(fill_color="#f59e0b", back_color="#0b0f1a").convert("RGBA")
qr_size = 320
qr_img = qr_img.resize((qr_size, qr_size), Image.LANCZOS)

# --- Composite QR top-right ---
qr_x = W - qr_size - 60
qr_y = 60
img.paste(qr_img, (qr_x, qr_y), qr_img)

# --- Text overlay ---
draw = ImageDraw.Draw(img)

def try_font(paths, size):
    for p in paths:
        try: return ImageFont.truetype(p, size)
        except: continue
    return ImageFont.load_default()

mono   = try_font(["/System/Library/Fonts/Menlo.ttc",
                   "/System/Library/Fonts/Monaco.ttf",
                   "/Library/Fonts/Courier New.ttf"], 26)
mono_b = try_font(["/System/Library/Fonts/Menlo.ttc"], 32)
mono_s = try_font(["/System/Library/Fonts/Menlo.ttc"], 22)
sans   = try_font(["/System/Library/Fonts/HelveticaNeue.ttc",
                   "/System/Library/Fonts/Helvetica.ttc"], 28)

amber = "#f59e0b"
slate = "#94a3b8"
mute  = "#64748b"

# --- "DM20911" + QR caption (top-right under the QR) ---
caption_x = qr_x
caption_y = qr_y + qr_size + 18
draw.text((caption_x, caption_y), "DM20911", fill=amber, font=mono_b)
draw.text((caption_x, caption_y + 42), "scan → github.com/DM20911", fill=slate, font=mono_s)

# --- Bottom-right credits ---
credits = [
    ("OPTIMIZARIA  CONSULTING  SPA", amber, mono_b),
    ("optimizaria.com", slate, mono_s),
    ("", None, None),
    ("CO-AUTHOR", mute, mono_s),
    ("Sombrero Blanco Ciberseguridad", "#10b981", mono),
]
cy = H - 260
for text, color, font in credits:
    if text:
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        draw.text((W - tw - 60, cy), text, fill=color, font=font)
    cy += 38

# --- Subtle footer band ---
draw.rectangle([(0, H - 60), (W, H)], fill=(11, 15, 26, 200))
draw.text((60, H - 50),
          "Local-network clipboard synchronization · End-to-end encrypted (X25519 + AES-256-GCM) · No cloud",
          fill=slate, font=mono_s)

# Save
os.makedirs(os.path.dirname(OUT), exist_ok=True)
img.convert("RGB").save(OUT, "PNG", optimize=True)
print(f"OK → {OUT}  ({os.path.getsize(OUT) // 1024} KB)")
