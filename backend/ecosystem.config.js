// PM2 Ecosystem Config — Production
// Jalankan: pm2 start ecosystem.config.js
module.exports = {
    apps: [{
        name: 'WA-Engine',
        script: './index.js',
        cwd: '/root/tools-crm/backend',
        
        // Auto-restart jika memory > 1.5GB (dari 8GB total)
        max_memory_restart: '1500M',
        
        // Restart otomatis jam 3 pagi setiap hari (bersih-bersih memory)
        cron_restart: '0 3 * * *',
        
        // Auto-restart jika crash
        autorestart: true,
        max_restarts: 10,
        min_uptime: '30s',
        restart_delay: 10000, // Tunggu 10 detik sebelum restart

        // Environment
        env: {
            NODE_ENV: 'production',
            NODE_OPTIONS: '--max-old-space-size=1024', // V8 heap limit 1GB
        },

        // Logging
        error_file: '/root/.pm2/logs/WA-Engine-error.log',
        out_file: '/root/.pm2/logs/WA-Engine-out.log',
        merge_logs: true,
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
        
        // Log rotation (jangan sampai log penuhkan disk)
        max_size: '50M',
    }]
};
