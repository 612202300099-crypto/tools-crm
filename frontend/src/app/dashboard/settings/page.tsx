"use client";

import { useEffect, useState } from "react";
import { QrCode, Smartphone, RefreshCw, CheckCircle } from "lucide-react";
import QRCode from "react-qr-code";

export default function Settings() {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // Poll status every 3 seconds
  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, []);

  const fetchStatus = async () => {
    try {
      let waUrl = process.env.NEXT_PUBLIC_WA_ENGINE_URL;
      if (!waUrl) waUrl = `http://${window.location.hostname}:3001`;
      
      const res = await fetch(`${waUrl}/api/wa/status`);
      const data = await res.json();
      setStatus(data);
    } catch (error) {
      console.error("WA Engine unreachable");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-8 max-w-4xl max-h-screen">
      <h1 className="text-2xl font-bold mb-6 text-gray-800">Koneksi WhatsApp Engine</h1>
      
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 flex flex-col md:flex-row items-start space-y-6 md:space-y-0 md:space-x-8">
         <div className="flex-1 space-y-4">
            <h2 className="text-lg font-bold text-gray-800 flex items-center"><Smartphone className="mr-2 text-indigo-600" /> Status Perangkat</h2>
            {loading ? (
               <p className="text-gray-500">Memeriksa koneksi...</p>
            ) : status?.connected ? (
               <div className="p-4 bg-green-50 border border-green-200 rounded-lg flex space-x-3 items-center">
                 <CheckCircle className="text-green-600" />
                 <div>
                    <h3 className="font-bold text-green-900">WhatsApp Terhubung</h3>
                    <p className="text-sm text-green-700 mt-1">Chat bot sudah aktif dan dapat mengelola permintaan foto polaroid pelanggan.</p>
                 </div>
               </div>
            ) : (
               <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                 <h3 className="font-bold text-yellow-900">Menunggu Koneksi QR Code</h3>
                 <p className="text-sm text-yellow-800 mt-1">Gunakan perangkat Whatsapp operasional Anda untuk menscan QR code yang ada di panel kanan.</p>
               </div>
            )}
            
            <div className="mt-8 text-sm text-gray-500 bg-gray-50 p-4 rounded-lg">
               <span className="block font-bold mb-2">Instruksi:</span>
               <ol className="list-decimal pl-4 space-y-1">
                 <li>Buka WhatsApp di HP operasional.</li>
                 <li>Klik ikon 3 titik di kanan atas (Android) atau menu Settings (iOS).</li>
                 <li>Pilih Perangkat Tertaut (Linked Devices).</li>
                 <li>Arahkan kamera ke QR Code di layar.</li>
               </ol>
            </div>
         </div>

         <div className="w-80 bg-gray-50 border p-6 rounded-xl flex flex-col justify-center items-center">
            {status?.qr && !status?.connected ? (
              <>
                 <QRCode value={status.qr} size={200} className="rounded-lg mb-4" />
                 <p className="text-xs text-gray-400 text-center uppercase tracking-wider font-bold">Pindai dengan WA Anda</p>
              </>
            ) : status?.connected ? (
                 <div className="text-center py-10 space-y-3 flex flex-col items-center">
                    <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center">
                       <CheckCircle size={40} className="text-green-600" />
                    </div>
                    <span className="text-sm font-bold text-gray-700 relative">Tersambung</span>
                 </div>
            ) : (
                 <div className="text-center py-10 space-y-3 flex flex-col items-center">
                    <RefreshCw className="animate-spin text-gray-400" />
                    <span className="text-sm text-gray-500">Memuat info sesi...</span>
                 </div>
            )}
         </div>
      </div>
    </div>
  );
}
