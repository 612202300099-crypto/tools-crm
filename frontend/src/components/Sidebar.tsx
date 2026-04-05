"use client";

import Link from 'next/link';
import { LayoutDashboard, Users, MessageSquare, Settings, LogOut } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';

export default function Sidebar() {
  const router = useRouter();

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push('/login');
  };

  return (
    <div className="w-64 bg-gray-900 text-white min-h-screen p-4 flex flex-col">
      <div className="text-2xl font-bold mb-8 text-center border-b border-gray-700 pb-4">
        Polaroid CRM
      </div>
      
      <nav className="flex-1 space-y-2">
        <Link href="/dashboard" className="flex items-center space-x-3 p-3 rounded-lg hover:bg-gray-800 transition">
          <MessageSquare size={20} />
          <span>Inbox Whatsapp</span>
        </Link>
        <Link href="/dashboard/settings" className="flex items-center space-x-3 p-3 rounded-lg hover:bg-gray-800 transition">
          <Settings size={20} />
          <span>Koneksi WA Engine</span>
        </Link>
      </nav>
      
      <div className="pt-4 border-t border-gray-700 mt-auto">
        <button onClick={handleLogout} className="flex items-center space-x-3 p-3 rounded-lg hover:bg-red-600 transition w-full text-left">
          <LogOut size={20} />
          <span>Logout</span>
        </button>
      </div>
    </div>
  );
}
