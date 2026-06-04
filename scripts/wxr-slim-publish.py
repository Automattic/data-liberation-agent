#!/usr/bin/env python3
"""Slim a WXR for Studio provisioning: drop attachment <item>s (avoids the
media-heavy import timeout) and flip page/post status draft->publish (so the
live preview resolves). Backs up the full WXR to <wxr>.full first.

  python3 scripts/wxr-slim-publish.py <output.wxr>
"""
import re, sys, shutil, os

path = sys.argv[1]
full = path + '.full'
if not os.path.exists(full):
    shutil.copy2(path, full)  # preserve the full WXR (with attachments) for output-alt.wxr
src = open(full, encoding='utf-8').read()

# Split into items; keep non-attachment items, flip draft->publish within them.
def keep(item: str) -> bool:
    return '<wp:post_type>attachment</wp:post_type>' not in item

parts = re.split(r'(<item>.*?</item>)', src, flags=re.S)
out, dropped, flipped = [], 0, 0
for p in parts:
    if p.startswith('<item>'):
        if not keep(p):
            dropped += 1
            continue
        new = p.replace('<wp:status>draft</wp:status>', '<wp:status>publish</wp:status>')
        if new != p:
            flipped += 1
        out.append(new)
    else:
        out.append(p)
open(path, 'w', encoding='utf-8').write(''.join(out))
print(f"slimmed: dropped {dropped} attachment items, flipped {flipped} draft->publish")
print(f"full WXR preserved at {full}")
