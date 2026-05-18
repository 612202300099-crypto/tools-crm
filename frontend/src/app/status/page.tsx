"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import apiClient from "@/lib/apiClient";
import { Activity, Wifi, WifiOff, Clock, HardDrive, MessageSquare, RefreshCw, LogIn, AlertTriangle, CheckCircle, Loader2, Users, Image, Mail, Package, Server } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────
type SystemStatus = {
  success: boolean;
  timestamp: string;
  overall: "ok" | "degraded" | "error";
  issues: string[];
  wa: { connected: boolean; qrPending: boolean; label: string };
  drive: { PENDING: number; WAITING_RESI: number; UPLOADING: number; DONE: number; FAILED: number; total: number; lastUploadAt: string | null };
  database: { customers: number; media: number; messages: number };
  queues: { pendingOrders: number; outgoingMessages: number };
  server: { uptimeMs: number; uptimeHuman: string; nodeVersion: string; memoryMB: number };
};

const overallColor = (s: string) => ({
  ok: "bg-emerald-50 border-emerald-200 text-emerald-700",
  degraded: "bg-amber-50 border-amber-200 text-amber-700",
  error: "bg-red-50 border-red-200 text-red-700",
}[s] ?? "bg-gray-50 border-gray-200 text-gray-700");

const overallIcon = (s: string) => ({
  ok: <CheckCircle size={22} className="text-emerald-500" />,
  degraded: <AlertTriangle size={22} className="text-amber-500" />,
  error: <AlertTriangle size={22} className="text-red-500" />,
}[s] ?? <Activity size={22} />);

const STATUS_TOKEN_KEY = "crm_status_token";

