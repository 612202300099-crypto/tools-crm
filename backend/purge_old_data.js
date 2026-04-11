require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const isConfirm = process.argv.includes('--confirm');
// Cutoff Date (8 April 2026, 00:01 WIB -> 7 April 2026, 17:01 UTC)
const CUTOFF_DATE = '2026-04-07T17:01:00.000Z';

async function purgeLegacyData() {
    console.log(`\n========= THE GREAT PURGE =========`);
    console.log(`Filter: Menghapus data SEBELUM ${CUTOFF_DATE}`);
    if (!isConfirm) {
        console.log(`[MODE SIMULASI] Tambahkan "node purge_old_data.js --confirm" jika ingin menghapus permanen.`);
    } else {
        console.log(`[MODE BAHAYA] Penghapusan permanen dilakukan...`);
    }

    try {
        // Ambil ID customer yang dibuat sebelum tenggat waktu
        const { data: legacyCustomers, error: custError } = await supabase
            .from('customers')
            .select('id, phone_number, created_at')
            .lt('created_at', CUTOFF_DATE);

        if (custError) throw custError;

        console.log(`\n1. Ditemukan ${legacyCustomers.length} pelanggan lawas (sebelum 8 April).`);

        if (legacyCustomers.length === 0) {
            console.log("Database sudah bersih dari data lawas.");
            return;
        }

        const legacyCustomerIds = legacyCustomers.map(c => c.id);

        if (isConfirm) {
            // Karena relasi Foreign Key diatur dengan CASCADE di DB (biasanya), atau kita hapus dari media dulu.
            
            // Step 1: Hapus Fisik File Media di VPS Local
            const { data: legacyMedias } = await supabase.from('media').select('file_name').in('customer_id', legacyCustomerIds);
            let deletedFiles = 0;
            if (legacyMedias) {
                for (const m of legacyMedias) {
                    const filePath = path.join(__dirname, 'uploads', m.file_name);
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                        deletedFiles++;
                    }
                }
            }
            console.log(`=> ✅ Berhasil menghapus ${deletedFiles} file fisik di lokal VPS.`);

            // Step 2: Hapus dari DB 
            // Urutan: hapus media (jika ga di cascade), hapus pesan, hapus customer.
            console.log(`=> Menghapus records dari tabel media...`);
            await supabase.from('media').delete().lt('created_at', CUTOFF_DATE);

            console.log(`=> Menghapus records dari tabel messages...`);
            await supabase.from('messages').delete().in('customer_id', legacyCustomerIds);

            console.log(`=> Menghapus pelanggan lawas dari tabel customers...`);
            const { count } = await supabase.from('customers').delete().in('id', legacyCustomerIds).select('*', { count: 'exact', head: true });
            
            console.log(`\n✅ PURGE SELESAI!!`);
        } else {
            console.log(`JIKA DIJALANKAN DENGAN --confirm:`);
            console.log(`  - ${legacyCustomers.length} Pelanggan (termasuk pesannya) akan terhapus.`);
            // Menghitung estimasi media dll mungkin memakan quota, cukup warning di CLI.
            console.log(`\nBatal menghapus karena tidak ada flag --confirm.`);
        }

    } catch (err) {
        console.error("Terjadi error saat purge:", err.message);
    }
}

purgeLegacyData();
