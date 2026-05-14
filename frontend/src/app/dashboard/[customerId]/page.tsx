"use client";

import { useEffect, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import apiClient, { initSocket, API_BASE_URL } from "@/lib/apiClient";
import JSZip from "jszip";
import { saveAs } from "file-saver";
import { ArrowLeft, Download, CheckCircle, Image as ImageIcon, MessageSquare, Send, ScanSearch, Trash2, Cloud } from "lucide-react";
import Link from "next/link";
import clsx from "clsx";

type Message = {
  id: string;
  body: string;
  is_from_me: boolean;
  created_at: string;
  is_deleted?: boolean;
};

type Media = {
  id: string;
  file_url: string;
  file_name: string;
  excluded_from_production?: boolean | number;
  media_kind?: string | null;
  detected_order_id?: string | null;
  classification_status?: string | null;
};

const WA_API_URL = API_BASE_URL;

export default function ChatDetail() {
  const params = useParams();
  const customerId = params.customerId as string;
  const router = useRouter();

  const [customer, setCustomer] = useState<any>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [mediaList, setMediaList] = useState<Media[]>([]);
  const [selectedMedia, setSelectedMedia] = useState<Set<string>>(new Set());
  
  // Forms
  const [nameInput, setNameInput] = useState("");
  const [orderIdInput, setOrderIdInput] = useState("");
  
  // Quick Reply
  const [replyText, setReplyText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [loadingMedia, setLoadingMedia] = useState(false);
  const [isResyncing, setIsResyncing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  
  // Fitur Baru: Scan AI & Hapus Media
  const [isScanning, setIsScanning] = useState(false);
  const [isDeletingMedia, setIsDeletingMedia] = useState(false);
  const [scanResult, setScanResult] = useState<{type: 'success'|'error'|'not_found', message: string} | null>(null);
  const [isSyncingDrive, setIsSyncingDrive] = useState(false);
  
  // [UPGRADE] State untuk progres Gali Ulang real-time via Socket.IO
  const [resyncProgress, setResyncProgress] = useState<{message: string; done: boolean; totalMessages?: number; totalMedia?: number; error?: string} | null>(null);
  
  // State untuk status sinkronisasi Drive dari backend
  const [driveStatus, setDriveStatus] = useState<Record<string, string>>({});
  const isProductionMedia = (media: Media) => !media.excluded_from_production;
  const selectedProductionIds = () => Array.from(selectedMedia).filter(id => {
    const media = mediaList.find(m => m.id === id);
    return media && isProductionMedia(media);
  });
  useEffect(() => {
    fetchData();

    const socket = initSocket();

    const handleDbChange = (payload: any) => {
        if (payload.table === 'messages') {
            const data = payload.new || payload.old;
            if (data?.customer_id === customerId) {
                if (payload.eventType === 'INSERT') {
                    setMessages(prev => [...prev, payload.new as Message]);
                } else if (payload.eventType === 'UPDATE') {
                    const updated = payload.new as Message;
                    setMessages(prev => prev.map(m => m.id === updated.id ? updated : m));
                } else if (payload.eventType === 'DELETE') {
                    setMessages(prev => prev.filter(m => m.id !== payload.old.id));
                }
            }
        } else if (payload.table === 'media') {
            const data = payload.new || payload.old;
            if (data?.customer_id === customerId) {
                if (payload.eventType === 'INSERT') {
                    setMediaList(prev => [payload.new as Media, ...prev]);
                } else if (payload.eventType === 'UPDATE') {
                    const updated = payload.new as Media;
                    setMediaList(prev => prev.map(m => m.id === updated.id ? updated : m));
                } else if (payload.eventType === 'DELETE') {
                    setMediaList(prev => prev.filter(m => m.id !== payload.old.id));
                }
            }
        } else if (payload.table === 'customers') {
            const data = payload.new || payload.old;
            if (data?.id === customerId) {
                if (payload.eventType === 'UPDATE') {
                    const updated = payload.new;
                    setCustomer((prev: any) => ({ ...prev, ...updated }));
                    if (updated.order_id) setOrderIdInput(updated.order_id);
                }
            }
        }
    };

    socket.on('db_change', handleDbChange);

    // [UPGRADE] Dengarkan event progres Gali Ulang dari backend
    const handleResyncStarted = (data: any) => {
      if (data?.customer_id === customerId || data?.phone_number === customer?.phone_number) {
        setResyncProgress({ message: '🔍 Memulai Gali Ulang... Menyisir riwayat chat WA.', done: false });
      }
    };
    const handleResyncProgress = (data: any) => {
      if (data?.phone_number === customer?.phone_number || data?.customer_id === customerId) {
        setResyncProgress({ message: data.message || 'Sedang memproses...', done: false });
      }
    };
    const handleResyncDone = (data: any) => {
      if (data?.phone_number === customer?.phone_number || data?.customer_id === customerId) {
        setIsResyncing(false);
        if (data.error) {
          setResyncProgress({ message: `❌ Gagal: ${data.error}`, done: true, error: data.error });
        } else {
          setResyncProgress({
            message: `✅ Selesai! Ditemukan ${data.totalMessages || 0} pesan & ${data.totalMedia || 0} foto/video. Foto sedang diunduh di latar belakang.`,
            done: true,
            totalMessages: data.totalMessages,
            totalMedia: data.totalMedia
          });
          // Auto-refresh data setelah 3 detik
          setTimeout(() => fetchData(), 3000);
          // Auto-hilangkan banner setelah 15 detik
          setTimeout(() => setResyncProgress(null), 15000);
        }
      }
    };

    socket.on('resync_started', handleResyncStarted);
    socket.on('resync_progress', handleResyncProgress);
    socket.on('resync_done', handleResyncDone);

    return () => {
        socket.off('db_change', handleDbChange);
        socket.off('resync_started', handleResyncStarted);
        socket.off('resync_progress', handleResyncProgress);
        socket.off('resync_done', handleResyncDone);
    };
  }, [customerId]);

  useEffect(() => {
    if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Auto-hilangkan notifikasi scan setelah 5 detik
  useEffect(() => {
    if (scanResult) {
      const timer = setTimeout(() => setScanResult(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [scanResult]);

  // Polling Real-time Status Google Drive per 5 detik (Smart Polling)
  useEffect(() => {
    let isMounted = true;
    let timeoutId: NodeJS.Timeout;

    const checkDriveStatus = async () => {
        if (!isMounted) return;
        try {
            const res = await apiClient.get(`/customers/${customerId}/drive-status`);
            if (res.data) {
                setDriveStatus(res.data);
                
                // Cek apakah masih ada foto yang mengantre atau diproses
                const hasActive = Object.values(res.data).some(
                    (s: any) => s === 'PENDING' || s === 'UPLOADING' || s === 'WAITING_RESI'
                );
                
                // Hanya polling lagi jika ada yang aktif (mengurangi beban server drastis)
                if (hasActive && isMounted) {
                    timeoutId = setTimeout(checkDriveStatus, 5000);
                }
            }
        } catch (err) {
            // silent fail, retry later if needed
            if (isMounted) timeoutId = setTimeout(checkDriveStatus, 10000); // 10 detik retry
        }
    };

    checkDriveStatus();

    return () => {
        isMounted = false;
        if (timeoutId) clearTimeout(timeoutId);
    };
  }, [customerId, isSyncingDrive]); // Trigger ulang polling saat tombol Antar ke Drive ditekan

  const fetchData = async () => {
    try {
        const cData = await apiClient.get(`/customers/${customerId}`);
        if (cData.data) {
            setCustomer(cData.data);
            setNameInput(cData.data.name || "");
            setOrderIdInput(cData.data.order_id || "");
        }

        const mData = await apiClient.get(`/customers/${customerId}/messages`);
        if (mData.data) setMessages(mData.data);

        const mediaData = await apiClient.get(`/customers/${customerId}/media`);
        if (mediaData.data) setMediaList(mediaData.data);
    } catch (err) {
        console.error("Gagal menarik data detail:", err);
    }
  };

  const handleUpdateCustomer = async () => {
    const changes = { name: nameInput, order_id: orderIdInput };
    await apiClient.put(`/customers/${customerId}`, changes);
    setCustomer({ ...customer, ...changes });
    alert("Data Profil Pelanggan berhasil disimpan!");
  };

  const handleValidate = async () => {
    const changes = { status: 'VALIDATED', is_valid: true };
    await apiClient.put(`/customers/${customerId}`, changes);
    setCustomer({ ...customer, ...changes });
    alert("Proses Selesai: Customer ditandai VALID.");
  };

  const handleResync = async () => {
    const confirmAsk = window.confirm("Perintah ini akan menggali ulang SELURUH riwayat foto & pesan dari WhatsApp (termasuk foto lama dari @LID dan @C.US). Progres akan muncul di layar secara real-time. Lanjutkan?");
    if (!confirmAsk) return;
    
    setIsResyncing(true);
    setResyncProgress({ message: '⏳ Mengirim perintah ke server...', done: false });
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        let res: Response;
        try {
            res = await fetch(`${WA_API_URL}/api/wa/resync`, {
               method: 'POST',
               headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify({ 
                   phone_number: customer.phone_number, 
                   customer_id: customer.id
               }),
               signal: controller.signal,
            });
            clearTimeout(timeoutId);
        } catch (networkErr: any) {
            clearTimeout(timeoutId);
            setIsResyncing(false);
            setResyncProgress({ message: networkErr.name === 'AbortError' ? '⚠️ Server tidak merespons dalam 15 detik.' : '⚠️ Tidak bisa terhubung ke server.', done: true, error: 'network' });
            return;
        }

        if (!res.ok) {
           const errData = await res.json().catch(() => ({}));
           setIsResyncing(false);
           setResyncProgress({ message: `❌ ${errData.error || 'Gali Ulang gagal.'}`, done: true, error: errData.error });
           return;
        }
        
        // Respon sukses → tunggu event Socket.IO untuk update progres
        setResyncProgress({ message: '🚀 Perintah diterima server! Menggali riwayat... (bisa memakan 1-5 menit untuk chat lama)', done: false });
    } catch (err: any) {
        setIsResyncing(false);
        setResyncProgress({ message: `❌ Error: ${err.message}`, done: true, error: err.message });
    }
  };


  const handleDeleteChat = async () => {
    const confirmAsk = window.confirm("PERINGATAN KERAS! Anda yakin akan menghapus permanen riwayat pelanggan ini?\n\n- Seluruh Folder File di VPS akan dihapus bersih.\n- Seluruh riwayat DB (customer, pesan, foto) tuntas dilebur.\nLanjutkan?");
    if (!confirmAsk) return;
    
    setIsDeleting(true);
    try {
        const res = await fetch(`${WA_API_URL}/api/wa/delete-chats`, {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ customer_ids: [customerId] })
        });

        if (!res.ok) throw new Error("API Menolak Permintaan Hapus");
        
        alert("Pemusnahan Berhasil! Mengembalikan Anda ke Halaman Utama...");
        router.push('/dashboard');
    } catch (err: any) {
        alert("Gagal menghapus data. Detail: " + err.message);
        setIsDeleting(false);
    }
  };

  // ─── FITUR BARU: Scan AI Vision ───────────────────────────────────
  const handleScanAI = async () => {
    if (selectedMedia.size === 0) {
        setScanResult({ type: 'error', message: 'Pilih minimal 1 gambar untuk di-scan.' });
        return;
    }
    if (selectedMedia.size > 1) {
        setScanResult({ type: 'error', message: 'Pilih hanya 1 gambar untuk di-scan agar hasil lebih akurat.' });
        return;
    }

    const mediaId = Array.from(selectedMedia)[0];
    setIsScanning(true);
    setScanResult(null);

    try {
        const res = await fetch(`${WA_API_URL}/api/media/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ media_id: mediaId, customer_id: customerId })
        });

        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || 'Gagal memindai gambar.');
        }

        if (data.found) {
            setOrderIdInput(data.order_id);
            setCustomer((prev: any) => ({ ...prev, order_id: data.order_id }));
            setMediaList(prev => prev.map(m => m.id === mediaId ? {
                ...m,
                excluded_from_production: true,
                media_kind: 'order_proof',
                detected_order_id: data.order_id,
                classification_status: 'ORDER_ID_FOUND'
            } : m));
            setScanResult({ type: 'success', message: `✅ Nomor pesanan ditemukan: ${data.order_id}` });
        } else {
            setScanResult({ type: 'not_found', message: '⚠️ Nomor pesanan (18 digit) tidak ditemukan di gambar ini. Coba pilih gambar lain.' });
        }
    } catch (err: any) {
        setScanResult({ type: 'error', message: `❌ Error: ${err.message}` });
    } finally {
        setIsScanning(false);
    }
  };

  // ─── FITUR BARU: Hapus Media Terpilih ─────────────────────────────
  const handleDeleteMedia = async () => {
    if (selectedMedia.size === 0) return;

    const confirmAsk = window.confirm(`Anda akan menghapus ${selectedMedia.size} foto secara permanen dari server. File tidak bisa dikembalikan. Lanjutkan?`);
    if (!confirmAsk) return;

    setIsDeletingMedia(true);
    try {
        const res = await fetch(`${WA_API_URL}/api/media/delete-bulk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                media_ids: Array.from(selectedMedia), 
                customer_id: customerId 
            })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Gagal menghapus media.');

        // Bersihkan seleksi & refresh data
        setSelectedMedia(new Set());
        setScanResult({ type: 'success', message: `✅ ${data.deleted} foto berhasil dihapus dari server.` });
    } catch (err: any) {
        setScanResult({ type: 'error', message: `❌ Gagal hapus: ${err.message}` });
    } finally {
        setIsDeletingMedia(false);
    }
  };

  // ─── FITUR BARU: Manual Push ke Google Drive ────────────────────
  const handleManualDriveSync = async () => {
    if (selectedMedia.size === 0) return;
    const productionIds = selectedProductionIds();
    if (productionIds.length === 0) {
        setScanResult({ type: 'error', message: 'Foto yang dipilih hanya bukti nomor pesanan, jadi tidak dikirim ke Google Drive.' });
        return;
    }

    setIsSyncingDrive(true);
    setScanResult(null);

    try {
        const res = await apiClient.post(`/customers/${customerId}/drive-sync`, { 
            mediaIds: productionIds
        });

        // apiClient otomatis throw error jika res.data tidak ada atau HTTP error
        const data = res.data;

        setSelectedMedia(new Set()); // Kosongkan seleksi
        
        let msg = `✅ Berhasil memasukkan ${data.pushed} foto ke antrean Google Drive!`;
        if (data.skipped > 0) {
            msg += ` (Sistem melewati ${data.skipped} foto karena sudah ada di Drive).`;
        }
        setScanResult({ type: 'success', message: msg });
    } catch (err: any) {
        const errMsg = err.response?.data?.error || err.message;
        setScanResult({ type: 'error', message: `❌ ${errMsg}` });
    } finally {
        setIsSyncingDrive(false);
    }
  };

  const toggleMediaSelect = (id: string) => {
    const next = new Set(selectedMedia);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedMedia(next);
  };

  const selectAllMedia = () => {
    const productionIds = mediaList.filter(isProductionMedia).map(m => m.id);
    if (selectedMedia.size === productionIds.length && productionIds.every(id => selectedMedia.has(id))) {
      setSelectedMedia(new Set());
    } else {
      setSelectedMedia(new Set(productionIds));
    }
  };

  const processZipDownload = async () => {
    if (!customer?.order_id) {
       const confirmLanjut = window.confirm("Nomor Order / Resi belum diisi. Nama file ZIP akan menggunakan Nomor HP. Tetap lanjut download?");
       if (!confirmLanjut) return;
    }
    
    const token = localStorage.getItem('access_token');
    if (!token) return alert('Sesi berakhir, silakan login ulang');

    const productionIds = selectedProductionIds();
    const defaultProductionCount = mediaList.filter(isProductionMedia).length;
    const targetCount = selectedMedia.size > 0 ? productionIds.length : defaultProductionCount;
    if (targetCount === 0) {
       alert('Tidak ada foto produksi untuk di-download. Foto nomor pesanan otomatis dikecualikan.');
       return;
    }
    const mediaParam = selectedMedia.size > 0 ? `&mediaIds=${productionIds.join(',')}` : '';
    const downloadUrl = `${WA_API_URL}/api/local/customers/${customerId}/fast-zip?token=${token}${mediaParam}`;
    window.location.href = downloadUrl;
  };


    try {
        const orderName = customer?.order_id ? customer.order_id.trim() : customer?.phone_number;
        const mediaParam = selectedMedia.size > 0 ? `?mediaIds=${productionIds.join(',')}` : '';
        
        // [FIX] Tidak pakai AbortSignal.timeout — ZIP 400 foto bisa makan 2-3 menit
        // keepalive: true agar koneksi tidak putus saat tab di-background
        const response = await fetch(`${WA_API_URL}/api/local/customers/${customerId}/fast-zip${mediaParam}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`
            },
            keepalive: true,
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || `Server error HTTP ${response.status}`);
        }

        const blob = await response.blob();
        if (blob.size < 100) throw new Error('ZIP kosong — kemungkinan tidak ada foto yang berhasil dipack');
        
        saveAs(blob, `${orderName}.zip`);

    } catch (error: any) {
        console.error('[ZIP]', error);
        alert(`Gagal membuat ZIP: ${error.message}\n\nTips: Coba Download Zip lagi — jika masih gagal, kurangi jumlah foto yang dipilih.`);
    } finally {
        setLoadingMedia(false);
    }
  };



  const sendQuickReply = async (templateText?: string) => {
    const textToSend = templateText || replyText;
    if (!textToSend.trim()) return;
    
    setIsSending(true);
    try {
       const res = await fetch(`${WA_API_URL}/api/wa/send`, {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ 
               phone_number: customer.phone_number, 
               message: textToSend,
               customer_id: customer.id
           })
       });
       
       if (!res.ok) {
           const errData = await res.json().catch(() => ({}));
           throw new Error(errData.error || `HTTP Error ${res.status}`);
       }
       
       setReplyText("");
    } catch(err: any) {
       console.error("Fetch Error:", err);
       alert(`Gagal membalas pesan. Detail: ${err.message}`);
    } finally {
       setIsSending(false);
    }
  };

  if (!customer) return <div className="p-8 font-medium animate-pulse text-indigo-500">Memuat detail ruang obrolan...</div>;

  return (
    <div className="h-screen flex flex-col pt-4">
      {/* Header */}
      <div className="px-6 py-4 flex items-center justify-between border-b bg-white shrink-0 shadow-sm z-10">
        <div className="flex items-center space-x-4">
          <Link href="/dashboard" className="p-2 hover:bg-gray-100 rounded-full transition text-gray-500 hover:text-gray-900">
            <ArrowLeft />
          </Link>
          <div>
            <h2 className="text-xl font-bold font-mono text-gray-900">{customer.phone_number}</h2>
            <div className="flex items-center mt-1">
               <span className="w-2 h-2 rounded-full bg-green-500 mr-2"></span>
               <p className="text-xs text-gray-500 font-bold uppercase tracking-wider">{customer.status.replace(/_/g, ' ')}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* === 1. PANEL CHAT === */}
        <div className="w-1/3 flex flex-col border-r bg-gray-50/50">
          <div className="p-4 bg-white border-b font-bold text-gray-800 flex items-center space-x-2 shadow-sm z-10">
            <MessageSquare size={18} className="text-indigo-600" />
            <span>Riwayat & Balas Chat</span>
          </div>
          
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.map(msg => (
              <div key={msg.id} className={clsx(
                "p-3 max-w-[85%] rounded-2xl text-sm shadow-sm leading-relaxed transition-all duration-300",
                msg.is_deleted ? "bg-gray-100 text-gray-500 italic opacity-80 border border-gray-200" :
                (msg.is_from_me ? "bg-indigo-600 text-white" : "bg-white text-gray-800 border"),
                msg.is_from_me ? "ml-auto rounded-tr-sm" : "mr-auto rounded-tl-sm"
              )}>
                {msg.is_deleted ? "🚫 Pesan ini telah dihapus oleh pengirim." : msg.body}
              </div>
            ))}
          </div>

          <div className="p-4 bg-white border-t space-y-3">
             <div className="flex space-x-2 overflow-x-auto pb-2 scrollbar-hide">
                 <button onClick={() => sendQuickReply("Halo kak, untuk orderan ini jumlah fotonya masih kurang 10 ya.")} className="whitespace-nowrap px-3 py-1.5 bg-gray-100 text-gray-700 text-xs font-medium rounded-full hover:bg-gray-200 transition border">Kurang foto</button>
                 <button onClick={() => sendQuickReply("Foto telah kami rekap dan siap dicetak! Estimasi pengerjaan 1-2 hari.")} className="whitespace-nowrap px-3 py-1.5 bg-gray-100 text-gray-700 text-xs font-medium rounded-full hover:bg-gray-200 transition border">Siap Cetak</button>
             </div>
             <div className="flex relative items-center">
                 <input 
                    type="text" 
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && sendQuickReply()}
                    placeholder="Ketik balasan..."
                    className="w-full pl-4 pr-12 py-3 border border-gray-300 rounded-xl focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                 />
                 <button 
                    disabled={isSending || !replyText.trim()}
                    onClick={() => sendQuickReply()}
                    className="absolute right-2 p-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:bg-gray-300 transition"
                 >
                    <Send size={16} />
                 </button>
             </div>
          </div>
        </div>

        {/* === 2. PANEL MEDIA === */}
        <div className="w-1/3 flex flex-col bg-gray-100/30">
          <div className="p-4 bg-white border-b flex items-center justify-between shadow-sm z-10">
             <div className="font-bold text-gray-800 flex items-center space-x-2">
              <ImageIcon size={18} className="text-blue-600" />
              <span>Media ({mediaList.filter(isProductionMedia).length}/{mediaList.length})</span>
            </div>
            <button onClick={selectAllMedia} className="text-xs text-blue-600 font-bold uppercase tracking-wider hover:text-blue-800 transition">
              {selectedMedia.size > 0 && selectedProductionIds().length === mediaList.filter(isProductionMedia).length ? 'Deselect All' : 'Select All'}
            </button>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4 relative">
             {/* Notifikasi Hasil Scan (Toast) */}
             {scanResult && (
               <div className={clsx(
                 "mb-4 p-3 rounded-xl text-xs font-bold border animate-in fade-in slide-in-from-top-2 duration-300",
                 scanResult.type === 'success' && "bg-green-50 text-green-800 border-green-200",
                 scanResult.type === 'error' && "bg-red-50 text-red-800 border-red-200",
                 scanResult.type === 'not_found' && "bg-amber-50 text-amber-800 border-amber-200"
               )}>
                 {scanResult.message}
               </div>
             )}

             <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
               {mediaList.map(media => {
                 const isSelected = selectedMedia.has(media.id);
                 const isExcluded = !isProductionMedia(media);
                 return (
                   <div 
                     key={media.id} 
                     onClick={() => toggleMediaSelect(media.id)}
                     className={clsx(
                       "aspect-square relative rounded-xl border-[3px] overflow-hidden cursor-pointer group bg-gray-200 shadow-sm",
                       isSelected ? "border-indigo-500 shadow-md ring-4 ring-indigo-50 border-white" : "border-transparent"
                     )}
                   >
                     {/* eslint-disable-next-line @next/next/no-img-element */}
                     <img src={media.file_url} className="w-full h-full object-cover transition transform duration-300 group-hover:scale-110" alt="Order file" loading="lazy" />
                     {isExcluded && (
                       <div className="absolute inset-x-2 bottom-2 z-10 rounded-lg bg-amber-50/95 border border-amber-200 px-2 py-1 text-[10px] font-black text-amber-800 text-center shadow-sm">
                         Nomor Pesanan
                       </div>
                     )}
                     
                     {/* Indikator Status Drive */}
                     {driveStatus[media.id] && (
                       <div className="absolute top-2 left-2 z-10 flex items-center justify-center p-1.5 rounded-full bg-white/90 shadow-md backdrop-blur-sm border border-gray-100">
                          {driveStatus[media.id] === 'DONE' && <CheckCircle size={14} className="text-green-500" />}
                          {driveStatus[media.id] === 'UPLOADING' && <Cloud size={14} className="text-blue-500 animate-pulse" />}
                          {(driveStatus[media.id] === 'PENDING' || driveStatus[media.id] === 'WAITING_RESI') && <span className="text-xs">⏳</span>}
                          {driveStatus[media.id] === 'FAILED' && <span className="text-xs">❌</span>}
                          {driveStatus[media.id] === 'SKIPPED' && <span className="text-xs">⏭️</span>}
                       </div>
                     )}

                     {isSelected && (
                       <div className="absolute top-2 right-2 z-10 bg-indigo-500 text-white rounded-full p-1 shadow-lg ring-2 ring-white">
                         <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7"></path></svg>
                       </div>
                     )}
                   </div>
                 );
               })}
             </div>
             {mediaList.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center -mt-20">
                   <div className="text-center text-gray-400">
                      <ImageIcon size={48} className="mx-auto mb-3 opacity-20" />
                      <p className="text-sm font-medium">Belum ada foto yang masuk</p>
                   </div>
                </div>
             )}
          </div>
          
          {/* Footer Media: Download + Scan AI + Hapus */}
          <div className="p-4 border-t bg-white space-y-3 shadow-sm z-10">
             <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-gray-600 px-3 py-1 bg-gray-100 rounded-lg">{selectedProductionIds().length}/{selectedMedia.size} Produksi</span>
                <button 
                   onClick={processZipDownload}
                   disabled={loadingMedia || selectedMedia.size === 0}
                   className="flex items-center space-x-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white px-5 py-2.5 rounded-xl text-sm font-bold transition shadow-md hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                >
                   {loadingMedia ? <span className="animate-pulse">Zipping File...</span> : <Download size={18} />}
                   {!loadingMedia && <span>Download Zip</span>}
                </button>
             </div>

             {/* Baris Aksi: Scan AI + Hapus */}
             <div className="flex gap-2">
                <button 
                   onClick={handleScanAI}
                   disabled={isScanning || selectedMedia.size === 0}
                   className="flex-1 flex items-center justify-center space-x-2 bg-violet-600 hover:bg-violet-700 disabled:bg-gray-300 text-white px-4 py-2.5 rounded-xl text-xs font-bold transition shadow-sm"
                >
                   {isScanning ? (
                     <span className="w-4 h-4 border-2 border-white border-t-violet-300 rounded-full animate-spin"></span>
                   ) : (
                     <ScanSearch size={16} />
                   )}
                   <span>{isScanning ? 'Memindai...' : 'Scan ID (AI)'}</span>
                </button>
                <button 
                   onClick={handleDeleteMedia}
                   disabled={isDeletingMedia || selectedMedia.size === 0}
                   className="flex items-center justify-center space-x-2 bg-red-50 hover:bg-red-600 text-red-600 hover:text-white border border-red-200 hover:border-red-600 disabled:bg-gray-100 disabled:text-gray-400 disabled:border-gray-200 px-4 py-2.5 rounded-xl text-xs font-bold transition shadow-sm"
                >
                   {isDeletingMedia ? (
                     <span className="w-4 h-4 border-2 border-red-400 border-t-red-200 rounded-full animate-spin"></span>
                   ) : (
                     <Trash2 size={16} />
                   )}
                   <span>{isDeletingMedia ? 'Menghapus...' : 'Hapus'}</span>
                </button>
             </div>

             {/* Baris Aksi 2: Upload Drive Manual */}
             <div className="flex gap-2">
                <button 
                   onClick={handleManualDriveSync}
                   disabled={isSyncingDrive || selectedMedia.size === 0}
                   className="flex-1 flex items-center justify-center space-x-2 bg-green-500 hover:bg-green-600 disabled:bg-gray-300 text-white px-4 py-2.5 rounded-xl text-xs font-bold transition shadow-sm"
                >
                   {isSyncingDrive ? (
                     <span className="w-4 h-4 border-2 border-white border-t-green-300 rounded-full animate-spin"></span>
                   ) : (
                     <Cloud size={16} />
                   )}
                   <span>{isSyncingDrive ? 'Mengantre...' : 'Antar ke Drive'}</span>
                </button>
             </div>

             <p className="text-[10px] text-gray-400 text-center font-medium leading-tight">
               Scan AI: Pilih 1 screenshot → ekstra nomor pesanan otomatis. Hapus: Bersihkan foto yang tidak perlu.
             </p>
          </div>
        </div>

        {/* === 3. PANEL VALIDASI === */}
        <div className="w-1/3 border-l bg-white p-8 flex flex-col z-10 shadow-[-4px_0_15px_-3px_rgba(0,0,0,0.05)]">
           <h3 className="text-lg font-bold text-gray-900 mb-8 border-b pb-4">📝 Pendataan & Validasi</h3>
           
           <div className="space-y-6 flex-1">
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Nama Pelanggan / ID Tiktok</label>
                <input 
                  type="text" 
                  value={nameInput} 
                  onChange={e => setNameInput(e.target.value)}
                  className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm focus:border-indigo-500 focus:ring-0 outline-none transition bg-gray-50 focus:bg-white font-medium"
                  placeholder="Contoh: @sisca.polaroid" 
                />
              </div>
              
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Nomor Order / Resi</label>
                <input 
                  type="text" 
                  value={orderIdInput} 
                  onChange={e => setOrderIdInput(e.target.value)}
                  className={clsx(
                    "w-full border-2 rounded-xl px-4 py-3 text-sm focus:ring-0 outline-none transition font-medium font-mono",
                    orderIdInput ? "border-green-300 bg-green-50/50 focus:border-green-500 text-green-800" : "border-gray-200 bg-gray-50 focus:bg-white focus:border-indigo-500"
                  )}
                  placeholder="Contoh: 241216123456789012" 
                />
                {orderIdInput && (
                  <p className="text-[10px] font-bold text-green-600 mt-1.5 flex items-center">
                    <CheckCircle size={10} className="mr-1" /> Nomor pesanan terisi
                  </p>
                )}
              </div>

              <button 
                onClick={handleUpdateCustomer}
                className="w-full bg-white border-2 border-gray-200 text-gray-700 font-bold py-3 rounded-xl text-sm hover:border-gray-300 hover:bg-gray-50 transition"
              >
                Simpan Variabel Profile
              </button>
           </div>
           
           <div className="mt-8 bg-gray-50 p-6 rounded-2xl border border-gray-100">
             <button 
                onClick={handleValidate}
                disabled={customer.status === 'VALIDATED'}
                className={clsx(
                  "w-full flex items-center justify-center space-x-2 py-3 lg:py-4 rounded-xl text-sm font-bold transition shadow-sm",
                  customer.status === 'VALIDATED' ? "bg-green-100 text-green-700 border-2 border-green-200 shadow-none" : "bg-green-600 hover:bg-green-700 hover:shadow-lg focus:ring-4 focus:ring-green-500/30 text-white"
                )}
             >
               <CheckCircle size={20} />
               <span>{customer.status === 'VALIDATED' ? 'TERVALIDASI' : 'SELESAIKAN & VALIDASI'}</span>
             </button>
             <p className="text-xs text-gray-500 text-center mt-4 leading-relaxed font-medium">
                Tandai sebagai Validated hanya jika media foto sudah didownload ke komputer dan telah sinkron dengan Order ID sistem Anda.
             </p>

             {/* FITUR GALI ULANG & HAPUS */}
             <div className="mt-6 pt-6 border-t border-gray-200 space-y-3">
                 <button 
                    onClick={handleResync}
                    disabled={isResyncing || isDeleting}
                    className="w-full flex items-center justify-center space-x-2 py-3 rounded-xl text-sm font-bold bg-amber-100/50 text-amber-700 hover:bg-amber-100 focus:ring-4 focus:ring-amber-500/30 transition shadow-sm border border-amber-300 disabled:opacity-60"
                 >
                   <svg className={clsx("w-5 h-5 shrink-0", isResyncing && "animate-spin")} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                   <span>{isResyncing ? 'Menggali Ulang... Mohon Tunggu' : 'Gali Ulang Riwayat WA'}</span>
                 </button>

                 {/* [UPGRADE] Banner Progress Real-Time Gali Ulang */}
                 {resyncProgress && (
                   <div className={clsx(
                     "p-3 rounded-xl text-xs font-medium border leading-relaxed transition-all duration-300",
                     resyncProgress.error
                       ? "bg-red-50 text-red-700 border-red-200"
                       : resyncProgress.done
                         ? "bg-green-50 text-green-800 border-green-200"
                         : "bg-blue-50 text-blue-800 border-blue-200"
                   )}>
                     <div className="flex items-start space-x-2">
                       {!resyncProgress.done && !resyncProgress.error && (
                         <span className="mt-0.5 w-3 h-3 shrink-0 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                       )}
                       <span>{resyncProgress.message}</span>
                     </div>
                     {resyncProgress.done && !resyncProgress.error && resyncProgress.totalMedia !== undefined && (
                       <div className="mt-2 flex gap-3">
                         <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded-full font-bold">📨 {resyncProgress.totalMessages} pesan</span>
                         <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full font-bold">🖼️ {resyncProgress.totalMedia} foto</span>
                       </div>
                     )}
                   </div>
                 )}
                 
                 <button 
                    onClick={handleDeleteChat}
                    disabled={isDeleting}
                    className="w-full flex items-center justify-center space-x-2 py-3 rounded-xl text-sm font-bold bg-red-50 text-red-600 border border-red-200 hover:bg-red-600 hover:border-red-600 hover:text-white transition shadow-sm"
                 >
                   <span>{isDeleting ? 'MEMUSNAHKAN DATA...' : 'Hapus Permanen Riwayat Ini'}</span>
                 </button>
                 <p className="text-[10px] text-gray-400 text-center font-medium leading-tight px-2">Gali ulang untuk menarik foto lawas. Hapus Permanen jika ini adalah chat Spam.</p>
             </div>
           </div>
        </div>
      </div>
    </div>
  );
}
