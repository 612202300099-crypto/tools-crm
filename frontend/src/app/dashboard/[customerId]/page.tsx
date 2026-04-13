"use client";

import { useEffect, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import JSZip from "jszip";
import { saveAs } from "file-saver";
import { ArrowLeft, Download, CheckCircle, Image as ImageIcon, MessageSquare, Send } from "lucide-react";
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
};

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

  useEffect(() => {
    fetchData();

    const channel = supabase
      .channel(`chat_${customerId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `customer_id=eq.${customerId}` }, payload => {
         if (payload.eventType === 'INSERT') {
             setMessages(prev => [...prev, payload.new as Message]);
         } else if (payload.eventType === 'UPDATE') {
             const updated = payload.new as Message;
             setMessages(prev => prev.map(m => m.id === updated.id ? updated : m));
         } else if (payload.eventType === 'DELETE') {
             setMessages(prev => prev.filter(m => m.id !== payload.old.id));
         }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'media', filter: `customer_id=eq.${customerId}` }, payload => {
         // Susun media baru di paling atas karena urutan tabel media adalah descending
         if (payload.eventType === 'INSERT') {
             setMediaList(prev => [payload.new as Media, ...prev]);
         } else if (payload.eventType === 'DELETE') {
             setMediaList(prev => prev.filter(m => m.id !== payload.old.id));
         }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [customerId]);

  useEffect(() => {
    // Auto scroll chat ke paling bawah
    if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const fetchData = async () => {
    const { data: cData } = await supabase.from('customers').select('*').eq('id', customerId).single();
    if (cData) {
      setCustomer(cData);
      setNameInput(cData.name || "");
      setOrderIdInput(cData.order_id || "");
    }

    const { data: mData } = await supabase.from('messages').select('*').eq('customer_id', customerId).order('created_at', { ascending: true });
    if (mData) setMessages(mData);

    const { data: mediaData } = await supabase.from('media').select('*').eq('customer_id', customerId).order('created_at', { ascending: false });
    if (mediaData) setMediaList(mediaData);
  };

  const handleUpdateCustomer = async () => {
    const changes = { name: nameInput, order_id: orderIdInput };
    await supabase.from('customers').update(changes).eq('id', customerId);
    setCustomer({ ...customer, ...changes });
    alert("Data Profil Pelanggan berhasil disimpan!");
  };

  const handleValidate = async () => {
    const changes = { status: 'VALIDATED', is_valid: true };
    await supabase.from('customers').update(changes).eq('id', customerId);
    setCustomer({ ...customer, ...changes });
    alert("Proses Selesai: Customer ditandai VALID.");
  };

  const handleResync = async () => {
    const confirmAsk = window.confirm("PERINGATAN: Ini akan menghapus seluruh rekaman chat dan foto pelanggan ini di Web, lalu mencoba menarik kembali 1.000 pesan terakhirnya secara utuh dari WhatsApp HP Anda. Lanjutkan?");
    if (!confirmAsk) return;
    
    setIsResyncing(true);
    try {
        const waUrl = "https://api-wa.parecustom.com";
        const res = await fetch(`${waUrl}/api/wa/resync`, {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ 
               phone_number: customer.phone_number, 
               customer_id: customer.id
           })
        });

        if (!res.ok) {
           const errData = await res.json().catch(() => ({}));
           throw new Error(errData.error || `HTTP Error ${res.status}`);
        }
        
        alert("Gali Ulang SUKSES! Halaman ini akan disegarkan ulang otomatis untuk menampilkan foto murni dari WA.");
        // Bersihkan state media
        setMessages([]);
        setMediaList([]);
        fetchData();
    } catch (err: any) {
        alert("Gagal melakukan Gali Ulang. Detail: " + err.message);
    } finally {
        setIsResyncing(false);
    }
  };

  const toggleMediaSelect = (id: string) => {
    const next = new Set(selectedMedia);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedMedia(next);
  };

  const selectAllMedia = () => {
    if (selectedMedia.size === mediaList.length) setSelectedMedia(new Set()); 
    else setSelectedMedia(new Set(mediaList.map(m => m.id))); 
  };

  const processZipDownload = async () => {
    if (selectedMedia.size === 0) return alert("Pilih minimal 1 foto dengan mengklik gambar");
    if (!customer?.order_id) {
       const confirmLanjut = window.confirm("Nomor Order / Resi belum diisi. Nama file ZIP akan menggunakan Nomor HP. Tetap lanjut download?");
       if (!confirmLanjut) return;
    }
    
    setLoadingMedia(true);
    
    try {
      const selectedItems = mediaList.filter(m => selectedMedia.has(m.id));
      const orderName = customer?.order_id ? customer.order_id.trim() : customer?.phone_number;

      const zip = new JSZip();
      let count = 0;
      
      for (const item of selectedItems) {
        const res = await fetch(item.file_url);
        const blob = await res.blob();
        const ext = item.file_url.split('.').pop() || 'jpg';
        zip.file(`foto_${++count}.${ext}`, blob);
      }

      // Generate file zip ke browser
      const zipBlob = await zip.generateAsync({ type: "blob" });
      const zipFileName = `${orderName}.zip`;
      
      saveAs(zipBlob, zipFileName);
      
    } catch (error) {
      console.error(error);
      alert("Gagal mendownload dan memproses file ZIP. Pastikan gambar di Supabase Storage dapat diakses secara publik.");
    } finally {
      setLoadingMedia(false);
    }
  };

  const sendQuickReply = async (templateText?: string) => {
    const textToSend = templateText || replyText;
    if (!textToSend.trim()) return;
    
    setIsSending(true);
    try {
       // KOREKSI DARURAT: Kita tembak langsung ke HTTPS aslinya tanpa melewati Env Variable Vercel
       // karena "Failed to fetch" 90% mengindikasikan Vercel kehilangan jejak URL API-nya.
       const waUrl = "https://api-wa.parecustom.com";
       
       console.log("Mencoba fetch ke URL:", `${waUrl}/api/wa/send`);
       
       const res = await fetch(`${waUrl}/api/wa/send`, {
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
              <span>Media ({mediaList.length})</span>
            </div>
            <button onClick={selectAllMedia} className="text-xs text-blue-600 font-bold uppercase tracking-wider hover:text-blue-800 transition">
              {selectedMedia.size === mediaList.length && mediaList.length > 0 ? 'Deselect All' : 'Select All'}
            </button>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4 relative">
             <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
               {mediaList.map(media => {
                 const isSelected = selectedMedia.has(media.id);
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
                     {isSelected && (
                       <div className="absolute top-2 right-2 bg-indigo-500 text-white rounded-full p-1 shadow-lg ring-2 ring-white">
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
          
          <div className="p-4 border-t bg-white flex items-center justify-between shadow-sm z-10">
             <span className="text-sm font-bold text-gray-600 px-3 py-1 bg-gray-100 rounded-lg">{selectedMedia.size} Terpilih</span>
             <button 
                onClick={processZipDownload}
                disabled={loadingMedia || selectedMedia.size === 0}
                className="flex items-center space-x-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white px-5 py-2.5 rounded-xl text-sm font-bold transition shadow-md hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
             >
                {loadingMedia ? <span className="animate-pulse">Zipping File...</span> : <Download size={18} />}
                {!loadingMedia && <span>Download Data Zip</span>}
             </button>
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
                  className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm focus:border-indigo-500 focus:ring-0 outline-none transition bg-gray-50 focus:bg-white font-medium font-mono"
                  placeholder="Contoh: ORD-1002345" 
                />
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

             {/* FITUR GALI ULANG */}
             <div className="mt-6 pt-6 border-t border-gray-200">
                 <button 
                    onClick={handleResync}
                    disabled={isResyncing}
                    className="w-full flex items-center justify-center space-x-2 py-3 rounded-xl text-sm font-bold bg-amber-100/50 text-amber-700 hover:bg-amber-100 focus:ring-4 focus:ring-amber-500/30 transition shadow-sm border border-amber-300"
                 >
                   <svg className={clsx("w-5 h-5", isResyncing && "animate-spin")} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                   <span>{isResyncing ? 'Menggali Ulang Database...' : 'Gali Ulang Riwayat WA'}</span>
                 </button>
                 <p className="text-[10px] text-amber-600/70 text-center mt-2 font-medium leading-tight">Gunakan fitur ini jika ada foto masa lalu yang hilang/gagal ditarik.</p>
             </div>
           </div>
        </div>
      </div>
    </div>
  );
}
