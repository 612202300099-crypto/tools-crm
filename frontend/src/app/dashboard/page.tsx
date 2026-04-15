"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import Link from "next/link";
import { format, startOfDay, endOfDay, subDays, startOfMonth, endOfMonth } from "date-fns";
import { Search, Filter, Calendar, Trash2 } from "lucide-react";

type Customer = {
  id: string;
  phone_number: string;
  name: string | null;
  order_id: string | null;
  status: string;
  is_valid: boolean;
  created_at: string;
};

export default function DashboardInbox() {
   return (
      <Suspense fallback={<div className="p-10 text-center text-gray-500 animate-pulse">Memuat dashboard...</div>}>
         <DashboardInboxContent />
      </Suspense>
   );
}

function DashboardInboxContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Fitur Penghapusan Massal
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isDeleting, setIsDeleting] = useState(false);
  
  // Poin 5: State penyimpan rentang aktif untuk filter lokal data realtime
  const [activeDateRange, setActiveDateRange] = useState<{start: Date|null, end: Date|null}>({start: null, end: null});

  // Initializing state from URL safely
  const initSearch = searchParams.get("search") || "";
  const initStatus = searchParams.get("status") || "ALL";
  const initDate = searchParams.get("date") || "ALL";
  const initCustomStart = searchParams.get("start") || "";
  const initCustomEnd = searchParams.get("end") || "";

  // Filter & Search states
  const [searchQuery, setSearchQuery] = useState(initSearch);
  const [filterStatus, setFilterStatus] = useState(initStatus);
  const [dateFilter, setDateFilter] = useState(initDate);
  const [customStart, setCustomStart] = useState(initCustomStart);
  const [customEnd, setCustomEnd] = useState(initCustomEnd);

  const updateUrlParams = useCallback((params: Record<string, string>) => {
      const current = new URLSearchParams(Array.from(searchParams.entries()));
      for (const [key, value] of Object.entries(params)) {
          if (value === "" || value === "ALL") {
              current.delete(key);
          } else {
              current.set(key, value);
          }
      }
      const search = current.toString();
      const query = search ? `?${search}` : "";
      router.push(`${pathname}${query}`);
  }, [pathname, router, searchParams]);

  // Poin 1 & 7: Manual Fetch diatur secara spesifik. Akan panggil spinner saat initial load dan filter diganti.
  const fetchCustomers = useCallback(async () => {
    setLoading(true);
    
    // Poin 6: Optimasi Server (Tingkatkan Skalabilitas Performa)
    let query = supabase
      .from("customers")
      .select("id, phone_number, name, order_id, status, is_valid, created_at")
      .order("created_at", { ascending: false })
      .limit(1000); // Failsafe memory

    let rangeStart: Date | null = null;
    let rangeEnd: Date | null = null;
    const now = new Date(); // Local WIB time if browser is set to WIB

    if (dateFilter === "TODAY") {
        rangeStart = startOfDay(now);
        rangeEnd = endOfDay(now);
    } else if (dateFilter === "YESTERDAY") {
        const yesterday = subDays(now, 1);
        rangeStart = startOfDay(yesterday);
        rangeEnd = endOfDay(yesterday);
    } else if (dateFilter === "7DAYS") {
        rangeStart = startOfDay(subDays(now, 7));
        rangeEnd = endOfDay(now);
    } else if (dateFilter === "THIS_MONTH") {
        rangeStart = startOfMonth(now);
        rangeEnd = endOfMonth(now);
    } else if (dateFilter === "CUSTOM" && customStart && customEnd) {
        rangeStart = startOfDay(new Date(customStart));
        rangeEnd = endOfDay(new Date(customEnd));
    }
    
    // Simpan acuan tanggal untuk filter payload Realtime
    setActiveDateRange({ start: rangeStart, end: rangeEnd });

    if (rangeStart && rangeEnd) {
        // toISOString automatically converts the local boundary to UTC format which Supabase reads correctly
        query = query.gte("created_at", rangeStart.toISOString())
                     .lte("created_at", rangeEnd.toISOString());
    }

    const { data } = await query;
    if (data) setCustomers(data);
    setLoading(false);
  }, [dateFilter, customStart, customEnd]);

  // Poin 4.A: useEffect 1 - Hanya ter-trigger spesifik saat referensi fetchCustomers berubah (Filter diubah user).
  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  // Poin 4.B & Poin 2: useEffect 2 - Subscribe tunggal, TANPA TRIGGER LOAD, Inject local mutation.
  useEffect(() => {
    const channel = supabase
      .channel('customers_realtime_db')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'customers' },
        (payload) => {
          setCustomers(prev => {
             // Operasi efisien, React akan mem-batch re-renders saat payload membludak (Poin 3 implicitly di-handle UI tree)
             if (payload.eventType === 'DELETE') {
                 return prev.filter(c => c.id !== payload.old.id);
             }

             const newCust = payload.new as Customer;
             const exists = prev.some(c => c.id === newCust.id);
             
             if (exists) {
                 // Replace (Update) baris spesifik tanpa mempengaruiurutan
                 return prev.map(c => c.id === newCust.id ? newCust : c);
             } else {
                 // Prepend (Insert) di posisi ter-atas
                 return [newCust, ...prev];
             }
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []); // Array Dependensi Kosong: Mengunci re-subscribe! Tidak peduli filter berubah berapapun!

  // Logika Pencarian & Filter Lokal (Hanya Teks & Status yang di filter lokal agar sangat cepat)
  const filteredCustomers = customers.filter(c => {
     // Poin 5: Validasi Data Siluman dari Realtime!
     // Guard: Apabila ada Insert tapi ternyata tgl tidak sesuai filter aktif, Sembunyikan.
     if (activeDateRange.start && activeDateRange.end) {
         const cDate = new Date(c.created_at);
         if (cDate < activeDateRange.start || cDate > activeDateRange.end) {
             return false;
         }
     }

     const q = searchQuery.toLowerCase();
     const matchesSearch = 
        c.phone_number.includes(q) || 
        (c.name && c.name.toLowerCase().includes(q)) || 
        (c.order_id && c.order_id.toLowerCase().includes(q));
     
     const matchesStatus = filterStatus === "ALL" || c.status === filterStatus;

     return matchesSearch && matchesStatus;
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'BELUM_KIRIM_FOTO':
        return <span className="px-2 py-1 bg-yellow-100 text-yellow-800 text-xs font-medium rounded-full border border-yellow-200 shadow-sm">Belum Kirim Foto</span>;
      case 'SUDAH_KIRIM_FOTO':
        return <span className="px-2 py-1 bg-blue-100 text-blue-800 text-xs font-medium rounded-full border border-blue-200 shadow-sm">Sudah Kirim Foto</span>;
      case 'VALIDATED':
        return <span className="px-2 py-1 bg-green-100 text-green-800 text-xs font-medium rounded-full border border-green-200 shadow-sm">Divalidasi</span>;
      default:
        return <span className="px-2 py-1 bg-gray-100 text-gray-800 text-xs font-medium rounded-full border border-gray-200 shadow-sm">{status.replace(/_/g, ' ')}</span>;
    }
  };

  const handleDateFilterChange = (val: string) => {
    setDateFilter(val);
    updateUrlParams({ date: val });
  };

  const handleCustomDate = (type: 'start'|'end', val: string) => {
    if (type === 'start') {
        setCustomStart(val);
        updateUrlParams({ start: val });
    } else {
        setCustomEnd(val);
        updateUrlParams({ end: val });
    }
  };

  const handleMassDelete = async () => {
    const arrIds = Array.from(selectedIds);
    if (arrIds.length === 0) return;
    
    const isConfirmed = window.confirm(`PERINGATAN KERAS! Anda yakin akan menghapus permanen ${arrIds.length} pelanggan ini?\n\n- Seluruh Folder File VPS akan dihapus bersih.\n- Seluruh riwayat DB (customers, messages, media) tuntas dilebur.\nAksi ini bersifat Final dan Tidak Dapat Dikembalikan. Lanjutkan?`);
    if (!isConfirmed) return;

    setIsDeleting(true);
    try {
        const waUrl = "https://api-wa.parecustom.com"; // API Production
        const res = await fetch(`${waUrl}/api/wa/delete-chats`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ customer_ids: arrIds })
        });
        
        if (!res.ok) throw new Error("Gagal mengeksekusi penghapusan di Server");
        const { count } = await res.json();
        
        alert(`SUKSES: ${count} Pelanggan beserta seluruh foto aslinya di VPS telah dimusnahkan secara aman & terisolasi.`);
        setSelectedIds(new Set());
        fetchCustomers(); // Refresh daftar setelah hapus sukses
    } catch (err: any) {
        alert("Terjadi Error Sistem Coretan: " + err.message);
    } finally {
        setIsDeleting(false);
    }
  };

  return (
    <div className="p-8 h-full flex flex-col bg-gray-50/50">
      <div className="flex justify-between items-end mb-6">
         <div>
            <h1 className="text-2xl font-black tracking-tight text-gray-900">Inbox Pesanan</h1>
            <p className="text-sm text-gray-500 font-medium mt-1">Mengelola pelanggan dari sumber API WhatsApp.</p>
         </div>
         <div className="text-sm font-bold bg-white border px-4 py-2 rounded-xl text-indigo-600 shadow-sm flex items-center space-x-2">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
            <span>Real-time Active</span>
         </div>
      </div>
      
      {/* Fitur Pencarian & Filter */}
      <div className="flex flex-col lg:flex-row gap-3 mb-4">
         <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={18} />
            <input 
              type="text" 
              placeholder="Cari kode seri, nama atau nomor handphone..." 
              value={searchQuery}
              onChange={e => {
                  setSearchQuery(e.target.value);
                  updateUrlParams({ search: e.target.value });
              }}
              className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 bg-white font-medium text-sm transition-shadow shadow-sm hover:shadow-md"
            />
         </div>
         <div className="relative w-full lg:w-48 shrink-0">
            <Filter className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={18} />
            <select 
               value={filterStatus}
               onChange={e => {
                   setFilterStatus(e.target.value);
                   updateUrlParams({ status: e.target.value });
               }}
               className="w-full pl-10 pr-8 py-2.5 border border-gray-200 rounded-xl focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 bg-white appearance-none cursor-pointer font-bold text-gray-700 text-sm shadow-sm transition-shadow hover:shadow-md"
            >
               <option value="ALL">Status: Semua</option>
               <option value="BELUM_KIRIM_FOTO">Belum Kirim Foto</option>
               <option value="SUDAH_KIRIM_FOTO">Sudah Kirim Foto</option>
               <option value="VALIDATED">Selesai/Divalidasi</option>
            </select>
         </div>
         <div className="relative w-full lg:w-56 shrink-0">
            <Calendar className="absolute left-3 top-1/2 transform -translate-y-1/2 text-indigo-500" size={18} />
            <select 
               value={dateFilter}
               onChange={e => handleDateFilterChange(e.target.value)}
               className="w-full pl-10 pr-8 py-2.5 border border-indigo-200 rounded-xl focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 bg-indigo-50/30 appearance-none cursor-pointer font-bold text-indigo-900 text-sm shadow-sm hover:bg-white transition-colors"
            >
               <option value="ALL">Waktu: Semua</option>
               <option value="TODAY">Hari Ini</option>
               <option value="YESTERDAY">Kemarin</option>
               <option value="7DAYS">7 Hari Terakhir</option>
               <option value="THIS_MONTH">Bulan Ini</option>
               <option value="CUSTOM">📅 Kustom Rentang...</option>
            </select>
         </div>
      </div>

      {dateFilter === "CUSTOM" && (
         <div className="flex flex-col md:flex-row gap-4 mb-4 p-4 bg-indigo-50/50 border border-indigo-100 rounded-2xl animate-in fade-in slide-in-from-top-2">
             <div className="flex-1 max-w-sm">
                 <label className="block text-xs font-bold text-indigo-800 uppercase tracking-widest mb-1.5 ml-1">Dari Tanggal</label>
                 <input type="date" value={customStart} onChange={e => handleCustomDate('start', e.target.value)} className="w-full px-4 py-2 border border-indigo-200 rounded-xl text-sm font-medium focus:ring-2 focus:ring-indigo-500 outline-none text-indigo-900 bg-white" />
             </div>
             <div className="flex-1 max-w-sm">
                 <label className="block text-xs font-bold text-indigo-800 uppercase tracking-widest mb-1.5 ml-1">Sampai Tanggal</label>
                 <input type="date" value={customEnd} onChange={e => handleCustomDate('end', e.target.value)} className="w-full px-4 py-2 border border-indigo-200 rounded-xl text-sm font-medium focus:ring-2 focus:ring-indigo-500 outline-none text-indigo-900 bg-white" />
             </div>
             <div className="flex-1 flex items-end pb-1 text-xs font-medium text-indigo-600/70">
                 *(Data akan ditarik jika kedua tanggal terisi)
             </div>
         </div>
      )}

      {/* Indikator Filter Aktif */}
      {(dateFilter !== "ALL" || filterStatus !== "ALL" || searchQuery) && (
          <div className="flex items-center space-x-2 mb-4 text-xs font-bold text-gray-500">
             <span>Menampilkan hasil: </span>
             {searchQuery && <span className="bg-gray-100 px-2 py-1 rounded text-gray-700">"{searchQuery}"</span>}
             {filterStatus !== "ALL" && <span className="bg-gray-100 px-2 py-1 rounded text-gray-700">{filterStatus.replace(/_/g, ' ')}</span>}
             {dateFilter !== "ALL" && <span className="bg-indigo-100 text-indigo-700 px-2 py-1 rounded">Filter Tanggal Aktif</span>}
          </div>
      )}

      <div className="bg-white rounded-2xl shadow-sm border border-gray-200/80 overflow-hidden flex-1 flex flex-col ring-1 ring-black/5 ring-opacity-5">
        <div className="overflow-y-auto w-full flex-1">
          <table className="w-full text-left border-collapse">
            <thead className="bg-gray-50/80 border-b border-gray-200 sticky top-0 backdrop-blur-md z-10">
              <tr>
                <th className="p-4 w-12 text-center border-r border-gray-100">
                    <input 
                      type="checkbox" 
                      onClick={() => {
                          if (selectedIds.size === filteredCustomers.length && filteredCustomers.length > 0) {
                              setSelectedIds(new Set());
                          } else {
                              setSelectedIds(new Set(filteredCustomers.map(c => c.id)));
                          }
                      }} 
                      checked={selectedIds.size === filteredCustomers.length && filteredCustomers.length > 0}
                      onChange={() => {}}
                      className="w-4 h-4 text-red-600 rounded focus:ring-red-500 cursor-pointer"
                    />
                </th>
                <th className="p-4 font-bold text-xs uppercase tracking-wider text-gray-500">Pelanggan</th>
                <th className="p-4 font-bold text-xs uppercase tracking-wider text-gray-500">Nomor Order</th>
                <th className="p-4 font-bold text-xs uppercase tracking-wider text-gray-500">Status Terbaru</th>
                <th className="p-4 font-bold text-xs uppercase tracking-wider text-gray-500">Waktu Masuk</th>
                <th className="p-4 font-bold text-xs uppercase tracking-wider text-gray-500 w-32 text-center">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                    <td colSpan={6} className="p-16">
                        <div className="flex flex-col items-center justify-center space-y-3">
                            <div className="w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div>
                            <div className="text-sm font-bold text-indigo-900 animate-pulse">Menarik data dari database...</div>
                        </div>
                    </td>
                </tr>
              ) : filteredCustomers.length === 0 ? (
                <tr>
                    <td colSpan={6} className="p-16 text-center">
                        <div className="text-gray-400 mb-2">✨</div>
                        <div className="text-base font-bold text-gray-900">Tidak ada pesanan ditemukan</div>
                        <div className="text-sm font-medium text-gray-500 mt-1">Coba ubah kata kunci atau rentang tanggal Anda.</div>
                    </td>
                </tr>
              ) : (
                filteredCustomers.map((c) => {
                  const isChecked = selectedIds.has(c.id);
                  return (
                  <tr key={c.id} className={`hover:bg-indigo-50/30 transition duration-150 ease-in-out group ${isChecked ? 'bg-red-50/40' : ''}`}>
                    <td className="p-4 text-center border-r border-gray-50/50">
                        <input 
                           type="checkbox" 
                           checked={isChecked} 
                           onChange={() => {
                               const next = new Set(selectedIds);
                               if (next.has(c.id)) next.delete(c.id); else next.add(c.id);
                               setSelectedIds(next);
                           }} 
                           className="w-4 h-4 text-red-600 rounded focus:ring-red-500 cursor-pointer" 
                        />
                    </td>
                    <td className="p-4">
                      <div className="font-extrabold text-gray-900 text-sm group-hover:text-indigo-900 transition-colors">{c.name || 'NN'}</div>
                      <div className="text-xs text-gray-500 font-mono mt-0.5 tracking-wide">{c.phone_number}</div>
                    </td>
                    <td className="p-4 font-bold text-gray-700 text-sm">{c.order_id || '-'}</td>
                    <td className="p-4">{getStatusBadge(c.status)}</td>
                    <td className="p-4 text-gray-500 text-sm font-medium whitespace-nowrap">
                      {format(new Date(c.created_at), 'dd MMM yy')}
                      <span className="text-xs text-gray-400 ml-1.5">{format(new Date(c.created_at), 'HH:mm')}</span>
                    </td>
                    <td className="p-4 text-center">
                      <Link 
                        href={`/dashboard/${c.id}`}
                        className="inline-flex items-center justify-center w-full bg-white text-gray-800 border border-gray-300 px-4 py-2 rounded-xl text-xs font-bold hover:bg-gray-50 hover:border-indigo-300 hover:text-indigo-600 transition-all shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1"
                      >
                        Buka Riwayat
                      </Link>
                    </td>
                  </tr>
                )})
              )}
            </tbody>
          </table>
        </div>
        <div className="bg-gray-50 p-4 border-t text-xs font-bold text-gray-500 text-center flex justify-between items-center">
            <span>Total Hasil: <span className="text-gray-900">{filteredCustomers.length}</span> pelanggan.</span>
            <span>Auto-Collage Secure CRM</span>
        </div>
      </div>
      
      {/* Tombol Hapus Melayang (Floating Action) */}
      {selectedIds.size > 0 && (
         <div className="fixed bottom-12 left-1/2 transform -translate-x-1/2 bg-white pl-6 pr-3 py-3 rounded-2xl shadow-[0_15px_40px_-5px_rgba(220,38,38,0.25)] border border-red-100 flex items-center space-x-6 z-[100] animate-in slide-in-from-bottom-8 duration-300">
             <div className="font-bold text-gray-800 flex items-center">
                 <span className="text-red-700 font-black px-2 py-0.5 bg-red-100/80 rounded-md mr-3">{selectedIds.size}</span>
                 <span className="tracking-tight">Dipilih</span>
             </div>
             <button 
                onClick={handleMassDelete} 
                disabled={isDeleting} 
                className="flex items-center space-x-2 bg-red-600 hover:bg-red-700 text-white px-6 py-2.5 rounded-xl text-sm font-bold shadow-md transition disabled:bg-red-400"
             >
                 {isDeleting ? (
                    <span className="w-5 h-5 border-2 border-white border-t-red-400 rounded-full animate-spin"></span>
                 ) : (
                    <Trash2 size={18} />
                 )}
                 <span>{isDeleting ? "MEMUSNAHKAN..." : "Hapus Permanen"}</span>
             </button>
             <button onClick={() => setSelectedIds(new Set())} className="text-gray-400 hover:text-gray-600 transition p-2 hover:bg-gray-100 rounded-xl" title="Batalkan">
                 ✕
             </button>
         </div>
      )}
    </div>
  );
}
