require('dotenv').config();
const { createClient } = require('../supabase_shim');
const fs = require('fs');
const path = require('path');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function runCleanup() {
    console.log(`\n[${new Date().toISOString()}] 🧹 Menjalankan The Janitor (Auto-Cleanup)...`);

    try {
        // Ambil semua customer yang VALIDATED
        const { data: validatedCustomers, error: custError } = await supabase
            .from('customers')
            .select('id')
            .eq('status', 'VALIDATED');
        
        if (custError) throw custError;

        if (!validatedCustomers || validatedCustomers.length === 0) {
            console.log("-> Tidak menemukan customer berstatus VALIDATED.");
            return;
        }

        const validCustomerIds = validatedCustomers.map(c => c.id);

        // Cari file media yang terkait dengan customer VALIDATED, dan usianya LEBIH DARI 3 HARI
        const threeDaysAgo = new Date();
        threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
        const cutoffString = threeDaysAgo.toISOString();

        const { data: oldMedias, error: mediaError } = await supabase
            .from('media')
            .select('id, file_name, created_at')
            .in('customer_id', validCustomerIds)
            .lt('created_at', cutoffString);

        if (mediaError) throw mediaError;

        if (!oldMedias || oldMedias.length === 0) {
            console.log("-> Bersih! Tidak ada media yang expired (>3 Hari) dari customer VALIDATED.");
            return;
        }

        console.log(`-> Ditemukan ${oldMedias.length} media yang expired. Memulai penghapusan...`);

        let deletedCount = 0;
        let failCount = 0;
        const idsToDelete = [];

        for (const media of oldMedias) {
            const filePath = path.join(__dirname, '..', 'uploads', media.file_name);
            
            try {
                // Hapus file fisik di VPS
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
                idsToDelete.push(media.id);
                deletedCount++;
            } catch (err) {
                console.error(`Gagal menghapus file ${media.file_name}:`, err.message);
                failCount++;
            }
        }

        // Hapus row di database
        if (idsToDelete.length > 0) {
            await supabase.from('media').delete().in('id', idsToDelete);
        }

        console.log(`✅ The Janitor Selesai: Menghapus ${deletedCount} foto lama. (Gagal: ${failCount})`);
    } catch (err) {
        console.error("❌ Terjadi kesalahan fatal di The Janitor:", err.message);
    }
}

// Untuk bisa dipanggil file lain maupun run manual di CLI:
if (require.main === module) {
    // Jika script dijalankan langsung (node cleanupService.js), maka eksekusi segera
    runCleanup();
} else {
    module.exports = runCleanup;
}
