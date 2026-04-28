const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('./db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'crm-super-secret-key-2026';
const ADMIN_EMAIL = 'admin@polaroid.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'polaroid123';

// Middleware Auth
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

router.post('/login', (req, res) => {
    const { email, password } = req.body;
    if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
        const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ access_token: token });
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

// GET Customers with search, filter, and media count
router.get('/customers', authenticateToken, (req, res) => {
    try {
        const { search, status, order, start, end, limit = 1000 } = req.query;
        let query = `
            SELECT c.*, 
                   (SELECT COUNT(*) FROM media m WHERE m.customer_id = c.id) as media_count
            FROM customers c
            WHERE 1=1
        `;
        const params = [];

        if (search) {
            query += ` AND (c.name LIKE ? OR c.phone_number LIKE ? OR c.order_id LIKE ?)`;
            const s = `%${search}%`;
            params.push(s, s, s);
        }
        if (status && status !== 'ALL') {
            query += ` AND c.status = ?`;
            params.push(status);
        }
        if (order === 'SENT') {
            query += ` AND c.order_id IS NOT NULL`;
        } else if (order === 'NOT_SENT') {
            query += ` AND c.order_id IS NULL`;
        }
        if (start && end) {
            query += ` AND c.created_at >= ? AND c.created_at <= ?`;
            params.push(new Date(start).toISOString(), new Date(end).toISOString());
        }

        query += ` ORDER BY c.created_at DESC LIMIT ?`;
        params.push(parseInt(limit));

        const customers = db.prepare(query).all(...params);
        
        // Format to match Supabase shape for frontend compatibility
        const formatted = customers.map(c => {
            const { media_count, ...rest } = c;
            return {
                ...rest,
                is_valid: Boolean(rest.is_valid),
                media: [{ count: media_count }]
            };
        });

        res.json(formatted);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/customers/:id', authenticateToken, (req, res) => {
    try {
        const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
        if (!customer) return res.status(404).json({ error: 'Not found' });
        customer.is_valid = Boolean(customer.is_valid);
        res.json(customer);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/customers/:id', authenticateToken, (req, res) => {
    try {
        const { name, order_id, status, is_valid, created_at } = req.body;
        const updates = [];
        const params = [];

        if (name !== undefined) { updates.push('name = ?'); params.push(name); }
        if (order_id !== undefined) { updates.push('order_id = ?'); params.push(order_id); }
        if (status !== undefined) { updates.push('status = ?'); params.push(status); }
        if (is_valid !== undefined) { updates.push('is_valid = ?'); params.push(is_valid ? 1 : 0); }
        if (created_at !== undefined) { updates.push('created_at = ?'); params.push(created_at); }

        if (updates.length > 0) {
            params.push(req.params.id);
            db.prepare(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        }
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/customers/:id/messages', authenticateToken, (req, res) => {
    try {
        const messages = db.prepare('SELECT * FROM messages WHERE customer_id = ? ORDER BY created_at ASC').all(req.params.id);
        const formatted = messages.map(m => ({ ...m, is_from_me: Boolean(m.is_from_me) }));
        res.json(formatted);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/customers/:id/media', authenticateToken, (req, res) => {
    try {
        const media = db.prepare('SELECT * FROM media WHERE customer_id = ? ORDER BY created_at DESC').all(req.params.id);
        res.json(media);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = { router, authenticateToken };
