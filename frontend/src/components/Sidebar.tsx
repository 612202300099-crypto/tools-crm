"use client";

import Link from 'next/link';
import { MessageSquare, Settings, LogOut, Bot } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter, usePathname } from 'next/navigation';

export default function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push('/login');
  };

  const navItem = (href: string, icon: React.ReactNode, label: string) => {
    const isActive = pathname === href;
    return (
      <Link
        href={href}
        className={`flex items-center space-x-3 p-3 rounded-lg transition ${
          isActive
            ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-900/40'
            : 'hover:bg-gray-800 text-gray-300 hover:text-white'
        }`}
      >
        {icon}
        <span>{label}</span>
      </Link>
    );
  };

  return (
    <div className="w-64 bg-gray-900 text-white min-h-screen p-4 flex flex-col">
      <div className="text-2xl font-bold mb-8 text-center border-b border-gray-700 pb-4">
        Polaroid CRM
      </div>
      
      <nav className="flex-1 space-y-1.5">
        {navItem('/dashboard', <MessageSquare size={20} />, 'Inbox WhatsApp')}
        {navItem('/dashboard/ai-config', <Bot size={20} />, 'AI Follow-Up Bot')}
        {navItem('/dashboard/settings', <Settings size={20} />, 'Koneksi WA Engine')}
      </nav>
      
      <div className="pt-4 border-t border-gray-700 mt-auto">
        <button
          onClick={handleLogout}
          className="flex items-center space-x-3 p-3 rounded-lg hover:bg-red-600 transition w-full text-left text-gray-300 hover:text-white"
        >
          <LogOut size={20} />
          <span>Logout</span>
        </button>
      </div>
    </div>
  );
}

