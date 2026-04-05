"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import Link from "next/link";
import { format } from "date-fns";
import { Search, Filter } from "lucide-react";

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
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);

  // Filter & Search states
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState("ALL");

  useEffect(() => {
    fetchCustomers();
    
    // Subscribe to realtime changes
    const channel = supabase
      .channel('public:customers')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'customers' },
        () => {
          fetchCustomers();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const fetchCustomers = async () => {
    const { data } = await supabase
      .from("customers")
      .select("*")
      .order("created_at", { ascending: false });
      
    if (data) setCustomers(data);
    setLoading(false);
  };

  // Logika Pencarian & Filter
  const filteredCustomers = customers.filter(c => {
     // Search filter
     const q = searchQuery.toLowerCase();
     const matchesSearch = 
        c.phone_number.includes(q) || 
        (c.name && c.name.toLowerCase().includes(q)) || 
        (c.order_id && c.order_id.toLowerCase().includes(q));
     
     // Status filter
     const matchesStatus = filterStatus === "ALL" || c.status === filterStatus;

     return matchesSearch && matchesStatus;
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'BELUM_KIRIM_FOTO':
        return <span className="px-2 py-1 bg-yellow-100 text-yellow-800 text-xs font-medium rounded-full">Belum Kirim Foto</span>;
      case 'SUDAH_KIRIM_FOTO':
        return <span className="px-2 py-1 bg-blue-100 text-blue-800 text-xs font-medium rounded-full">Sudah Kirim Foto</span>;
      case 'VALIDATED':
        return <span className="px-2 py-1 bg-green-100 text-green-800 text-xs font-medium rounded-full">Divalidasi</span>;
      default:
        return <span className="px-2 py-1 bg-gray-100 text-gray-800 text-xs font-medium rounded-full">{status}</span>;
    }
  };

  return (
    <div className="p-8 h-full flex flex-col">
      <h1 className="text-2xl font-bold mb-6 text-gray-800">Inbox Pesanan WhatsApp</h1>
      
      {/* Fitur Pencarian & Filter */}
      <div className="flex flex-col md:flex-row gap-4 mb-6">
         <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={18} />
            <input 
              type="text" 
              placeholder="Cari nama, nomor WA, atau Order ID..." 
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
            />
         </div>
         <div className="relative w-full md:w-64">
            <Filter className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={18} />
            <select 
               value={filterStatus}
               onChange={e => setFilterStatus(e.target.value)}
               className="w-full pl-10 pr-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white appearance-none cursor-pointer"
            >
               <option value="ALL">Semua Status</option>
               <option value="BELUM_KIRIM_FOTO">Belum Kirim Foto</option>
               <option value="SUDAH_KIRIM_FOTO">Sudah Kirim Foto</option>
               <option value="VALIDATED">Divalidasi / Selesai</option>
            </select>
         </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden flex-1 flex flex-col">
        <div className="overflow-y-auto w-full">
          <table className="w-full text-left border-collapse">
            <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
              <tr>
                <th className="p-4 font-semibold text-gray-600">Pelanggan</th>
                <th className="p-4 font-semibold text-gray-600">Order ID</th>
                <th className="p-4 font-semibold text-gray-600">Status</th>
                <th className="p-4 font-semibold text-gray-600">Bergabung</th>
                <th className="p-4 font-semibold text-gray-600 w-32 text-center">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="p-10 text-center text-gray-500 animate-pulse">Memuat data real-time...</td></tr>
              ) : filteredCustomers.length === 0 ? (
                <tr><td colSpan={5} className="p-10 text-center text-gray-500">Tidak ada pelanggan yang cocok dengan filter / pencarian.</td></tr>
              ) : (
                filteredCustomers.map((c) => (
                  <tr key={c.id} className="border-b border-gray-100 hover:bg-gray-50 transition">
                    <td className="p-4">
                      <div className="font-bold text-gray-900">{c.name || 'NN'}</div>
                      <div className="text-sm text-gray-500 font-mono mt-1">{c.phone_number}</div>
                    </td>
                    <td className="p-4 font-medium text-gray-700">{c.order_id || '-'}</td>
                    <td className="p-4">{getStatusBadge(c.status)}</td>
                    <td className="p-4 text-gray-600 text-sm font-medium">
                      {format(new Date(c.created_at), 'dd MMM yy HH:mm')}
                    </td>
                    <td className="p-4 text-center">
                      <Link 
                        href={`/dashboard/${c.id}`}
                        className="inline-block bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 transition shadow-sm"
                      >
                        Buka Chat
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
