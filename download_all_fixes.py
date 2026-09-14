import json
import os
import time
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed

META_PATH = r"C:\Users\PC\Desktop\securityshoop-shopier-link-fixed-main-main\storage\fixes_meta.json"
OUT_DIR = r"C:\Users\PC\Desktop\securityshoop-shopier-link-fixed-main-main\storage\fixes"
COOKIE = "hideAnnouncementModal=true; connect.sid=s%3An2Loz1zVh587PYNlIl9LS99dBxSa9lvb.6Q0xIKhVkSod2B8e8YCECG4xWdPxBRdPBv4Uhk2Uvoo"

os.makedirs(OUT_DIR, exist_ok=True)

with open(META_PATH, "r", encoding="utf-8") as f:
    meta = json.load(f)

tasks = []
for g in meta.get("games", []):
    for fix in g.get("fixes", []):
        fid = fix.get("id")
        fname = fix.get("downloadName") or fix.get("filename")
        if fid and fname:
            tasks.append((fid, fname))

print(f"Toplam indirilecek fix sayisi: {len(tasks)}")

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 OPR/135.0.0.0",
    "Referer": "https://depotbox.org/fixes",
    "Cookie": COOKIE
}

sess = requests.Session()
sess.headers.update(headers)

def download_one(task):
    fid, fname = task
    out_path = os.path.join(OUT_DIR, fname)
    if os.path.exists(out_path) and os.path.getsize(out_path) > 100:
        return fid, fname, "skipped", os.path.getsize(out_path)

    url = f"https://depotbox.org/api/fixes/download?id={fid}"
    for attempt in range(4):
        try:
            r = sess.get(url, timeout=30, stream=True)
            if r.status_code == 200:
                with open(out_path, "wb") as f:
                    for chunk in r.iter_content(chunk_size=65536):
                        if chunk:
                            f.write(chunk)
                sz = os.path.getsize(out_path)
                return fid, fname, "downloaded", sz
            elif r.status_code == 429 or r.status_code == 403:
                time.sleep(3 * (attempt + 1))
            else:
                time.sleep(1)
        except Exception as e:
            time.sleep(2 * (attempt + 1))
    return fid, fname, "failed", 0

completed = 0
downloaded_count = 0
skipped_count = 0
failed_count = 0
total = len(tasks)

print("Indirmeler basliyor (6 paralel is parcacigi)...")
with ThreadPoolExecutor(max_workers=6) as executor:
    futures = [executor.submit(download_one, t) for t in tasks]
    for fut in as_completed(futures):
        fid, fname, status, sz = fut.result()
        completed += 1
        if status == "downloaded":
            downloaded_count += 1
        elif status == "skipped":
            skipped_count += 1
        else:
            failed_count += 1

        if completed % 25 == 0 or completed == total:
            print(f"[{completed}/{total}] Inen: {downloaded_count} | Atlanan: {skipped_count} | Hatali: {failed_count}")

print("\n" + "="*50)
print(f"Indirme Tamamlandi!")
print(f"Toplam: {total} | Inen: {downloaded_count} | Mevcut: {skipped_count} | Hata: {failed_count}")
print("="*50)
