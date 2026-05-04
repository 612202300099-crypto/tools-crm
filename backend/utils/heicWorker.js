const { parentPort } = require('worker_threads');
const convert = require('heic-convert');

parentPort.on('message', async ({ buffer }) => {
    try {
        const outputBuffer = await convert({
            buffer: buffer,
            format: 'JPEG',
            quality: 0.92 // Default quality for good balance between size and quality
        });
        parentPort.postMessage({ success: true, buffer: outputBuffer });
    } catch (error) {
        parentPort.postMessage({ success: false, error: error.message });
    }
});
