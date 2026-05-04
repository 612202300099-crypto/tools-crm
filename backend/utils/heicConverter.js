const { Worker } = require('worker_threads');
const path = require('path');

/**
 * Konversi HEIC ke JPEG menggunakan Worker Thread untuk mencegah event loop terblokir.
 * @param {Buffer} buffer - Buffer file HEIC.
 * @returns {Promise<Buffer>} - Buffer gambar JPEG yang sudah dikonversi.
 */
function convertHeicToJpg(buffer) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'heicWorker.js'));

        worker.on('message', (msg) => {
            if (msg.success) {
                resolve(msg.buffer);
            } else {
                reject(new Error(msg.error));
            }
            // Segera matikan worker setelah selesai untuk menghemat memory
            worker.terminate();
        });

        worker.on('error', (err) => {
            reject(err);
            worker.terminate();
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`Worker stopped with exit code ${code}`));
            }
        });

        // Kirim pekerjaan ke worker
        worker.postMessage({ buffer });
    });
}

module.exports = {
    convertHeicToJpg
};
