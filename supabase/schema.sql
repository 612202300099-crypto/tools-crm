    -- Supabase Database Schema for CRM WhatsApp Polaroid

    -- 1. Create a Bucket for Medias (requires Storage panel setup, but SQL logic provided below)
    -- Note: You should enable Public access for 'media' bucket in Supabase Dashboard.
    insert into storage.buckets (id, name, public) values ('media', 'media', true)
    on conflict do nothing;

    -- 2. Create CUSTOMERS table
    CREATE TABLE IF NOT EXISTS public.customers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone_number TEXT UNIQUE NOT NULL,
        name TEXT,
        order_id TEXT,
        status TEXT DEFAULT 'BELUM_KIRIM_FOTO', -- 'BELUM_KIRIM_FOTO', 'SUDAH_KIRIM_FOTO', 'VALIDATED'
        is_valid BOOLEAN DEFAULT false,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
    );

    -- 3. Create MESSAGES table
    CREATE TABLE IF NOT EXISTS public.messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id UUID REFERENCES public.customers(id) ON DELETE CASCADE,
        body TEXT,
        is_from_me BOOLEAN DEFAULT false,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
    );

    -- 4. Create MEDIA table
    CREATE TABLE IF NOT EXISTS public.media (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id UUID REFERENCES public.customers(id) ON DELETE CASCADE,
        message_id UUID REFERENCES public.messages(id) ON DELETE CASCADE,
        file_url TEXT NOT NULL,
        file_name TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
    );

    -- Realtime Setup for Dashboard Dashboard
    ALTER PUBLICATION supabase_realtime ADD TABLE public.customers;
    ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
    ALTER PUBLICATION supabase_realtime ADD TABLE public.media;
