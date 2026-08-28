import sys
import os

# Sistemin System32 yerine doğrudan dosyanın bulunduğu klasörde çalışmasını zorunlu kılıyoruz
os.chdir(os.path.dirname(os.path.abspath(__file__)))

import threading
import io
import zipfile
import subprocess
import time
import json
import shutil
import webbrowser
import concurrent.futures
from datetime import datetime
import ctypes
import uuid
import sqlite3
import secrets
import traceback

APP_VERSION = "6.1.0"

try:
    import requests
    import urllib3
    from PIL import Image, ImageTk
    import customtkinter as ctk
    import psutil
    import platform
except ImportError as e:
    import subprocess
    import sys
    print("Gerekli moduller yukleniyor...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "psutil", "requests", "pillow", "customtkinter"])
    import requests
    import urllib3
    from PIL import Image, ImageTk
    import customtkinter as ctk
    import psutil
    import platform

try:
    try:
        import winsound
        WINSOUND_AVAILABLE = True
    except ImportError:
        WINSOUND_AVAILABLE = False
    # Güvenlik sertifikası (SSL) uyarılarını gizliyoruz
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
except ImportError as e:
    import tkinter as tk
    from tkinter import messagebox
    root = tk.Tk()
    root.withdraw()
    messagebox.showerror("Eksik Kütüphane", f"Gerekli kütüphaneler eksik!\nLütfen CMD'ye şunu yazın:\npip install customtkinter requests urllib3 Pillow pystray pypresence\n\nHata: {e}")
    sys.exit(1)

# Discord RPC
try:
    from pypresence import Presence
    PYPRESENCE_AVAILABLE = True
except ImportError:
    PYPRESENCE_AVAILABLE = False

IS_WINDOWS = sys.platform.startswith("win")
if IS_WINDOWS:
    try:
        import winreg
    except ImportError:
        winreg = None
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass
else:
    winreg = None

CONFIG_FILE = "config.json"
DEFAULT_CONFIG = {
    "api_key": "436b0828-9799-4ce4-b1f2-ea5a3ce32f73",
    "api_url": "https://depotbox.org/api/direct-lua",
    "hook_url": "https://github.com/OpenSteam001/OpenSteamTool/releases/download/1.4.8/OpenSteamTool-1.4.8-Debug.zip",
    "hook_version": "1.4.8",
    "lua_path": "",
    "auto_dlc": True,
    "launch_options": {},
    "discord_rpc": True,
    "session_token": "", 
    "role": "user",
    "cookies": {},
    "admin_token_hash": "",
    "admin_token_created_at": "",
    "favorites": [],
    "auto_backup": True,
    "backup_retention": 10,
    "download_history_db": "marifetstore.db",
    "support_whatsapp": "https://wa.me/6285801581064"
}

# Global Session
http_session = requests.Session()
# Windows 10 sertifika sorunlarını aşmak için tüm Session'da verify=False zorunlu kılıyoruz
http_session.verify = False 

def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                for k, v in DEFAULT_CONFIG.items():
                    data.setdefault(k, v)
                if data.get("cookies"):
                    requests.utils.add_dict_to_cookiejar(http_session.cookies, data["cookies"])
                return data
        except Exception:
            pass
    save_config(DEFAULT_CONFIG)
    return DEFAULT_CONFIG.copy()

def save_config(config_data):
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(config_data, f, indent=4, ensure_ascii=False)
    except Exception:
        pass

def db_path():
    return os.path.join(os.getcwd(), load_config().get("download_history_db", "marifetstore.db"))

def init_local_db():
    try:
        con = sqlite3.connect(db_path())
        cur = con.cursor()
        cur.execute("""
            CREATE TABLE IF NOT EXISTS download_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                appid TEXT NOT NULL,
                status TEXT NOT NULL,
                sha256 TEXT,
                target TEXT,
                created_at TEXT NOT NULL
            )
        """)
        con.commit()
        con.close()
    except Exception:
        pass

def record_download(appid, status, sha256_value="", target=""):
    try:
        con = sqlite3.connect(db_path())
        con.execute(
            "INSERT INTO download_history(appid,status,sha256,target,created_at) VALUES(?,?,?,?,?)",
            (str(appid), status, sha256_value, target, datetime.now().isoformat(timespec="seconds"))
        )
        con.commit()
        con.close()
    except Exception:
        pass

def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def make_admin_token():
    return "MS-ADMIN-" + secrets.token_urlsafe(24)

def hash_admin_token(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()

def validate_admin_token(config, token):
    saved = str(config.get("admin_token_hash", ""))
    return bool(saved) and secrets.compare_digest(saved, hash_admin_token(token))

def exception_log(context, exc):
    try:
        with open("errors.log", "a", encoding="utf-8") as f:
            f.write(
                f"[{datetime.now().isoformat(timespec='seconds')}] {context}\n"
                + traceback.format_exc()
                + "\n"
            )
    except Exception:
        pass

import hashlib
def get_hwid():
    try:
        if IS_WINDOWS:
            cpu = subprocess.check_output('wmic cpu get processorid').decode().split('\n')[1].strip()
            board = subprocess.check_output('wmic baseboard get serialnumber').decode().split('\n')[1].strip()
            uuid_str = subprocess.check_output('wmic csproduct get uuid').decode().split('\n')[1].strip()
            combined = f"{cpu}-{board}-{uuid_str}".replace(" ", "")
            return hashlib.sha256(combined.encode()).hexdigest()
        return str(uuid.getnode())
    except:
        return str(uuid.getnode())

# GÜVENLİK (ANTI-CRACK & ANTI-SNIFF)
def security_check():
    blacklisted_processes = ['wireshark', 'fiddler', 'charles', 'x64dbg', 'ollydbg', 'processhacker', 'cheatengine', 'dumpcap', 'httpdebugger', 'dnspy']
    while True:
        try:
            if IS_WINDOWS:
                output = subprocess.check_output('tasklist', creationflags=subprocess.CREATE_NO_WINDOW).decode().lower()
                for proc in blacklisted_processes:
                    if proc in output:
                        print(f"GUVENLIK IHLALI: {proc} tespit edildi!")
                        os._exit(1)
        except:
            pass
        time.sleep(3)


def get_steam_path():
    if IS_WINDOWS and winreg:
        try:
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam")
            path, _ = winreg.QueryValueEx(key, "SteamPath")
            winreg.CloseKey(key)
            return path.replace("/", "\\")
        except Exception:
            pass
    for p in [r"C:\Program Files (x86)\Steam", r"C:\Program Files\Steam"]:
        if os.path.exists(p): return p
    return r"C:\Program Files (x86)\Steam"

class CTkListbox(ctk.CTkScrollableFrame):
    def __init__(self, master, command=None, **kwargs):
        super().__init__(master, **kwargs)
        self.command = command
        self.buttons = []
        self.selected_text = None

    def insert(self, text):
        btn = ctk.CTkButton(
            self, text=text, fg_color="transparent", text_color=("gray10", "gray90"),
            hover_color=("gray70", "gray30"), anchor="w",
            command=lambda t=text: self._select_item(t)
        )
        btn.pack(fill="x", pady=1, padx=2)
        self.buttons.append(btn)

    def delete_all(self):
        for btn in self.buttons:
            btn.destroy()
        self.buttons.clear()
        self.selected_text = None

    def _select_item(self, text):
        self.selected_text = text
        for btn in self.buttons:
            if btn.cget("text") == text:
                btn.configure(fg_color=("gray75", "#1f538d")) 
            else:
                btn.configure(fg_color="transparent")
        if self.command:
            self.command(text)
            
    def get_selected(self):
        return self.selected_text

# ==========================================
# YÖNETİCİ (ADMIN) PANELİ PENCERESİ
# ==========================================
class AdminDashboardWindow(ctk.CTkToplevel):
    def __init__(self, master):
        super().__init__(master)
        self.title("MarifetStore - YÖNETİCİ PANELİ")
        self.geometry("900x600")
        self.grab_set() 
        
        header = ctk.CTkFrame(self, fg_color="transparent")
        header.pack(fill="x", padx=20, pady=20)
        
        ctk.CTkLabel(header, text="👑 Yönetici Kontrol Paneli", font=ctk.CTkFont(size=24, weight="bold"), text_color="#F59E0B").pack(side="left")
        ctk.CTkButton(header, text="Yenile", width=80, fg_color="#3B82F6", hover_color="#2563EB", command=self.load_users).pack(side="right")
        
        self.users_frame = ctk.CTkScrollableFrame(self)
        self.users_frame.pack(fill="both", expand=True, padx=20, pady=(0, 20))
        
        self.load_users()
        
    def load_users(self):
        for widget in self.users_frame.winfo_children():
            widget.destroy()
        ctk.CTkLabel(self.users_frame, text="Veriler Vercel sunucusundan çekiliyor...").pack(pady=20)
        threading.Thread(target=self._fetch_and_render_users, daemon=True).start()

    def _fetch_and_render_users(self):
        try:
            # SSL Hatası önlemek için verify=False eklendi
            res = http_session.get("https://securtiyshoop.vercel.app/api/admin/users", timeout=10, verify=False)
            data = res.json()
            
            for widget in self.users_frame.winfo_children():
                widget.destroy()
                
            if data.get("ok"):
                for u in data.get("users", []):
                    self.add_user_row(u)
            else:
                ctk.CTkLabel(self.users_frame, text="Yetkisiz erişim veya sunucu hatası!", text_color="red").pack(pady=20)
        except Exception as e:
            for widget in self.users_frame.winfo_children():
                widget.destroy()
            ctk.CTkLabel(self.users_frame, text=f"Bağlantı Hatası: {e}").pack(pady=20)

    def add_user_row(self, u):
        row = ctk.CTkFrame(self.users_frame, fg_color="#1E293B", corner_radius=8)
        row.pack(fill="x", pady=5, padx=5)
        
        uid = u.get('id')
        email = u.get('email', 'Bilinmiyor')
        role = u.get('role', 'user')
        blocked = u.get('is_blocked', False)
        
        info = f"[{uid}] {email}  |  Rol: {role.upper()}  |  Durum: {'🔴 Engelli' if blocked else '🟢 Aktif'}"
        
        ctk.CTkLabel(row, text=info, font=ctk.CTkFont(weight="bold")).pack(side="left", padx=15, pady=10)
        
        if str(role) != "admin":
            btn_ban = ctk.CTkButton(row, text="🚫 PC Ban", fg_color="#EF4444", hover_color="#DC2626", width=100, 
                                    command=lambda: self.action_user(uid, "ban-pc"))
            btn_ban.pack(side="right", padx=10, pady=10)
            
            btn_sil = ctk.CTkButton(row, text="🗑️ Sil", fg_color="#B91C1C", hover_color="#991B1B", width=100, 
                                    command=lambda: self.action_user(uid, "delete"))
            btn_sil.pack(side="right", padx=5, pady=10)
            
            if blocked:
                btn_unblock = ctk.CTkButton(row, text="✅ Engeli Kaldır", fg_color="#10B981", hover_color="#059669", width=100, 
                                            command=lambda: self.action_user(uid, "unblock"))
                btn_unblock.pack(side="right", padx=5, pady=10)

    def action_user(self, uid, action):
        def task():
            try:
                res = http_session.post(f"https://securtiyshoop.vercel.app/api/admin/users/{uid}/{action}", timeout=10, verify=False)
                if res.status_code == 200:
                    self.load_users()
            except:
                pass
        threading.Thread(target=task, daemon=True).start()

# ==========================================
# GİRİŞ (LOGIN) EKRANI SINIFI
# ==========================================
class LoginWindow(ctk.CTk):
    def __init__(self):
        super().__init__()
        ctk.set_appearance_mode("dark")
        ctk.set_default_color_theme("blue")
        
        self.title("MarifetStore - Güvenlik Kontrolü")
        self.geometry("400x400")
        self.resizable(False, False)
        
        self.config = load_config()
        self.api_url = "https://securtiyshoop.vercel.app/api/desktop/activate"
        self.legacy_api_url = "https://securtiyshoop.vercel.app/api/plugin/token-login"
        self.hwid = get_hwid()

        self._build_ui()
        
        if self.config.get("session_token"):
            self.auto_login()

    def _build_ui(self):
        frame = ctk.CTkFrame(self, corner_radius=15)
        frame.pack(pady=40, padx=40, fill="both", expand=True)

        ctk.CTkLabel(frame, text="MARIFET", font=ctk.CTkFont(size=24, weight="bold")).pack(pady=(30, 0))
        ctk.CTkLabel(frame, text="Tek Kullanımlık Anahtar ile Giriş Yapın", font=ctk.CTkFont(size=12), text_color="gray").pack(pady=(0, 20))

        self.token_entry = ctk.CTkEntry(frame, placeholder_text="Anahtar Kodu (Örn: MS-ABCD-1234)", width=280)
        self.token_entry.pack(pady=10)

        self.error_label = ctk.CTkLabel(frame, text="", text_color="#EF4444", font=ctk.CTkFont(size=11))
        self.error_label.pack(pady=5)

        self.login_btn = ctk.CTkButton(frame, text="GİRİŞ YAP", width=250, font=ctk.CTkFont(weight="bold"), fg_color="#10B981", text_color="#111827", hover_color="#059669", command=self.attempt_login)
        self.login_btn.pack(pady=20)
        
        ctk.CTkLabel(frame, text=f"HWID: {self.hwid[:8]}...", font=ctk.CTkFont(size=10), text_color="gray").pack(side="bottom", pady=15)

    def set_error(self, message):
        self.error_label.configure(text=message)
        self.login_btn.configure(state="normal")

    def auto_login(self):
        token_val = self.config.get("session_token")
        if not token_val:
            return
        self.login_btn.configure(state="disabled")
        self.set_error("Sistem girişiniz doğrulanıyor...")
        threading.Thread(target=self._process_login, args=(token_val,), daemon=True).start()

    def attempt_login(self):
        token_val = self.token_entry.get().strip()
        if not token_val:
            self.set_error("Lütfen anahtarı girin.")
            return

        self.login_btn.configure(state="disabled")
        self.set_error("Anahtar doğrulanıyor...")
        threading.Thread(target=self._process_login, args=(token_val,), daemon=True).start()

    def _process_login(self, token_val):
        try:
            is_desktop_key = token_val.upper().startswith("SSAPP-")
            if is_desktop_key:
                payload = {
                    "key": token_val,
                    "hwid": self.hwid,
                    "device_name": platform.node(),
                    "app_version": APP_VERSION
                }
                res = http_session.post(self.api_url, json=payload, headers={"Content-Type": "application/json"}, timeout=15, verify=False)
                data = res.json()
            else:
                payload = { "token": token_val, "hwid": self.hwid }
                res = http_session.post(self.legacy_api_url, json=payload, headers={"Content-Type": "application/json"}, timeout=15, verify=False)
                data = res.json()

            if res.status_code == 200 and data.get("ok"):
                self.config["session_token"] = data.get("token", token_val)
                key_info = data.get("key") or {}
                self.config["role"] = data.get("role") or key_info.get("role", "user")
                self.config["expires_at"] = data.get("expires_at") or key_info.get("expires_at")
                self.config["ref_code"] = data.get("ref_code", "")
                self.config["desktop_key"] = token_val if is_desktop_key else self.config.get("desktop_key", "")
                
                # Update Admin Panel config
                try:
                    conf_res = http_session.get("https://securtiyshoop.vercel.app/api/plugin/marifetstore", timeout=10, verify=False)
                    if conf_res.status_code == 200:
                        cdata = conf_res.json()
                        if cdata.get("ok") and cdata.get("config"):
                            self.config.update(cdata["config"])
                except Exception as e:
                    pass

                save_config(self.config)
                self.after(0, self.open_main_app)
                
            elif res.status_code == 403 and "suresi dolmus" in str(data.get("message", "")).lower():
                try:
                    target_path = self.config.get("path", "C:/Program Files (x86)/Steam/AppList")
                    if os.path.exists(target_path):
                        for file in os.listdir(target_path):
                            if file.endswith(".lua"):
                                try: os.remove(os.path.join(target_path, file))
                                except: pass
                except: pass
                self.config["session_token"] = ""
                save_config(self.config)
                self.after(0, lambda: self.set_error("Süreniz dolmuş! Oyunlar kütüphaneden silindi."))
            else:
                self.after(0, lambda: self.set_error(data.get("message", "Geçersiz anahtar.")))
        except requests.exceptions.RequestException as req_err:
            err_msg = f"Bağlantı hatası: {req_err}"
            self.after(0, lambda msg=err_msg: self.set_error(msg))
        except Exception as e:
            err_msg = f"Bilinmeyen hata: {e}"
            self.after(0, lambda msg=err_msg: self.set_error(msg))

    def open_main_app(self):
        self.destroy()
        app = MarifetStoreApp()
        app.mainloop()

# ==========================================
# ANA UYGULAMA (MAIN APP) SINIFI
# ==========================================
class MarifetStoreApp(ctk.CTk):
    def __init__(self):
        super().__init__()
        ctk.set_appearance_mode("dark")
        ctk.set_default_color_theme("blue")

        self.config = load_config()
        self.title("MarifetStore - Pro Panel v6.1")
        self.geometry("1300x850")
        self.resizable(False, False)

        self._search_timer = None
        self.all_library_items = []
        self.selected_appid = None
        self.rpc = None

        self.cache_dir = os.path.join(os.getcwd(), "cache")
        os.makedirs(self.cache_dir, exist_ok=True)

        self.grid_columnconfigure(1, weight=1)
        self.grid_rowconfigure(0, weight=1)

        self._init_discord_rpc()
        self._build_sidebar()
        self._build_main_panel()

        self.log(f"Güvenli Giriş Başarılı. Rolünüz: {str(self.config.get('role')).upper()}", "INFO")
        msg = self.config.get("message", "")
        if msg:
            self.log(f"Sunucu Mesajı: {msg}", "SUCCESS")
        
        threading.Thread(target=self._check_security, daemon=True).start()
        self._check_steam_status()
        self.after(1500, self._check_announcement)


    def _check_security(self):
        try:
            import uuid, sys
            mac = ':'.join(['{:02x}'.format((uuid.getnode() >> ele) & 0xff) for ele in range(0,8*6,8)][::-1])
            vm_macs = ["00:05:69", "00:0c:29", "00:1c:14", "00:50:56", "08:00:27", "00:15:5d"]
            for vmac in vm_macs:
                if mac.startswith(vmac):
                    self.after(0, lambda: self.set_error("Güvenlik İhlali: Sanal Makine (VM) Tespit Edildi!"))
                    self.after(3000, sys.exit)
                    return
            
            # Check for bad processes
            bad_procs = ["vboxservice.exe", "vboxtray.exe", "vmtoolsd.exe", "vmwaretray.exe", "wireshark.exe", "fiddler.exe", "x64dbg.exe"]
            for proc in psutil.process_iter(['name']):
                if proc.info['name'] and proc.info['name'].lower() in bad_procs:
                    self.after(0, lambda p=proc.info['name']: self.set_error("Güvenlik İhlali: Yasaklı yazılım tespit edildi (" + p + ")"))
                    self.after(3000, sys.exit)
                    return
        except: pass

    def _init_discord_rpc(self):
        if PYPRESENCE_AVAILABLE and self.config.get("discord_rpc", True):
            try:
                self.rpc = Presence("123456789012345678") 
                self.rpc.connect()
                self.rpc.update(details="Arayüzde Geziniyor", state="MarifetStore v4.0")
            except: pass

    def _build_sidebar(self):
        self.sidebar = ctk.CTkFrame(self, width=280, corner_radius=0)
        self.sidebar.grid(row=0, column=0, rowspan=2, sticky="nsew", padx=(0, 10))
        self.sidebar.grid_columnconfigure(0, weight=1)
        self.sidebar.grid_rowconfigure(30, weight=1)

        ctk.CTkLabel(
            self.sidebar, text="⚡ MARIFET",
            font=ctk.CTkFont(size=22, weight="bold")
        ).grid(row=0, column=0, padx=20, pady=(20, 2), sticky="w")
        ctk.CTkLabel(
            self.sidebar, text="STORE PRO",
            text_color="#3B82F6",
            font=ctk.CTkFont(size=14, weight="bold")
        ).grid(row=1, column=0, padx=20, pady=(0, 15), sticky="w")

        def add_btn(row, text, command, **kwargs):
            btn = ctk.CTkButton(
                self.sidebar, text=text, anchor="w",
                fg_color="transparent",
                hover_color=("gray70", "gray30"),
                command=command, **kwargs
            )
            btn.grid(row=row, column=0, padx=20, pady=2, sticky="ew")
            return btn

        row = 2
        add_btn(row, "🔄 Tüm Lua'ları Güncelle", self.update_all_luas); row += 1
        add_btn(row, "🛡️ Kanca Onar", self.download_and_inject_hooks); row += 1
        add_btn(row, "🛒 Mağaza", self.open_store_window); row += 1
        add_btn(row, "💲 Fiyatlar", self.open_prices_window); row += 1
        add_btn(row, "🎁 Referans Kodu", self.open_ref_window); row += 1
        add_btn(row, "🎟️ Promosyon Kodu", self.open_promo_window); row += 1
        add_btn(row, "💬 Destek (Ticket)", self.open_ticket_window); row += 1
        add_btn(row, "👤 Profilim / İstatistikler", self.open_profile_window); row += 1

        ctk.CTkButton(
            self.sidebar, text="🆘 Destek Merkezi",
            anchor="w", fg_color="#0EA5E9", hover_color="#0284C7",
            text_color="white", command=self.open_support_center
        ).grid(row=row, column=0, padx=20, pady=3, sticky="ew")
        row += 1

        ctk.CTkButton(
            self.sidebar, text="🤖 Yapay Zeka Asistanı",
            anchor="w", fg_color="#6366F1", hover_color="#4F46E5",
            text_color="white", command=self.open_ai_window
        ).grid(row=row, column=0, padx=20, pady=3, sticky="ew")
        row += 1

        add_btn(row, "📊 Sistem Monitörü", self.open_system_monitor); row += 1
        add_btn(row, "💾 Yedekleme Merkezi", self.open_backup_center); row += 1
        add_btn(row, "🔄 Güncelleme / Doğrulama", self.open_update_center); row += 1
        add_btn(row, "🧾 İndirme Geçmişi", self.open_download_history); row += 1

        # Theme selector.
        theme_frame = ctk.CTkFrame(self.sidebar, fg_color="transparent")
        theme_frame.grid(row=row, column=0, padx=20, pady=4, sticky="ew")
        ctk.CTkLabel(theme_frame, text="🎨 Tema:", font=ctk.CTkFont(size=11)).pack(side="left")
        self.theme_var = ctk.StringVar(value=self.config.get("theme", "dark"))
        ctk.CTkOptionMenu(
            theme_frame, values=["dark", "light", "system"],
            variable=self.theme_var, command=self._change_theme, width=100
        ).pack(side="left", padx=5)
        row += 1

        # Language selector.
        lang_frame = ctk.CTkFrame(self.sidebar, fg_color="transparent")
        lang_frame.grid(row=row, column=0, padx=20, pady=4, sticky="ew")
        ctk.CTkLabel(lang_frame, text="🌍 Dil:", font=ctk.CTkFont(size=11)).pack(side="left")
        self.lang_var = ctk.StringVar(value=self.config.get("lang", "tr"))
        ctk.CTkOptionMenu(
            lang_frame, values=["tr", "en"],
            variable=self.lang_var, command=self._change_lang, width=100
        ).pack(side="left", padx=5)
        row += 1

        # Admin panel.
        if self.config.get("role") == "admin":
            ctk.CTkButton(
                self.sidebar, text="👑 Admin Paneli",
                anchor="w", font=ctk.CTkFont(weight="bold"),
                fg_color="#F59E0B", text_color="#111827",
                hover_color="#D97706", command=self.open_admin_panel
            ).grid(row=row, column=0, padx=20, pady=(8, 4), sticky="ew")
            row += 1

        # Bottom Steam status.
        spacer = max(row + 1, 20)
        self.sidebar.grid_rowconfigure(spacer, weight=1)
        status_frame = ctk.CTkFrame(self.sidebar, fg_color="#1E293B", corner_radius=8)
        status_frame.grid(row=spacer + 1, column=0, padx=20, pady=(8, 20), sticky="ew")
        self.steam_lbl = ctk.CTkLabel(
            status_frame, text="Kontrol Ediliyor...",
            font=ctk.CTkFont(weight="bold")
        )
        self.steam_lbl.pack(pady=(10, 5))
        ctk.CTkButton(
            status_frame, text="Yeniden Başlat",
            fg_color="#334155", hover_color="#475569",
            command=self.manual_steam_restart
        ).pack(pady=(0, 5), padx=10, fill="x")
        ctk.CTkButton(
            status_frame, text="🚪 Çıkış Yap",
            fg_color="transparent", hover_color="#7F1D1D",
            text_color="#EF4444", command=self.logout
        ).pack(pady=(0, 10), padx=10, fill="x")


    def _change_theme(self, val):
        ctk.set_appearance_mode(val)
        self.config["theme"] = val
        save_config(self.config)

    def _change_lang(self, val):
        self.config["lang"] = val
        save_config(self.config)
        self.log("Dil değiştirildi. Tam efekt için uygulamayı yeniden başlatın.", "INFO")

    def _get_text(self, tr_text, en_text):
        if self.config.get("lang") == "en":
            return en_text
        return tr_text

    def open_store_window(self):
        win = ctk.CTkToplevel(self)
        win.title("🛒 Mağaza")
        win.geometry("820x520")
        win.grab_set()
        ctk.CTkLabel(win, text="🛒 Oyun Mağazası", font=ctk.CTkFont(size=20, weight="bold")).pack(pady=(20, 10))
        scroll = ctk.CTkScrollableFrame(win)
        scroll.pack(fill="both", expand=True, padx=20, pady=10)
        ctk.CTkLabel(scroll, text="Yükleniyor...", text_color="gray").pack(pady=20)

        def _load():
            try:
                res = requests.get("https://securtiyshoop.vercel.app/api/plugin/store-config", verify=False, timeout=8)
                data = res.json()
                items = data.get("store_items", [])
                self.after(0, lambda: _render(items))
            except Exception as e:
                self.after(0, lambda: ctk.CTkLabel(scroll, text=f"Yüklenemedi: {e}", text_color="red").pack())

        def _render(items):
            for w in scroll.winfo_children(): w.destroy()
            if not items:
                ctk.CTkLabel(scroll, text="Mağazada henüz ürün yok.", text_color="gray").pack(pady=20)
                return
            frame = ctk.CTkFrame(scroll, fg_color="transparent")
            frame.pack(fill="x")
            for item in items:
                card = ctk.CTkFrame(frame, corner_radius=12, border_width=1, border_color="#334155")
                card.pack(fill="x", padx=10, pady=6)
                inner = ctk.CTkFrame(card, fg_color="transparent")
                inner.pack(fill="x", padx=15, pady=12, side="left", expand=True)
                ctk.CTkLabel(inner, text=item.get("name", "Oyun"), font=ctk.CTkFont(size=15, weight="bold")).pack(anchor="w")
                ctk.CTkLabel(inner, text=f"AppID: {item.get('appid','?')}", text_color="gray", font=ctk.CTkFont(size=11)).pack(anchor="w")
                link = item.get("link", "")
                if link:
                    ctk.CTkButton(card, text="🛒 Satın Al", width=120, fg_color="#10B981", hover_color="#059669",
                                  command=lambda l=link: webbrowser.open(l)).pack(side="right", padx=15, pady=12)

        threading.Thread(target=_load, daemon=True).start()

    def open_prices_window(self):
        win = ctk.CTkToplevel(self)
        win.title("💲 Fiyat Listesi")
        win.geometry("620x480")
        win.grab_set()
        ctk.CTkLabel(win, text="💲 Abonelik Planları", font=ctk.CTkFont(size=20, weight="bold")).pack(pady=(20, 10))
        scroll = ctk.CTkScrollableFrame(win)
        scroll.pack(fill="both", expand=True, padx=20, pady=10)
        ctk.CTkLabel(scroll, text="Yükleniyor...", text_color="gray").pack(pady=20)

        def _load():
            try:
                res = requests.get("https://securtiyshoop.vercel.app/api/plugin/store-config", verify=False, timeout=8)
                data = res.json()
                plans = data.get("price_plans", [])
                self.after(0, lambda: _render(plans))
            except Exception as e:
                self.after(0, lambda: ctk.CTkLabel(scroll, text=f"Yüklenemedi: {e}", text_color="red").pack())

        def _render(plans):
            for w in scroll.winfo_children(): w.destroy()
            if not plans:
                ctk.CTkLabel(scroll, text="Fiyat planı henüz eklenmedi.", text_color="gray").pack(pady=20)
                return
            for plan in plans:
                card = ctk.CTkFrame(scroll, corner_radius=12, border_width=1, border_color="#10B981")
                card.pack(fill="x", padx=10, pady=6)
                ctk.CTkLabel(card, text=plan.get("name","Plan"), font=ctk.CTkFont(size=16, weight="bold")).pack(anchor="w", padx=15, pady=(12,2))
                ctk.CTkLabel(card, text=plan.get("price","?"), font=ctk.CTkFont(size=22, weight="bold"), text_color="#10B981").pack(anchor="w", padx=15)
                link = plan.get("link","")
                if link:
                    ctk.CTkButton(card, text="Satın Al →", fg_color="#10B981", hover_color="#059669",
                                  command=lambda l=link: webbrowser.open(l)).pack(anchor="e", padx=15, pady=10)

        threading.Thread(target=_load, daemon=True).start()

    def open_ref_window(self):
        ref_code = self.config.get("ref_code", "")
        win = ctk.CTkToplevel(self)
        win.title("🎁 Referans Sistemi")
        win.geometry("480x320")
        win.grab_set()
        ctk.CTkLabel(win, text="🎁 Referans Sistemi", font=ctk.CTkFont(size=18, weight="bold")).pack(pady=(20,5))
        if ref_code:
            ctk.CTkLabel(win, text=f"Senin Referans Kodun:", text_color="gray").pack()
            ctk.CTkLabel(win, text=ref_code, font=ctk.CTkFont(size=20, weight="bold"), text_color="#10B981").pack(pady=5)
            ctk.CTkLabel(win, text="Arkadaşına ver! O kullandığında ikinize de +3 gün eklenir.", wraplength=400, text_color="gray").pack(pady=5)
        ctk.CTkLabel(win, text="Referans Kodu Kullan:", font=ctk.CTkFont(weight="bold")).pack(pady=(15,3))
        entry = ctk.CTkEntry(win, placeholder_text="REF-XXXXXX", width=220)
        entry.pack()
        msg_lbl = ctk.CTkLabel(win, text="", text_color="#10B981")
        msg_lbl.pack(pady=5)

        def _use_ref():
            code = entry.get().strip()
            if not code: return
            token = self.config.get("session_token","")
            try:
                res = requests.post("https://securtiyshoop.vercel.app/api/plugin/use-ref",
                    json={"ref_code": code},
                    headers={"Authorization": f"Bearer {token}"},
                    verify=False, timeout=8)
                d = res.json()
                if d.get("ok"):
                    self.config["expires_at"] = d.get("expires_at", self.config.get("expires_at"))
                    save_config(self.config)
                    msg_lbl.configure(text="✅ " + d.get("message",""), text_color="#10B981")
                else:
                    msg_lbl.configure(text="❌ " + d.get("message",""), text_color="#EF4444")
            except Exception as e:
                msg_lbl.configure(text=f"Hata: {e}", text_color="#EF4444")

        ctk.CTkButton(win, text="Kodu Kullan ve +3 Gün Al", fg_color="#10B981", hover_color="#059669", command=_use_ref).pack(pady=10)


    def open_promo_window(self):
        win = ctk.CTkToplevel(self)
        win.title("🎟️ Promosyon Kodu")
        win.geometry("480x280")
        win.grab_set()
        ctk.CTkLabel(win, text="🎟️ Promosyon Kodu Kullan", font=ctk.CTkFont(size=18, weight="bold")).pack(pady=(20,5))
        ctk.CTkLabel(win, text="Admin tarafından dağıtılan etkinlik kodunu girin.", text_color="gray").pack(pady=5)
        entry = ctk.CTkEntry(win, placeholder_text="Örn: YAZ24", width=220)
        entry.pack(pady=10)
        msg_lbl = ctk.CTkLabel(win, text="", text_color="#10B981")
        msg_lbl.pack(pady=5)

        def _use():
            code = entry.get().strip()
            if not code: return
            token = self.config.get("session_token","")
            try:
                res = requests.post("https://securtiyshoop.vercel.app/api/plugin/use-promo",
                    json={"code": code}, headers={"Authorization": f"Bearer {token}"}, verify=False, timeout=8)
                d = res.json()
                if d.get("ok"):
                    self.config["expires_at"] = d.get("expires_at", self.config.get("expires_at"))
                    save_config(self.config)
                    msg_lbl.configure(text="✅ " + d.get("message",""), text_color="#10B981")
                else:
                    msg_lbl.configure(text="❌ " + d.get("message",""), text_color="#EF4444")
            except Exception as e:
                msg_lbl.configure(text=f"Hata: {e}", text_color="#EF4444")

        ctk.CTkButton(win, text="Kodu Kullan", fg_color="#D946EF", hover_color="#C026D3", command=_use).pack(pady=10)


    def get_local_hw(self):
        if hasattr(self, '_local_hw'): return self._local_hw
        import subprocess, psutil
        try:
            cpu_raw = subprocess.check_output('wmic cpu get name', shell=True).decode('utf-8', errors='ignore')
            cpu = cpu_raw.split('\n')[1].strip()
        except: cpu = 'Bilinmiyor'
        try:
            gpu_raw = subprocess.check_output('wmic path win32_VideoController get name', shell=True).decode('utf-8', errors='ignore')
            gpus = [g.strip() for g in gpu_raw.split('\n')[1:] if g.strip()]
            gpu = ' + '.join(gpus)
        except: gpu = 'Bilinmiyor'
        ram = f"{round(psutil.virtual_memory().total / (1024**3), 1)} GB"
        self._local_hw = {"cpu": cpu, "gpu": gpu, "ram": ram}
        return self._local_hw

    def open_hw_compare_window(self):
        if not hasattr(self, '_current_game_reqs'): return
        reqs = self._current_game_reqs
        local = self.get_local_hw()
        
        win = ctk.CTkToplevel(self)
        win.title("Sistem Gereksinimleri Karşılaştırması")
        win.geometry("700x350")
        win.grab_set()
        
        ctk.CTkLabel(win, text="🖥️ Bilgisayarım Kaldırır Mı?", font=ctk.CTkFont(size=18, weight="bold")).pack(pady=(15, 15))
        
        frame = ctk.CTkFrame(win, fg_color="transparent")
        frame.pack(fill="both", expand=True, padx=20)
        
        frame.columnconfigure(0, weight=1)
        frame.columnconfigure(1, weight=1)
        frame.columnconfigure(2, weight=1)
        
        # Headers
        ctk.CTkLabel(frame, text="Donanım", font=ctk.CTkFont(weight="bold", size=14), text_color="#3B82F6").grid(row=0, column=0, sticky="w", pady=10)
        ctk.CTkLabel(frame, text="Senin Sistemin", font=ctk.CTkFont(weight="bold", size=14), text_color="#10B981").grid(row=0, column=1, sticky="w", pady=10)
        ctk.CTkLabel(frame, text="Oyunun İstediği (Minimum)", font=ctk.CTkFont(weight="bold", size=14), text_color="#F59E0B").grid(row=0, column=2, sticky="w", pady=10)
        
        # RAM
        ctk.CTkLabel(frame, text="Bellek (RAM):", font=ctk.CTkFont(weight="bold")).grid(row=1, column=0, sticky="w", pady=10)
        ctk.CTkLabel(frame, text=local['ram']).grid(row=1, column=1, sticky="w", pady=10)
        ctk.CTkLabel(frame, text=reqs.get('ram', 'Bilinmiyor'), wraplength=200, justify="left").grid(row=1, column=2, sticky="w", pady=10)
        
        # CPU
        ctk.CTkLabel(frame, text="İşlemci (CPU):", font=ctk.CTkFont(weight="bold")).grid(row=2, column=0, sticky="w", pady=10)
        ctk.CTkLabel(frame, text=local['cpu'], wraplength=200, justify="left").grid(row=2, column=1, sticky="w", pady=10)
        ctk.CTkLabel(frame, text=reqs.get('cpu', 'Bilinmiyor'), wraplength=200, justify="left").grid(row=2, column=2, sticky="w", pady=10)
        
        # GPU
        ctk.CTkLabel(frame, text="Ekran Kartı (GPU):", font=ctk.CTkFont(weight="bold")).grid(row=3, column=0, sticky="w", pady=10)
        ctk.CTkLabel(frame, text=local['gpu'], wraplength=200, justify="left").grid(row=3, column=1, sticky="w", pady=10)
        ctk.CTkLabel(frame, text=reqs.get('gpu', 'Bilinmiyor'), wraplength=200, justify="left").grid(row=3, column=2, sticky="w", pady=10)

    def open_ticket_window(self):
        win = ctk.CTkToplevel(self)
        win.title("💬 Destek Talepleri")
        win.geometry("640x500")
        win.grab_set()
        ctk.CTkLabel(win, text="💬 Destek (Ticket) Sistemi", font=ctk.CTkFont(size=18, weight="bold")).pack(pady=(15,5))
        
        scroll = ctk.CTkScrollableFrame(win)
        scroll.pack(fill="both", expand=True, padx=20, pady=10)
        
        input_frame = ctk.CTkFrame(win, fg_color="transparent")
        input_frame.pack(fill="x", padx=20, pady=(0,15))
        entry = ctk.CTkEntry(input_frame, placeholder_text="Mesajınızı yazın...", width=450)
        entry.pack(side="left", padx=(0,10))
        
        def _load():
            try:
                res = requests.get("https://securtiyshoop.vercel.app/api/plugin/tickets", headers={"Authorization": f"Bearer {self.config.get('session_token','')}"}, verify=False, timeout=8).json()
                if res.get("ok"): self.after(0, lambda: _render(res.get("tickets", [])))
            except: pass
            
        def _render(tickets):
            for w in scroll.winfo_children(): w.destroy()
            if not tickets:
                ctk.CTkLabel(scroll, text="Henüz destek talebiniz yok.", text_color="gray").pack(pady=20)
                return
            for t in tickets:
                f = ctk.CTkFrame(scroll, corner_radius=8, border_width=1, border_color="#3B82F6" if t.get('status')=='open' else "#10B981")
                f.pack(fill="x", padx=5, pady=5)
                ctk.CTkLabel(f, text=t.get('message',''), justify="left", wraplength=500).pack(anchor="w", padx=10, pady=(10,5))
                if t.get('reply'):
                    ctk.CTkLabel(f, text="Admin: " + t.get('reply'), text_color="#10B981", justify="left", wraplength=500).pack(anchor="w", padx=10, pady=(0,10))
                else:
                    ctk.CTkLabel(f, text="⏳ Cevap bekleniyor...", text_color="#3B82F6", font=ctk.CTkFont(size=11)).pack(anchor="w", padx=10, pady=(0,10))

        def _send():
            msg = entry.get().strip()
            if not msg: return
            entry.delete(0, 'end')
            try:
                requests.post("https://securtiyshoop.vercel.app/api/plugin/tickets", json={"message": msg}, headers={"Authorization": f"Bearer {self.config.get('session_token','')}"}, verify=False, timeout=8)
                _load()
            except: pass

        ctk.CTkButton(input_frame, text="Gönder", width=80, fg_color="#3B82F6", command=_send).pack(side="left")
        threading.Thread(target=_load, daemon=True).start()


    def open_whatsapp(self):
        webbrowser.open(self.config.get("support_whatsapp", "https://wa.me/6285801581064"))

    def open_support_center(self):
        win = ctk.CTkToplevel(self)
        win.title("🆘 Destek Merkezi")
        win.geometry("760x560")
        win.grab_set()

        ctk.CTkLabel(win, text="🆘 MarifetStore Destek Merkezi",
                     font=ctk.CTkFont(size=22, weight="bold"),
                     text_color="#0EA5E9").pack(pady=(18, 3))
        ctk.CTkLabel(win, text="WhatsApp, Ticket ve AI desteği tek panelde.",
                     text_color="gray").pack(pady=(0, 12))

        tabs = ctk.CTkTabview(win)
        tabs.pack(fill="both", expand=True, padx=18, pady=10)
        tabs.add("WhatsApp")
        tabs.add("Ticket")
        tabs.add("Yapay Zeka")

        wp = tabs.tab("WhatsApp")
        ctk.CTkLabel(wp, text="WhatsApp Destek Hattı",
                     font=ctk.CTkFont(size=18, weight="bold")).pack(pady=(45, 8))
        ctk.CTkLabel(wp, text="Satın alma, lisans ve teknik destek için doğrudan iletişim kur.",
                     text_color="gray").pack(pady=5)
        ctk.CTkButton(wp, text="🟢 WhatsApp'ı Aç", width=220, height=42,
                      fg_color="#10B981", hover_color="#059669",
                      command=self.open_whatsapp).pack(pady=25)
        ctk.CTkLabel(wp, text=self.config.get("support_whatsapp", ""),
                     text_color="gray").pack()

        tp = tabs.tab("Ticket")
        ctk.CTkLabel(tp, text="Destek Talebi", font=ctk.CTkFont(size=18, weight="bold")).pack(pady=(12, 5))
        ticket_msg = ctk.CTkTextbox(tp, height=120)
        ticket_msg.pack(fill="x", padx=25, pady=10)
        status = ctk.CTkLabel(tp, text="", text_color="#10B981")
        status.pack()

        def send_ticket():
            msg = ticket_msg.get("1.0", "end").strip()
            if not msg:
                status.configure(text="Mesaj boş olamaz.", text_color="#EF4444")
                return
            status.configure(text="Gönderiliyor...", text_color="#F59E0B")
            def worker():
                try:
                    res = requests.post(
                        "https://securtiyshoop.vercel.app/api/plugin/tickets",
                        json={"message": msg},
                        headers={"Authorization": f"Bearer {self.config.get('session_token','')}"},
                        verify=False, timeout=10
                    )
                    d = res.json() if res.content else {}
                    ok = res.status_code == 200 and d.get("ok", True)
                    self.after(0, lambda: status.configure(
                        text="✅ Ticket gönderildi." if ok else "❌ Ticket gönderilemedi.",
                        text_color="#10B981" if ok else "#EF4444"
                    ))
                    if ok:
                        self.after(0, lambda: ticket_msg.delete("1.0", "end"))
                except Exception as e:
                    exception_log("support_ticket", e)
                    self.after(0, lambda: status.configure(text="❌ Bağlantı hatası.", text_color="#EF4444"))
            threading.Thread(target=worker, daemon=True).start()

        ctk.CTkButton(tp, text="Ticket Gönder", fg_color="#3B82F6",
                      command=send_ticket).pack(pady=10)

        ap = tabs.tab("Yapay Zeka")
        ctk.CTkLabel(ap, text="🤖 AI Destek Asistanı",
                     font=ctk.CTkFont(size=18, weight="bold")).pack(pady=8)
        question = ctk.CTkEntry(ap, placeholder_text="Sorunuzu yazın...")
        question.pack(fill="x", padx=25, pady=8)
        answer = ctk.CTkTextbox(ap, height=240, state="disabled")
        answer.pack(fill="both", expand=True, padx=25, pady=8)

        def ask_ai():
            q = question.get().strip()
            if not q:
                return
            answer.configure(state="normal")
            answer.insert("end", f"Sen: {q}\n")
            answer.insert("end", "AI: Yanıt bekleniyor...\n\n")
            answer.configure(state="disabled")
            def worker():
                try:
                    res = requests.post(
                        "https://securtiyshoop.vercel.app/api/plugin/ai-chat",
                        json={"prompt": q}, timeout=15
                    ).json()
                    reply = res.get("reply", "Sunucudan yanıt alınamadı.")
                except Exception as e:
                    exception_log("support_ai", e)
                    reply = f"Bağlantı hatası: {e}"
                def render():
                    answer.configure(state="normal")
                    content = answer.get("1.0", "end")
                    if "AI: Yanıt bekleniyor..." in content:
                        content = content.replace("AI: Yanıt bekleniyor...", "AI: " + reply, 1)
                        answer.delete("1.0", "end")
                        answer.insert("end", content)
                    else:
                        answer.insert("end", "AI: " + reply + "\n\n")
                    answer.configure(state="disabled")
                    answer.see("end")
                self.after(0, render)
            threading.Thread(target=worker, daemon=True).start()

        ctk.CTkButton(ap, text="Sor", fg_color="#6366F1", command=ask_ai).pack(pady=5)
        question.bind("<Return>", lambda e: ask_ai())

    def open_system_monitor(self):
        win = ctk.CTkToplevel(self)
        win.title("📊 Sistem Monitörü")
        win.geometry("620x430")
        win.grab_set()

        ctk.CTkLabel(win, text="📊 Canlı Sistem Monitörü",
                     font=ctk.CTkFont(size=20, weight="bold")).pack(pady=15)
        frame = ctk.CTkFrame(win)
        frame.pack(fill="both", expand=True, padx=20, pady=10)

        labels = {}
        for key, title in [
            ("cpu","CPU"), ("ram","RAM"), ("disk","Disk"), ("net","Ağ"),
            ("boot","Açılış"), ("proc","Process")
        ]:
            row = ctk.CTkFrame(frame, fg_color="transparent")
            row.pack(fill="x", padx=15, pady=8)
            ctk.CTkLabel(row, text=title, width=100, anchor="w",
                         font=ctk.CTkFont(weight="bold")).pack(side="left")
            labels[key] = ctk.CTkLabel(row, text="...")
            labels[key].pack(side="left")

        last_net = {"sent": 0, "recv": 0, "t": time.time()}

        def tick():
            try:
                labels["cpu"].configure(text=f"%{psutil.cpu_percent(interval=None):.1f}")
                vm = psutil.virtual_memory()
                labels["ram"].configure(text=f"%{vm.percent:.1f} ({vm.used/1024**3:.1f}/{vm.total/1024**3:.1f} GB)")
                d = psutil.disk_usage(os.getcwd())
                labels["disk"].configure(text=f"%{d.percent:.1f} ({d.free/1024**3:.1f} GB boş)")
                net = psutil.net_io_counters()
                now = time.time()
                dt = max(now - last_net["t"], 0.1)
                tx = max(0, net.bytes_sent - last_net["sent"]) / dt / 1024
                rx = max(0, net.bytes_recv - last_net["recv"]) / dt / 1024
                labels["net"].configure(text=f"↑ {tx:.0f} KB/s  ↓ {rx:.0f} KB/s")
                labels["boot"].configure(text=datetime.fromtimestamp(psutil.boot_time()).strftime("%d.%m.%Y %H:%M:%S"))
                labels["proc"].configure(text=str(len(psutil.pids())))
                last_net.update({"sent": net.bytes_sent, "recv": net.bytes_recv, "t": now})
            except Exception as e:
                exception_log("system_monitor", e)
            if win.winfo_exists():
                win.after(1000, tick)
        tick()

    def open_backup_center(self):
        win = ctk.CTkToplevel(self)
        win.title("💾 Yedekleme Merkezi")
        win.geometry("650x460")
        win.grab_set()
        ctk.CTkLabel(win, text="💾 Kütüphane Yedekleme",
                     font=ctk.CTkFont(size=20, weight="bold")).pack(pady=15)
        path = self.path_entry.get().strip()
        ctk.CTkLabel(win, text=f"Kaynak: {path}", wraplength=570, text_color="gray").pack(pady=5)
        status = ctk.CTkLabel(win, text="")
        status.pack(pady=10)

        def make_backup():
            try:
                if not os.path.isdir(path):
                    status.configure(text="Klasör bulunamadı.", text_color="#EF4444")
                    return
                stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                out = os.path.join(os.getcwd(), "backups")
                os.makedirs(out, exist_ok=True)
                zip_file = os.path.join(out, f"marifet_backup_{stamp}.zip")
                shutil.make_archive(zip_file[:-4], "zip", path)
                status.configure(text=f"✅ Oluşturuldu: {zip_file}", text_color="#10B981")
                self.log(f"Yedek oluşturuldu: {zip_file}", "SUCCESS")
            except Exception as e:
                exception_log("backup", e)
                status.configure(text=f"❌ {e}", text_color="#EF4444")

        ctk.CTkButton(win, text="ZIP Yedeği Oluştur", width=230, height=42,
                      fg_color="#10B981", command=make_backup).pack(pady=10)

        auto = ctk.BooleanVar(value=self.config.get("auto_backup", True))
        def toggle_auto():
            self.config["auto_backup"] = bool(auto.get())
            save_config(self.config)
        ctk.CTkCheckBox(win, text="Otomatik yedeklemeyi etkinleştir",
                        variable=auto, command=toggle_auto).pack(pady=5)

        ctk.CTkLabel(win, text="Yedekler ./backups klasörüne kaydedilir.",
                     text_color="gray").pack(pady=15)

    def open_download_history(self):
        win = ctk.CTkToplevel(self)
        win.title("🧾 İndirme Geçmişi")
        win.geometry("760x520")
        win.grab_set()
        ctk.CTkLabel(win, text="🧾 İndirme Geçmişi",
                     font=ctk.CTkFont(size=20, weight="bold")).pack(pady=15)
        box = ctk.CTkTextbox(win, font=ctk.CTkFont(family="Consolas", size=11))
        box.pack(fill="both", expand=True, padx=20, pady=10)
        try:
            con = sqlite3.connect(db_path())
            rows = con.execute(
                "SELECT appid,status,sha256,target,created_at FROM download_history ORDER BY id DESC LIMIT 500"
            ).fetchall()
            con.close()
            for appid, status, digest, target, created in rows:
                box.insert("end", f"{created} | {appid} | {status} | {digest[:16]}... | {target}\n")
        except Exception as e:
            box.insert("end", f"Hata: {e}")
            exception_log("download_history", e)
        box.configure(state="disabled")

    def open_update_center(self):
        win = ctk.CTkToplevel(self)
        win.title("🔄 Güncelleme / Doğrulama")
        win.geometry("720x500")
        win.grab_set()
        ctk.CTkLabel(win, text="🔄 Güncelleme ve Bütünlük Merkezi",
                     font=ctk.CTkFont(size=20, weight="bold")).pack(pady=15)
        box = ctk.CTkTextbox(win, font=ctk.CTkFont(family="Consolas", size=11))
        box.pack(fill="both", expand=True, padx=20, pady=10)

        path = self.path_entry.get().strip()

        def scan():
            box.configure(state="normal")
            box.delete("1.0", "end")
            if not os.path.isdir(path):
                box.insert("end", "Klasör bulunamadı.\n")
            else:
                files = [x for x in os.listdir(path) if x.lower().endswith(".lua")]
                box.insert("end", f"Dosya sayısı: {len(files)}\n\n")
                for name in files:
                    full = os.path.join(path, name)
                    try:
                        digest = file_sha256(full)
                        box.insert("end", f"[OK] {name}\n  SHA256: {digest}\n")
                    except Exception as e:
                        box.insert("end", f"[ERR] {name}: {e}\n")
            box.configure(state="disabled")

        ctk.CTkButton(win, text="Bütünlük Taraması", fg_color="#3B82F6",
                      command=scan).pack(pady=8)
        scan()
    def open_ai_window(self):
        win = ctk.CTkToplevel(self)
        win.title("🤖 AI Oyun Asistanı")
        win.geometry("500x600")
        win.grab_set()
        
        ctk.CTkLabel(win, text="🤖 MarifetStore AI Asistanı", font=ctk.CTkFont(size=18, weight="bold"), text_color="#6366F1").pack(pady=(15,5))
        ctk.CTkLabel(win, text="Ne tür bir oyun arıyorsun? Sor, tavsiye edeyim!", text_color="gray").pack(pady=5)
        
        chat_box = ctk.CTkTextbox(win, wrap="word", state="disabled")
        chat_box.pack(fill="both", expand=True, padx=20, pady=10)
        
        def append_text(sender, text, color=None):
            chat_box.configure(state="normal")
            chat_box.insert("end", f"{sender}: {text}\n\n")
            chat_box.configure(state="disabled")
            chat_box.see("end")

        append_text("🤖 AI", "Merhaba! Oyun kütüphanemizde ne tür maceralar arıyorsun? Sistem özelliklerinden veya sevdiğin oyunlardan bahset, sana en iyi oyunu bulayım!")
        
        input_frame = ctk.CTkFrame(win, fg_color="transparent")
        input_frame.pack(fill="x", padx=20, pady=(0,15))
        
        entry = ctk.CTkEntry(input_frame, placeholder_text="Bana araba yarışı oyunu bul...", width=380)
        entry.pack(side="left", padx=(0,10))
        
        def _send(e=None):
            msg = entry.get().strip()
            if not msg: return
            append_text("👤 Sen", msg)
            entry.delete(0, 'end')
            
            def _fetch():
                try:
                    res = requests.post("https://securtiyshoop.vercel.app/api/plugin/ai-chat", json={"prompt": msg}, timeout=15).json()
                    reply = res.get("reply", "Sunucudan yanıt alınamadı.")
                    self.after(0, lambda: append_text("🤖 AI", reply))
                except Exception as ex:
                    self.after(0, lambda: append_text("🤖 AI", f"Bağlantı hatası: {ex}"))
            
            threading.Thread(target=_fetch, daemon=True).start()

        entry.bind("<Return>", _send)
        ctk.CTkButton(input_frame, text="Gönder", width=60, fg_color="#6366F1", command=_send).pack(side="left")

    def open_profile_window(self):
        win = ctk.CTkToplevel(self)
        win.title("👤 Profilim")
        win.geometry("400x350")
        win.grab_set()
        ctk.CTkLabel(win, text="👤 Kullanıcı Profili", font=ctk.CTkFont(size=20, weight="bold")).pack(pady=(20,15))
        
        token = self.config.get('session_token','')
        f = ctk.CTkFrame(win)
        f.pack(fill="both", expand=True, padx=30, pady=(0,20))
        
        ctk.CTkLabel(f, text="Lisans Anahtarı:", text_color="gray", font=ctk.CTkFont(size=11)).pack(anchor="w", padx=20, pady=(15,0))
        ctk.CTkLabel(f, text=f"{token[:12]}...", font=ctk.CTkFont(weight="bold")).pack(anchor="w", padx=20, pady=(0,10))
        
        ctk.CTkLabel(f, text="Bitiş Tarihi:", text_color="gray", font=ctk.CTkFont(size=11)).pack(anchor="w", padx=20)
        ctk.CTkLabel(f, text=self.config.get('expires_at') or 'Sınırsız', font=ctk.CTkFont(weight="bold"), text_color="#10B981").pack(anchor="w", padx=20, pady=(0,10))
        
        # Count lua files
        lua_count = 0
        p = self.config.get("lua_path", "")
        import os
        if os.path.exists(p):
            lua_count = len([x for x in os.listdir(p) if x.endswith('.lua')])
            
        ctk.CTkLabel(f, text="Toplam İndirilen Oyun:", text_color="gray", font=ctk.CTkFont(size=11)).pack(anchor="w", padx=20)
        ctk.CTkLabel(f, text=str(lua_count) + " Oyun", font=ctk.CTkFont(weight="bold"), text_color="#F59E0B").pack(anchor="w", padx=20, pady=(0,10))

    def _check_announcement(self):
        def _fetch():
            try:
                res = requests.get("https://securtiyshoop.vercel.app/api/plugin/store-config", verify=False, timeout=6)
                d = res.json()
                ann = d.get("announcement")
                if ann and ann.get("active"):
                    self.after(500, lambda: self._show_announcement(ann))
                
                # Check app version
                server_version = d.get("app_version","1.0.0")
                download_url = d.get("app_download_url","")
                if server_version != APP_VERSION and download_url:
                    self.after(1000, lambda: self._show_update(server_version, download_url))
            except: pass
        threading.Thread(target=_fetch, daemon=True).start()

    def _show_announcement(self, ann):
        win = ctk.CTkToplevel(self)
        win.title("📢 Duyuru")
        win.geometry("440x220")
        win.grab_set()
        ctk.CTkLabel(win, text="📢 " + ann.get("title","Duyuru"), font=ctk.CTkFont(size=17, weight="bold")).pack(pady=(20,10))
        ctk.CTkLabel(win, text=ann.get("message",""), wraplength=380, text_color="gray").pack(padx=20)
        ctk.CTkButton(win, text="Tamam", fg_color="#10B981", command=win.destroy).pack(pady=20)

    def _show_update(self, version, url):
        win = ctk.CTkToplevel(self)
        win.title("🔄 Güncelleme Mevcut")
        win.geometry("440x220")
        win.grab_set()
        ctk.CTkLabel(win, text=f"🔄 Yeni Sürüm: v{version}", font=ctk.CTkFont(size=17, weight="bold")).pack(pady=(20,5))
        ctk.CTkLabel(win, text=f"Mevcut sürümünüz: v{APP_VERSION}\nYeni güncelleme mevcut!", wraplength=380, text_color="gray").pack()
        def _dl():
            webbrowser.open(url)
            win.destroy()
        ctk.CTkButton(win, text="İndir ve Güncelle", fg_color="#3B82F6", command=_dl).pack(pady=10)
        ctk.CTkButton(win, text="Daha Sonra", fg_color="transparent", hover_color=("gray70","gray30"), command=win.destroy).pack()

    def open_admin_panel(self):
        if self.config.get("role") != "admin":
            self.log("Admin paneline erişim reddedildi.", "ERROR")
            return
        saved_hash = self.config.get("admin_token_hash", "")
        if not saved_hash:
            win = ctk.CTkToplevel(self)
            win.title("Admin Key Kurulumu")
            win.geometry("480x220")
            win.grab_set()
            ctk.CTkLabel(win, text="🔐 Admin anahtarı henüz oluşturulmadı.",
                         font=ctk.CTkFont(size=17, weight="bold")).pack(pady=25)
            ctk.CTkLabel(win, text="Admin panelini açtıktan sonra Token Key bölümünden oluşturabilirsiniz.",
                         wraplength=400, text_color="gray").pack()
            ctk.CTkButton(win, text="Admin Panelini Aç",
                          command=lambda: (win.destroy(), AdminDashboardWindow(self))).pack(pady=25)
            return
        dialog = ctk.CTkToplevel(self)
        dialog.title("Admin Token")
        dialog.geometry("420x200")
        dialog.grab_set()
        ctk.CTkLabel(dialog, text="Admin Token Key",
                     font=ctk.CTkFont(size=17, weight="bold")).pack(pady=(25,10))
        entry = ctk.CTkEntry(dialog, width=300, show="•")
        entry.pack(pady=8)
        msg = ctk.CTkLabel(dialog, text="", text_color="#EF4444")
        msg.pack(pady=3)
        def verify():
            if validate_admin_token(self.config, entry.get().strip()):
                dialog.destroy()
                AdminDashboardWindow(self)
            else:
                msg.configure(text="Geçersiz admin anahtarı.")
                entry.delete(0, "end")
        ctk.CTkButton(dialog, text="Doğrula", fg_color="#F59E0B",
                      text_color="#111827", command=verify).pack(pady=8)

    def _build_main_panel(self):
        self.main_frame = ctk.CTkFrame(self, fg_color="transparent")
        self.main_frame.grid(row=0, column=1, sticky="nsew", padx=20, pady=20)
        self.main_frame.grid_rowconfigure(2, weight=1)
        self.main_frame.grid_columnconfigure(0, weight=1)
        self.main_frame.grid_columnconfigure(1, weight=2)

        self.top_card = ctk.CTkFrame(self.main_frame)
        self.top_card.grid(row=0, column=0, columnspan=2, sticky="ew", pady=(0, 20))
        
        self.form_grid = ctk.CTkFrame(self.top_card, fg_color="transparent")
        self.form_grid.pack(fill="x", padx=20, pady=20)
        self.form_grid.columnconfigure((0,1,2), weight=1)

        ctk.CTkLabel(self.form_grid, text="Oyun Ara", font=ctk.CTkFont(weight="bold")).grid(row=0, column=0, sticky="w", padx=5)
        self.search_entry = ctk.CTkEntry(self.form_grid, placeholder_text="Oyun adı yazın...")
        self.search_entry.grid(row=1, column=0, sticky="ew", padx=5)
        self.search_entry.bind("<KeyRelease>", self.on_search_type)

        ctk.CTkLabel(self.form_grid, text="AppID", font=ctk.CTkFont(weight="bold"), text_color="#F59E0B").grid(row=0, column=1, sticky="w", padx=5)
        self.appid_entry = ctk.CTkEntry(self.form_grid, placeholder_text="730, 271590")
        self.appid_entry.grid(row=1, column=1, sticky="ew", padx=5)

        ctk.CTkLabel(self.form_grid, text="Hedef Klasör", font=ctk.CTkFont(weight="bold")).grid(row=0, column=2, sticky="w", padx=5)
        self.path_entry = ctk.CTkEntry(self.form_grid)
        self.path_entry.grid(row=1, column=2, sticky="ew", padx=5)
        self.path_entry.insert(0, self.config.get("lua_path") or os.path.join(get_steam_path(), "config", "lua"))

        self.search_listbox = CTkListbox(self.form_grid, height=100, command=self.on_search_select)
        
        action_frame = ctk.CTkFrame(self.top_card, fg_color="transparent")
        action_frame.pack(fill="x", padx=20, pady=(0, 20))
        self.dlc_var = ctk.BooleanVar(value=True)
        ctk.CTkCheckBox(action_frame, text="Oto DLC", variable=self.dlc_var).pack(side="left", padx=5)
        self.action_btn = ctk.CTkButton(action_frame, text="⚡ ZİNCİRLERİ KIR VE BAŞLAT", font=ctk.CTkFont(weight="bold"), fg_color="#F59E0B", text_color="#111827", hover_color="#D97706", command=self.start_thread)
        self.action_btn.pack(side="right", padx=5, fill="x", expand=True)

        self.progress = ctk.CTkProgressBar(self.top_card, progress_color="#10B981")
        self.progress.pack(fill="x", padx=20, pady=(0, 20))
        self.progress.set(0)

        # Alt Kütüphane
        self.lib_frame = ctk.CTkFrame(self.main_frame)
        self.lib_frame.grid(row=2, column=0, sticky="nsew", padx=(0, 10))
        lib_head = ctk.CTkFrame(self.lib_frame, fg_color="transparent")
        lib_head.pack(fill="x", padx=10, pady=10)
        ctk.CTkLabel(lib_head, text="📦 KÜTÜPHANE", font=ctk.CTkFont(weight="bold")).pack(side="left")
        ctk.CTkButton(lib_head, text="Sil", width=40, fg_color="#EF4444", hover_color="#DC2626", command=self.delete_selected).pack(side="right")

        self.game_grid = ctk.CTkScrollableFrame(self.lib_frame)
        self.game_grid.pack(fill="both", expand=True, padx=10, pady=(0, 10))
        self.game_grid.columnconfigure((0,1,2), weight=1)

        # Sağ Detay Paneli ve Resim Ekranı
        self.right_panel = ctk.CTkFrame(self.main_frame, fg_color="transparent")
        self.right_panel.grid(row=2, column=1, sticky="nsew")
        self.right_panel.grid_rowconfigure(1, weight=1)

        self.cover_frame = ctk.CTkFrame(self.right_panel)
        self.cover_frame.grid(row=0, column=0, sticky="ew", pady=(0, 10))

        self.cover_image_label = ctk.CTkLabel(self.cover_frame, text="🖼️ Görsel Yok", width=160, height=75, fg_color="#1E293B", corner_radius=8)
        self.cover_image_label.pack(side="left", padx=20, pady=20)

        self.meta_frame = ctk.CTkFrame(self.cover_frame, fg_color="transparent")
        self.meta_frame.pack(side="left", fill="both", expand=True, pady=20)

        self.meta_title = ctk.CTkLabel(self.meta_frame, text="Oyun Seçilmedi", font=ctk.CTkFont(size=18, weight="bold"))
        self.meta_title.pack(anchor="w", pady=(0, 5))
        self.meta_desc = ctk.CTkLabel(self.meta_frame, text="Bir oyun seçin.", text_color="gray", wraplength=400, justify="left")
        self.meta_desc.pack(anchor="w", pady=(0, 2))
        
        self.hw_btn = ctk.CTkButton(self.meta_frame, text="🖥️ Bilgisayarım Kaldırır Mı?", fg_color="#3B82F6", hover_color="#2563EB", height=28, command=self.open_hw_compare_window)
        self.hw_btn.pack(anchor="w", pady=(5, 5))
        self.hw_btn.pack_forget() # Hide by default until game loads
        
        self.meta_expiry = ctk.CTkLabel(self.meta_frame, text="", text_color="#10B981", font=ctk.CTkFont(weight="bold", size=12))
        self.meta_expiry.pack(anchor="w", pady=(0, 10))
        
        self.current_expiry_date = None
        self._update_expiry_timer()

        btn_box = ctk.CTkFrame(self.meta_frame, fg_color="transparent")
        btn_box.pack(anchor="w")
        ctk.CTkButton(btn_box, text="▶️ OYNA", fg_color="#10B981", hover_color="#059669", width=100, command=self.launch_game).pack(side="left")

        self.console = ctk.CTkTextbox(self.right_panel, font=ctk.CTkFont(family="Consolas", size=12), text_color="#34D399", fg_color="#0B0F19")
        self.console.grid(row=1, column=0, sticky="nsew")
        self.console.configure(state="disabled")

        self.load_library()

    def logout(self):
        self.config["session_token"] = ""
        self.config["role"] = "user"
        self.config["cookies"] = {}
        save_config(self.config)
        self.destroy()
        app = LoginWindow()
        app.mainloop()

    def log(self, message, level="INFO"):
        time_str = datetime.now().strftime('%H:%M:%S')
        self.console.configure(state="normal")
        self.console.insert("end", f"[{time_str}] [{level}] {message}\n")
        self.console.see("end")
        self.console.configure(state="disabled")

    def _check_steam_status(self):
        if os.path.exists(get_steam_path()): self.steam_lbl.configure(text="🟢 Steam Açık", text_color="#10B981")
        else: self.steam_lbl.configure(text="🔴 Steam Yok", text_color="#EF4444")

    def manual_steam_restart(self):
        try: subprocess.run(["taskkill", "/F", "/IM", "steam.exe"], capture_output=True)
        except: pass
        if os.path.exists(os.path.join(get_steam_path(), "steam.exe")):
            os.startfile(os.path.join(get_steam_path(), "steam.exe"))

    def download_and_inject_hooks(self):
        def task():
            try:
                res = requests.get(self.config["hook_url"], verify=False, stream=True)
                with zipfile.ZipFile(io.BytesIO(res.content)) as zf:
                    for name in zf.namelist():
                        if any(h in name for h in ["dwmapi.dll", "xinput1_4.dll", "OpenSteamTool.dll"]):
                            source, target = zf.open(name), os.path.join(get_steam_path(), os.path.basename(name))
                            with open(target, "wb") as t_file: t_file.write(source.read())
                self.log("Kancalar başarıyla onarıldı.", "SUCCESS")
            except Exception as e: self.log(f"Hata: {e}", "ERROR")
        threading.Thread(target=task).start()

    def load_library(self):
        for w in self.game_grid.winfo_children(): w.destroy()
        lua_path = self.path_entry.get().strip()
        if not os.path.exists(lua_path): return
        
        appids = [f.replace('.lua', '') for f in os.listdir(lua_path) if f.endswith(".lua")]
        if not appids:
            ctk.CTkLabel(self.game_grid, text="Henüz oyun indirmediniz.", text_color="gray").grid(row=0, column=0, pady=20)
            return
            
        # Akilli Tahmin (Smart Recommendations)
        rec_label = getattr(self, "rec_label", None)
        if not rec_label:
            self.rec_label = ctk.CTkLabel(self.lib_frame, text="", text_color="#10B981", font=ctk.CTkFont(weight="bold"))
            self.rec_label.pack(pady=5)
            
        # Basit yerel heuristik algoritma
        has_gta = "271590" in appids
        has_cs = "730" in appids
        has_ets = "227300" in appids
        
        recs = []
        if has_gta: recs.append("Red Dead Redemption 2")
        if has_cs: recs.append("Rainbow Six Siege / Valorant")
        if has_ets: recs.append("Forza Horizon 5 / SnowRunner")
        
        if recs:
            self.rec_label.configure(text=f"✨ Zevkine Göre Tavsiyeler: {', '.join(recs)}")
        else:
            self.rec_label.configure(text="")

            
        col_count = 3
        for i, appid in enumerate(appids):
            r = i // col_count
            c = i % col_count
            card = ctk.CTkFrame(self.game_grid, corner_radius=8, cursor="hand2")
            card.grid(row=r, column=c, padx=5, pady=5, sticky="nsew")
            
            img = None
            cache_p = os.path.join(self.cache_dir, f"{appid}.jpg")
            if os.path.exists(cache_p):
                try: img = ctk.CTkImage(Image.open(cache_p), size=(110, 52))
                except: pass
            
            lbl = None
            if img:
                lbl = ctk.CTkLabel(card, image=img, text="", cursor="hand2")
                lbl.pack(padx=5, pady=5)
            
            txt = ctk.CTkLabel(card, text=str(appid), font=ctk.CTkFont(size=11, weight="bold"), cursor="hand2")
            txt.pack(pady=(0,5))
            
            for w in [card, lbl, txt]:
                if w: w.bind("<Button-1>", lambda e, a=appid: self.on_game_select(a))

    def toggle_favorite(self, appid):
        favs = set(self.config.get("favorites", []))
        appid = str(appid)
        if appid in favs:
            favs.remove(appid)
            self.log(f"Favoriden çıkarıldı: {appid}", "INFO")
        else:
            favs.add(appid)
            self.log(f"Favorilere eklendi: {appid}", "SUCCESS")
        self.config["favorites"] = sorted(favs)
        save_config(self.config)
        self.load_library()

    def on_game_select(self, appid):
        self.selected_appid = appid
        self.meta_title.configure(text=f"Seçili: {appid}")
        threading.Thread(target=self._fetch_game_info, args=(appid,), daemon=True).start()
        
    
    def _update_expiry_timer(self):
        exp_str = self.config.get("expires_at")
        if exp_str:
            try:
                from datetime import datetime, timezone
                exp_dt = datetime.fromisoformat(exp_str.replace("Z", "+00:00"))
                now = datetime.now(timezone.utc)
                diff = exp_dt - now
                
                if diff.total_seconds() > 0:
                    days = diff.days
                    hours, rem = divmod(diff.seconds, 3600)
                    minutes, seconds = divmod(rem, 60)
                    
                    time_str = "Kalan Süre: "
                    if days > 0: time_str += f"{days} Gün "
                    time_str += f"{hours:02d} Saat {minutes:02d} Dakika {seconds:02d} Saniye"
                    if hasattr(self, 'meta_expiry'):
                        self.meta_expiry.configure(text=time_str, text_color="#10B981")
                else:
                    if hasattr(self, 'meta_expiry'):
                        self.meta_expiry.configure(text="Süre Bitti!", text_color="#EF4444")
            except Exception as e:
                if hasattr(self, 'meta_expiry'):
                    self.meta_expiry.configure(text="")
        else:
            if hasattr(self, 'meta_expiry'):
                self.meta_expiry.configure(text="Sınırsız Lisans (Süre Yok)", text_color="#10B981")
            
        self.after(1000, self._update_expiry_timer)
    def _fetch_game_info(self, appid):
        try:
            res = requests.get(f"https://store.steampowered.com/api/appdetails?appids={appid}&l=turkish", timeout=4, verify=False).json()
            data = res.get(str(appid), {}).get("data", {})
            title = data.get("name", f"AppID - {appid}")
            desc = data.get("short_description", "Açıklama bulunmuyor.")
            self.after(0, lambda: self.meta_title.configure(text=title))
            self.after(0, lambda: self.meta_desc.configure(text=desc))
            
            # Can I Run It (PC Check)
            reqs = data.get("pc_requirements", {})
            min_req = reqs.get("minimum", "")
            
            import re
            text = re.sub(r'<[^>]+>', ' ', min_req)
            c, r, g = "Bilinmiyor", "Bilinmiyor", "Bilinmiyor"
            
            m = re.search(r'(?:Bellek|Memory):\s*(.*?)(?:Ekran|Graphics|Depolama|Storage)', text, re.IGNORECASE | re.DOTALL)
            if m: r = m.group(1).strip()
            
            m = re.search(r'(?:[İi]şlemci|Processor|lemci):\s*(.*?)(?:Bellek|Memory)', text, re.IGNORECASE | re.DOTALL)
            if m: c = m.group(1).strip()
            
            m = re.search(r'(?:Ekran Kart(?:ı|)|Graphics):\s*(.*?)(?:Depolama|Storage|DirectX|Ağ|Network|Ses)', text, re.IGNORECASE | re.DOTALL)
            if m: g = m.group(1).strip()
            
            self._current_game_reqs = {"cpu": c, "ram": r, "gpu": g}
            self.after(0, lambda: self.hw_btn.pack(anchor="w", pady=(5, 5)))
        except: pass

        cache_path = os.path.join(self.cache_dir, f"{appid}.jpg")
        try:
            if not os.path.exists(cache_path):
                img_url = f"https://cdn.akamai.steamstatic.com/steam/apps/{appid}/header.jpg"
                img_res = requests.get(img_url, timeout=4, verify=False)
                if img_res.status_code == 200:
                    with open(cache_path, "wb") as f:
                        f.write(img_res.content)
            
            if os.path.exists(cache_path):
                img = Image.open(cache_path)
                ctk_img = ctk.CTkImage(light_image=img, dark_image=img, size=(160, 75))
                self.after(0, lambda: self.cover_image_label.configure(image=ctk_img, text=""))
            else:
                self.after(0, lambda: self.cover_image_label.configure(image=None, text="🖼️ Görsel Yok"))
        except:
            self.after(0, lambda: self.cover_image_label.configure(image=None, text="🖼️ Görsel Yok"))

    def delete_selected(self):
        sel = self.selected_appid
        if not sel: return
        try: os.remove(os.path.join(self.path_entry.get(), f"{sel}.lua"))
        except: pass
        self.load_library()

    def launch_game(self):
        if self.selected_appid: webbrowser.open(f"steam://rungameid/{self.selected_appid}")

    def on_search_type(self, event):
        query = self.search_entry.get().strip()
        if len(query) < 3:
            self.search_listbox.grid_forget()
            return
        
        self.search_listbox.delete_all()
        self.search_listbox.insert("⏳ Aranıyor...")
        self.search_listbox.grid(row=2, column=0, sticky="ew", padx=5, pady=5)
        
        if self._search_timer: self.after_cancel(self._search_timer)
        self._search_timer = self.after(150, lambda: threading.Thread(target=self._search, args=(query,), daemon=True).start())

    def _search(self, q):
        try:
            res = requests.get(f"https://store.steampowered.com/api/storesearch/?term={q}&l=turkish&cc=TR", verify=False, timeout=5)
            data = res.json()
            items = data.get("items", [])
            self.after(0, lambda: self._update_search(items, q))
        except Exception as e:
            self.after(0, lambda: self._update_search([], q, error=True))

    def _update_search(self, items, q, error=False):
        if self.search_entry.get().strip() != q:
            return
            
        self.search_listbox.delete_all()
        if error:
            self.search_listbox.insert("❌ Arama başarısız (Bağlantı hatası)")
            return
            
        if not items:
            self.search_listbox.insert("Oyun bulunamadı.")
            return
            
        for i in items[:8]: 
            self.search_listbox.insert(f"{i.get('name')} ({i.get('id')})")
        self.search_listbox.grid(row=2, column=0, sticky="ew", padx=5, pady=5)

    def on_search_select(self, text):
        if "Aranıyor..." in text or "bulunamadı" in text or "başarısız" in text:
            return
        appid = text.split("(")[-1].replace(")", "").strip()
        cur = self.appid_entry.get()
        self.appid_entry.delete(0, 'end')
        self.appid_entry.insert(0, f"{cur}, {appid}" if cur else appid)
        self.search_listbox.grid_forget()
        self.search_entry.delete(0, 'end')
        self.on_game_select(appid)

    def download_single(self, app_id, target):
        out_file = os.path.join(target, f"{app_id}.lua")
        try:
            res = requests.get(
                self.config["api_url"],
                headers={"X-API-Key": self.config["api_key"]},
                params={"appid": app_id},
                verify=False, timeout=30
            )
            if res.status_code == 200 and res.content:
                tmp = out_file + ".tmp"
                with open(tmp, "wb") as f:
                    f.write(res.content)
                digest = file_sha256(tmp)
                os.replace(tmp, out_file)
                record_download(app_id, "success", digest, target)
                return True
            record_download(app_id, f"http_{res.status_code}", "", target)
            return False
        except Exception as e:
            exception_log(f"download_single:{app_id}", e)
            record_download(app_id, "error", "", target)
            try:
                if os.path.exists(out_file + ".tmp"):
                    os.remove(out_file + ".tmp")
            except Exception:
                pass
            return False


    def start_thread(self):
        # API'den kütüphaneyi kontrol et
        appids = [x.strip() for x in self.appid_entry.get().split(",") if x.strip()]
        if not appids:
            self.log("Lütfen bir oyun (AppID) seçin.", "ERROR")
            return
            
        main_appid = appids[0] # Sadece ilk oyunu baz alalım kontrol için (veya hepsini)
        
        self.log("Kütüphane kontrol ediliyor...", "INFO")
        try:
            if WINSOUND_AVAILABLE:
                import winsound
                winsound.MessageBeep(winsound.MB_ICONASTERISK)
        except: pass
        threading.Thread(target=self._verify_and_start, args=(main_appid,), daemon=True).start()

    def _verify_and_start(self, appid):
        # Sadece token suresini kontrol et, her oyun acilir
        try:
            exp_str = self.config.get("expires_at")
            if exp_str:
                from datetime import datetime, timezone
                exp_dt = datetime.fromisoformat(exp_str.replace("Z", "+00:00"))
                now = datetime.now(timezone.utc)
                if exp_dt < now:
                    self.log("Süreniz dolmuş! Oyunlar Steam kütüphanesinden siliniyor...", "ERROR")
                    try:
                        target = self.path_entry.get().strip()
                        if os.path.exists(target):
                            for file in os.listdir(target):
                                if file.endswith(".lua"):
                                    try: os.remove(os.path.join(target, file))
                                    except: pass
                    except: pass
                    self.load_library()
                    return
        except: pass
        
        self.log(f"Lisans doğrulandı (AppID: {appid}). Başlıyor...", "SUCCESS")
        self.main_process()

    def prompt_for_credit(self, appid):
        pass

    def main_process(self):
        target = self.path_entry.get().strip()
        appids = [x.strip() for x in self.appid_entry.get().split(",") if x.strip()]
        if not appids: return
        os.makedirs(target, exist_ok=True)
        
        apps = list(appids)
        if self.dlc_var.get():
            self.log("DLC aranıyor...", "INFO")
            for a in appids:
                try: apps.extend([str(d) for d in requests.get(f"https://store.steampowered.com/api/appdetails?appids={a}", verify=False).json().get(str(a), {}).get("data", {}).get("dlc", [])])
                except: pass
        apps = list(dict.fromkeys(apps))
        
        c = 0
        self.progress.set(0)
        self.log(f"Çoklu indirme başladı. Dosya: {len(apps)}", "INFO")
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
            futs = {ex.submit(self.download_single, app, target): app for app in apps}
            for fut in concurrent.futures.as_completed(futs):
                app_id = futs[fut]
                c += 1
                self.progress.set(c / len(apps))
                if fut.result(): self.log(f"İndi: {app_id}.lua", "SUCCESS")
                else: self.log(f"Hata: {app_id}", "ERROR")
        
        self.load_library()
        if self.config.get("auto_backup", True):
            try:
                source = self.path_entry.get().strip()
                if os.path.isdir(source) and any(x.endswith(".lua") for x in os.listdir(source)):
                    backup_dir = os.path.join(os.getcwd(), "backups")
                    os.makedirs(backup_dir, exist_ok=True)
                    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                    shutil.make_archive(
                        os.path.join(backup_dir, f"auto_{stamp}"),
                        "zip",
                        source
                    )
                    self.log("Otomatik yedek oluşturuldu.", "SUCCESS")
            except Exception as e:
                exception_log("auto_backup", e)
        self.log("Tamamlandı!", "SUCCESS")

    def update_all_luas(self):
        items = [f.replace(".lua", "") for f in os.listdir(self.path_entry.get()) if f.endswith(".lua")]
        if items:
            self.appid_entry.delete(0, 'end')
            self.appid_entry.insert(0, ",".join(items))
            self.start_thread()

if __name__ == "__main__":
    try:
        init_local_db()
        threading.Thread(target=security_check, daemon=True).start()
        app = LoginWindow()
        app.mainloop()
    except Exception as e:
        import traceback
        print("\n" + "="*50)
        print("KRITIK HATA OLUSTU:")
        traceback.print_exc()
        print("="*50 + "\n")
        input("Lutfen hatayi kopyalayin ve kapatmak icin ENTER'a basin...")