// ─── Login Gate ───────────────────────────────────────────────────────────────
function LoginGate({ onLogin }: { onLogin: (token: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setLoading(true);
    try {
      const res = await apiClient.post("/status-login", { username, password });
      if (res.data?.token) {
        sessionStorage.setItem(STATUS_TOKEN_KEY, res.data.token);
        onLogin(res.data.token);
      }
    } catch (err: any) {
      setError(err.response?.data?.error || "Login gagal. Periksa username dan password.");
    } finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-600/20 border border-indigo-500/30 mb-4">
            <Activity size={32} className="text-indigo-400" />
          </div>
          <h1 className="text-2xl font-black text-white">System Monitor</h1>
          <p className="text-slate-400 text-sm mt-1">Kirimfoto CRM — Internal Dashboard</p>
        </div>
        <form onSubmit={handleSubmit} className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-6 shadow-2xl">
          <div className="space-y-4">
            <div>
              <label className="text-xs font-bold text-slate-400 uppercase tracking-wider block mb-1.5">Username</label>
              <input
                type="text" value={username} onChange={e => setUsername(e.target.value)}
                required autoFocus
                className="w-full bg-slate-900/60 border border-slate-600 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 transition-all"
                placeholder="monitor"
              />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-400 uppercase tracking-wider block mb-1.5">Password</label>
              <input
                type="password" value={password} onChange={e => setPassword(e.target.value)}
                required
                className="w-full bg-slate-900/60 border border-slate-600 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 transition-all"
                placeholder="••••••••"
              />
            </div>
            {error && (
              <div className="flex items-center gap-2 bg-red-900/30 border border-red-500/30 rounded-xl px-3 py-2.5 text-red-400 text-sm">
                <AlertTriangle size={14} />
                <span>{error}</span>
              </div>
            )}
            <button
              type="submit" disabled={loading}
              className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 transition-all"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />}
              {loading ? "Memverifikasi..." : "Masuk"}
            </button>
          </div>
          <p className="text-center text-xs text-slate-500 mt-4">Token berlaku 8 jam per sesi</p>
        </form>
      </div>
    </div>
  );
}

// ─── Stat Card ────────────────────────────────────────────────────────────────
function StatCard({ icon, label, value, sub, color = "indigo" }: {
  icon: React.ReactNode; label: string; value: string | number; sub?: string; color?: string;
}) {
  const colorMap: Record<string, string> = {
    indigo: "bg-indigo-50 border-indigo-100", emerald: "bg-emerald-50 border-emerald-100",
    amber: "bg-amber-50 border-amber-100", red: "bg-red-50 border-red-100",
    blue: "bg-blue-50 border-blue-100", purple: "bg-purple-50 border-purple-100",
  };
  return (
    <div className={`rounded-2xl border p-4 ${colorMap[color] || colorMap.indigo}`}>
      <div className="text-gray-500">{icon}</div>
      <div className="mt-3">
        <div className="text-2xl font-black text-gray-900">{value.toLocaleString()}</div>
        <div className="text-xs font-bold text-gray-500 mt-0.5">{label}</div>
        {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
      </div>
    </div>
  );
}

// ─── Drive Progress Bar ───────────────────────────────────────────────────────
function DriveBar({ stats }: { stats: SystemStatus["drive"] }) {
  const total = stats.DONE + stats.PENDING + stats.WAITING_RESI + stats.UPLOADING + stats.FAILED;
  if (total === 0) return <div className="text-xs text-gray-400">Belum ada data Drive</div>;
  const pct = (n: number) => total > 0 ? Math.round((n / total) * 100) : 0;
  return (
    <div className="space-y-2">
      <div className="flex rounded-full overflow-hidden h-3 w-full bg-gray-100">
        {stats.DONE > 0 && <div className="bg-emerald-400 h-full transition-all" style={{ width: pct(stats.DONE) + "%" }} />}
        {stats.UPLOADING > 0 && <div className="bg-blue-400 h-full animate-pulse" style={{ width: pct(stats.UPLOADING) + "%" }} />}
        {stats.PENDING > 0 && <div className="bg-amber-400 h-full transition-all" style={{ width: pct(stats.PENDING) + "%" }} />}
        {stats.WAITING_RESI > 0 && <div className="bg-orange-400 h-full transition-all" style={{ width: pct(stats.WAITING_RESI) + "%" }} />}
        {stats.FAILED > 0 && <div className="bg-red-500 h-full transition-all" style={{ width: pct(stats.FAILED) + "%" }} />}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />{stats.DONE} Selesai</span>
        {stats.UPLOADING > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-400 inline-block animate-pulse" />{stats.UPLOADING} Uploading</span>}
        {stats.PENDING > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />{stats.PENDING} Pending</span>}
        {stats.WAITING_RESI > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-orange-400 inline-block" />{stats.WAITING_RESI} Tunggu Resi</span>}
        {stats.FAILED > 0 && <span className="flex items-center gap-1 text-red-600 font-bold"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" />{stats.FAILED} Gagal</span>}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function SystemStatusPage() {
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [countdown, setCountdown] = useState(10);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const countRef = useRef<NodeJS.Timeout | null>(null);

  // Cek token yang tersimpan di sessionStorage
  useEffect(() => {
    const saved = sessionStorage.getItem(STATUS_TOKEN_KEY);
    if (saved) setToken(saved);
  }, []);

  const fetchStatus = useCallback(async (tok: string) => {
    setLoading(true);
    try {
      const res = await apiClient.get("/system-status", {
        headers: { Authorization: `Bearer ${tok}` },
      });
      setStatus(res.data);
      setLastRefresh(new Date());
      setCountdown(10);
    } catch (err: any) {
      if (err.response?.status === 401 || err.response?.status === 403) {
        sessionStorage.removeItem(STATUS_TOKEN_KEY);
        setToken(null);
      }
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!token) return;
    fetchStatus(token);
    intervalRef.current = setInterval(() => fetchStatus(token), 10000);
    countRef.current = setInterval(() => setCountdown(c => c > 0 ? c - 1 : 10), 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (countRef.current) clearInterval(countRef.current);
    };
  }, [token, fetchStatus]);

  // Tampilkan login gate jika belum ada token
  if (!token) return <LoginGate onLogin={setToken} />;

  const handleLogout = () => {
    sessionStorage.removeItem(STATUS_TOKEN_KEY);
    setToken(null);
    setStatus(null);
  };

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-black text-gray-900 flex items-center gap-2">
              <Activity size={26} className="text-indigo-600" />
              System Monitor
            </h1>
            <p className="text-sm text-gray-400 mt-0.5">Kirimfoto CRM — Auto-refresh setiap 10 detik</p>
          </div>
          <div className="flex items-center gap-3">
            {lastRefresh && (
              <span className="text-xs text-gray-400 flex items-center gap-1">
                <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
                Refresh dalam {countdown}d
              </span>
            )}
            <button
              onClick={() => token && fetchStatus(token)}
              className="text-xs font-bold bg-white border border-gray-200 px-3 py-2 rounded-xl flex items-center gap-1.5 hover:bg-gray-50 transition-all shadow-sm"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
              Refresh
            </button>
            <button onClick={handleLogout} className="text-xs text-gray-400 hover:text-gray-600 transition-colors">
              Keluar
            </button>
          </div>
        </div>

        {!status && loading && (
          <div className="flex items-center justify-center h-64">
            <Loader2 size={32} className="animate-spin text-indigo-400" />
          </div>
        )}

        {status && (
          <div className="space-y-5">
            {/* Overall Health */}
            <div className={`rounded-2xl border-2 p-4 flex items-center gap-3 ${overallColor(status.overall)}`}>
              {overallIcon(status.overall)}
              <div>
                <div className="font-black text-lg">
                  {status.overall === "ok" ? "✅ Semua Sistem Normal" : status.overall === "degraded" ? "⚠️ Sistem Degraded" : "🔴 Ada Masalah Kritis"}
                </div>
                {status.issues.length > 0 ? (
                  <ul className="text-sm mt-1 space-y-0.5">{status.issues.map((issue, i) => <li key={i}>• {issue}</li>)}</ul>
                ) : (
                  <div className="text-sm opacity-75">Tidak ada masalah terdeteksi. Sistem berjalan optimal.</div>
                )}
              </div>
            </div>

            {/* WA Status */}
            <div className="bg-white rounded-2xl border border-gray-200 p-5 shadow-sm">
              <h2 className="font-black text-gray-900 text-sm uppercase tracking-wider mb-3 flex items-center gap-2">
                <MessageSquare size={15} className="text-green-500" /> WhatsApp Engine
              </h2>
              <div className="flex items-center gap-3">
                {status.wa.connected ? (
                  <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-2.5">
                    <Wifi size={18} className="text-emerald-500" />
                    <span className="font-black text-emerald-700">Terhubung</span>
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  </div>
                ) : status.wa.qrPending ? (
                  <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5">
                    <Loader2 size={18} className="text-amber-500 animate-spin" />
                    <span className="font-black text-amber-700">Menunggu Scan QR</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5">
                    <WifiOff size={18} className="text-red-500" />
                    <span className="font-black text-red-700">Tidak Terhubung</span>
                  </div>
                )}
              </div>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard icon={<Users size={18} />} label="Total Customer" value={status.database.customers} color="indigo" />
              <StatCard icon={<Image size={18} />} label="Total Foto" value={status.database.media} color="purple" />
              <StatCard icon={<MessageSquare size={18} />} label="Total Pesan" value={status.database.messages} color="blue" />
              <StatCard icon={<Package size={18} />} label="Order Pending" value={status.queues.pendingOrders}
                color={status.queues.pendingOrders > 20 ? "red" : "emerald"}
                sub={status.queues.pendingOrders > 0 ? "Menunggu lookup spreadsheet" : "Semua order terproses"} />
            </div>

            {/* Drive Upload */}
            <div className="bg-white rounded-2xl border border-gray-200 p-5 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-black text-gray-900 text-sm uppercase tracking-wider flex items-center gap-2">
                  <HardDrive size={15} className="text-blue-500" /> Google Drive Upload Queue
                </h2>
                <span className="text-xs text-gray-400">Total: {status.drive.total.toLocaleString()} item</span>
              </div>
              <DriveBar stats={status.drive} />
              {status.drive.lastUploadAt && (
                <div className="mt-3 text-xs text-gray-400">
                  Upload terakhir: {new Date(status.drive.lastUploadAt).toLocaleString("id-ID")}
                </div>
              )}
              {status.drive.FAILED > 0 && (
                <div className="mt-3 flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-red-600 text-xs font-bold">
                  <AlertTriangle size={13} />
                  {status.drive.FAILED} foto gagal upload. Sistem akan retry otomatis (max 5x).
                </div>
              )}
            </div>

            {/* Server Info */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <StatCard icon={<Clock size={18} />} label="Server Uptime" value={status.server.uptimeHuman} color="emerald" sub="Sejak terakhir restart" />
              <StatCard icon={<Server size={18} />} label="Memory Usage" value={status.server.memoryMB + " MB"} color="amber" sub={"Node " + status.server.nodeVersion} />
              <StatCard icon={<Mail size={18} />} label="Pesan Bot Antri" value={status.queues.outgoingMessages} color="blue"
                sub={status.queues.outgoingMessages > 0 ? "Sedang diproses outgoing queue" : "Queue kosong"} />
            </div>

            {/* Footer */}
            <div className="text-center text-xs text-gray-400 pb-4">
              Data diperbarui: {lastRefresh ? lastRefresh.toLocaleTimeString("id-ID") : "—"} &nbsp;|&nbsp;
              Timestamp server: {new Date(status.timestamp).toLocaleTimeString("id-ID")}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
