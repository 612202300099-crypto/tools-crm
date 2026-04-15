"use client";

import { useState, useEffect, useRef } from "react";
import { Bot, Power, Upload, Save, Image, AlertTriangle, CheckCircle, Loader2, RefreshCw } from "lucide-react";

const API_URL = "https://api-wa.parecustom.com";

const DEFAULT_PROMPT = `Kamu adalah CS yang ramah dari toko online kami. Tugasmu HANYA satu: meminta nomor pesanan ke customer dengan sopan dan sabar.

Aturan penting:
- Nomor pesanan terdiri dari 18 digit angka (contoh: 123456789012345678)
- Jangan membahas hal lain selain nomor pesanan
- Gunakan bahasa Indonesia yang hangat dan sopan
- Tambahkan emoji yang sesuai agar terasa natural
- Jika customer bertanya soal lain, tetap arahkan ke nomor pesanan dulu
- Jangan terlalu panjang, cukup 1-3 kalimat per balasan`;

type Config = {
  is_enabled: boolean;
  system_prompt: string;
  order_image_url: string | null;
};

export default function AIConfigPage() {
  const [config, setConfig] = useState<Config>({
    is_enabled: false,
    system_prompt: DEFAULT_PROMPT,
    order_image_url: null,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [toast, setToast] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showToast = (type: "success" | "error", msg: string) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 4000);
  };

  const fetchConfig = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_URL}/api/ai/config`);
      if (!res.ok) throw new Error("Gagal memuat konfigurasi");
      const { config: data } = await res.json();
      setConfig(data);
    } catch (err: any) {
      showToast("error", "Gagal memuat konfigurasi dari server: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConfig();
  }, []);

  const handleToggle = async () => {
    const newVal = !config.is_enabled;
    setConfig((prev) => ({ ...prev, is_enabled: newVal }));
    try {
      const res = await fetch(`${API_URL}/api/ai/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_enabled: newVal }),
      });
      if (!res.ok) throw new Error();
      showToast("success", `Bot AI berhasil ${newVal ? "DIAKTIFKAN 🟢" : "DINONAKTIFKAN 🔴"}`);
    } catch {
      setConfig((prev) => ({ ...prev, is_enabled: !newVal })); // rollback
      showToast("error", "Gagal mengubah status bot.");
    }
  };

  const handleSavePrompt = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/ai/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system_prompt: config.system_prompt }),
      });
      if (!res.ok) throw new Error();
      showToast("success", "Instruksi bot berhasil disimpan!");
    } catch {
      showToast("error", "Gagal menyimpan instruksi bot.");
    } finally {
      setSaving(false);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    const formData = new FormData();
    formData.append("image", file);

    try {
      const res = await fetch(`${API_URL}/api/ai/config/image`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error();
      const { image_url } = await res.json();
      setConfig((prev) => ({ ...prev, order_image_url: image_url }));
      showToast("success", "Gambar contoh nomor pesanan berhasil diupload! 🖼️");
    } catch {
      showToast("error", "Gagal upload gambar. Pastikan ukuran file < 5MB.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center space-y-3 text-gray-400">
          <Loader2 className="w-8 h-8 animate-spin" />
          <span className="text-sm font-medium">Memuat konfigurasi AI...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 h-full flex flex-col bg-gray-50/50">
      {/* Toast Notifikasi */}
      {toast && (
        <div
          className={`fixed top-6 right-6 z-[200] flex items-center space-x-3 px-5 py-3.5 rounded-2xl shadow-xl text-white text-sm font-bold animate-in slide-in-from-top-4 duration-300 ${
            toast.type === "success" ? "bg-emerald-500" : "bg-red-500"
          }`}
        >
          {toast.type === "success" ? <CheckCircle size={18} /> : <AlertTriangle size={18} />}
          <span>{toast.msg}</span>
        </div>
      )}

      {/* Header */}
      <div className="flex justify-between items-end mb-8">
        <div>
          <div className="flex items-center space-x-3 mb-1">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shadow-lg shadow-violet-200">
              <Bot className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-2xl font-black tracking-tight text-gray-900">AI Follow-Up Bot</h1>
          </div>
          <p className="text-sm text-gray-500 font-medium ml-13">
            Bot otomatis meminta nomor pesanan ke customer yang belum mengirimkannya.
          </p>
        </div>
        <button
          onClick={fetchConfig}
          className="flex items-center space-x-2 text-sm font-bold text-gray-500 hover:text-gray-800 bg-white border border-gray-200 px-4 py-2 rounded-xl shadow-sm transition hover:shadow-md"
        >
          <RefreshCw size={15} />
          <span>Refresh</span>
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── Kolom Kiri: Toggle Status + Gambar ── */}
        <div className="flex flex-col gap-6">

          {/* Card: Status Toggle */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
            <h2 className="text-sm font-black uppercase tracking-wider text-gray-500 mb-4">Status Bot</h2>
            <div className={`flex items-center justify-between p-5 rounded-xl border-2 transition-all ${
              config.is_enabled
                ? "bg-emerald-50 border-emerald-200"
                : "bg-gray-50 border-gray-200"
            }`}>
              <div>
                <div className={`text-lg font-black ${config.is_enabled ? "text-emerald-700" : "text-gray-500"}`}>
                  {config.is_enabled ? "🟢 AKTIF" : "⚫ NONAKTIF"}
                </div>
                <div className="text-xs font-medium text-gray-400 mt-1">
                  {config.is_enabled ? "Bot sedang merespons customer" : "Bot tidak aktif"}
                </div>
              </div>
              {/* Toggle Switch */}
              <button
                onClick={handleToggle}
                className={`relative w-14 h-7 rounded-full transition-all duration-300 focus:outline-none focus:ring-4 ${
                  config.is_enabled
                    ? "bg-emerald-500 focus:ring-emerald-200"
                    : "bg-gray-300 focus:ring-gray-200"
                }`}
                title={config.is_enabled ? "Klik untuk nonaktifkan" : "Klik untuk aktifkan"}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform duration-300 ${
                    config.is_enabled ? "translate-x-7" : "translate-x-0"
                  }`}
                />
              </button>
            </div>

            <div className="mt-4 p-3 bg-amber-50 rounded-xl border border-amber-100">
              <p className="text-xs font-medium text-amber-700 leading-relaxed">
                💡 <strong>Cara kerja:</strong> Bot aktif untuk semua customer yang belum punya nomor pesanan. 
                Begitu customer kirim 18 digit angka, bot <strong>otomatis berhenti</strong>.
              </p>
            </div>
          </div>

          {/* Card: Gambar Contoh Nomor Pesanan */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 flex-1">
            <h2 className="text-sm font-black uppercase tracking-wider text-gray-500 mb-1">
              Gambar Contoh Nomor Pesanan
            </h2>
            <p className="text-xs text-gray-400 font-medium mb-4 leading-relaxed">
              Gambar ini dikirim ke customer <strong>sekali</strong> di balasan pertama bot, sebagai panduan visual cara menemukan nomor pesanan.
            </p>

            {/* Preview Gambar */}
            {config.order_image_url ? (
              <div className="relative group mb-4">
                <img
                  src={config.order_image_url}
                  alt="Contoh Nomor Pesanan"
                  className="w-full rounded-xl border border-gray-200 object-cover max-h-48"
                />
                <div className="absolute inset-0 bg-black/40 rounded-xl opacity-0 group-hover:opacity-100 transition flex items-center justify-center">
                  <span className="text-white text-xs font-bold">Ganti Gambar</span>
                </div>
              </div>
            ) : (
              <div className="w-full h-36 rounded-xl border-2 border-dashed border-gray-200 flex flex-col items-center justify-center text-gray-300 mb-4">
                <Image size={32} className="mb-2" />
                <span className="text-xs font-medium">Belum ada gambar</span>
              </div>
            )}

            {/* Tombol Upload */}
            <input
              type="file"
              accept="image/*"
              ref={fileInputRef}
              onChange={handleImageUpload}
              className="hidden"
              id="ai-image-upload"
            />
            <label
              htmlFor="ai-image-upload"
              className={`flex items-center justify-center space-x-2 w-full py-2.5 rounded-xl border-2 border-dashed text-sm font-bold cursor-pointer transition ${
                uploading
                  ? "border-violet-300 text-violet-400 bg-violet-50 cursor-not-allowed"
                  : "border-violet-200 text-violet-600 hover:bg-violet-50 hover:border-violet-400"
              }`}
            >
              {uploading ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  <span>Mengupload...</span>
                </>
              ) : (
                <>
                  <Upload size={16} />
                  <span>{config.order_image_url ? "Ganti Gambar" : "Upload Gambar"}</span>
                </>
              )}
            </label>
            <p className="text-center text-xs text-gray-400 mt-2">Format: JPG, PNG, WEBP • Maks. 5MB</p>
          </div>
        </div>

        {/* ── Kolom Kanan: System Prompt Editor ── */}
        <div className="lg:col-span-2 bg-white rounded-2xl border border-gray-200 shadow-sm p-6 flex flex-col">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-black uppercase tracking-wider text-gray-500">
              Instruksi Kepribadian Bot (System Prompt)
            </h2>
            <button
              onClick={() => setConfig((prev) => ({ ...prev, system_prompt: DEFAULT_PROMPT }))}
              className="text-xs font-bold text-gray-400 hover:text-gray-700 transition underline underline-offset-2"
            >
              Reset ke Default
            </button>
          </div>
          <p className="text-xs text-gray-400 font-medium mb-4 leading-relaxed">
            Ini adalah "jiwa" bot Anda. Tulis instruksi dengan jelas bagaimana bot harus berperilaku, berbicara, dan merespons customer.
          </p>

          <textarea
            value={config.system_prompt}
            onChange={(e) => setConfig((prev) => ({ ...prev, system_prompt: e.target.value }))}
            rows={16}
            placeholder="Tulis instruksi kepribadian bot di sini..."
            className="flex-1 w-full p-4 font-mono text-sm text-gray-800 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-violet-400 focus:border-violet-400 resize-none leading-relaxed transition"
          />

          <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-100">
            <p className="text-xs text-gray-400 font-medium">
              {config.system_prompt.length} karakter • Perubahan langsung aktif tanpa restart server
            </p>
            <button
              onClick={handleSavePrompt}
              disabled={saving}
              className="flex items-center space-x-2 bg-violet-600 hover:bg-violet-700 disabled:bg-violet-300 text-white px-6 py-2.5 rounded-xl text-sm font-bold shadow-md shadow-violet-200 transition"
            >
              {saving ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Save size={16} />
              )}
              <span>{saving ? "Menyimpan..." : "Simpan Instruksi"}</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── Cara Kerja Bot (Info Box) ── */}
      <div className="mt-6 p-5 bg-gradient-to-r from-violet-50 to-indigo-50 rounded-2xl border border-violet-100">
        <h3 className="text-sm font-black text-violet-800 mb-3 flex items-center space-x-2">
          <Bot size={16} />
          <span>Alur Kerja Bot Secara Otomatis</span>
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { step: "1", label: "Customer chat masuk", icon: "💬" },
            { step: "2", label: "Cek nomor pesanan sudah ada?", icon: "🔍" },
            { step: "3", label: "Jika belum → AI balas + kirim gambar (sekali)", icon: "🤖" },
            { step: "4", label: "Customer kirim 18 digit → Bot BERHENTI", icon: "✅" },
          ].map((item) => (
            <div key={item.step} className="bg-white/70 rounded-xl p-3 border border-violet-100/80">
              <div className="text-2xl mb-1">{item.icon}</div>
              <div className="text-xs font-bold text-violet-700 leading-tight">{item.label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
