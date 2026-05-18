/**
 * orderIdUtils.js — Unified Order ID Detection Utility
 * ─────────────────────────────────────────────────────
 * SATU regex baku untuk deteksi nomor pesanan di seluruh codebase.
 *
 * Rules:
 * - 14-20 digit berurutan (Tokopedia, Shopee, TikTok Shop)
 * - Dibatasi word boundary agar tidak tangkap teks di tengah kalimat
 * - JANGAN pakai 10-20 → false positive nomor HP (12 digit)
 *
 * Penggunaan:
 *   const { detectOrderId } = require('../utils/orderIdUtils');
 *   const orderId = detectOrderId(message.body);
 */

'use strict';

/**
 * Regex baku untuk nomor pesanan marketplace Indonesia.
 * 14-20 digit (Tokopedia: 16+, Shopee: 18-19, TikTok: 15-16).
 * Word boundary (\b) mencegah match di tengah teks yang lebih panjang.
 */
const ORDER_ID_REGEX = /\b(\d{14,20})\b/;

/**
 * Deteksi nomor pesanan dari teks pesan.
 * @param {string|null|undefined} text - Isi pesan WhatsApp
 * @returns {string|null} Nomor pesanan (string digit) atau null jika tidak ada
 */
function detectOrderId(text) {
    if (!text || typeof text !== 'string') return null;
    const match = text.match(ORDER_ID_REGEX);
    return match ? match[1] : null;
}

/**
 * Cek apakah suatu string adalah nomor pesanan yang valid.
 * @param {string} value
 * @returns {boolean}
 */
function isValidOrderId(value) {
    if (!value || typeof value !== 'string') return false;
    return /^\d{14,20}$/.test(value.trim());
}

module.exports = { detectOrderId, isValidOrderId, ORDER_ID_REGEX };
