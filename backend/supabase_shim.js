/**
 * Supabase Shim — Drop-in replacement for @supabase/supabase-js
 * Routes all .from() queries to local SQLite via better-sqlite3.
 * Emits Socket.io events for realtime dashboard updates.
 * 
 * Supports: select, insert, update, delete, eq, not, in, gte, lte,
 *           order, limit, single, and chained .select().single() after insert/update.
 */

const db = require('./db');
const crypto = require('crypto');

/**
 * Sanitize a JS value for SQLite binding.
 * SQLite only accepts: number, string, bigint, Buffer, null.
 */
function sanitize(val) {
    if (val === undefined || val === null) return null;
    if (typeof val === 'boolean') return val ? 1 : 0;
    if (val instanceof Date) return val.toISOString();
    if (typeof val === 'object' && !(val instanceof Buffer)) {
        try { return JSON.stringify(val); } catch { return String(val); }
    }
    return val;
}

class QueryBuilder {
    constructor(table, io) {
        this.table = table;
        this.io = io;
        this._select = '*';
        this._conditions = [];   // {type, field, value, op}
        this._orderBy = [];
        this._limit = null;
        this._isSingle = false;
        this._insertData = null;
        this._updateData = null;
        this._deleteFlag = false;
        this._returnSelect = false; // for .insert().select()
    }

    select(fields = '*') {
        // If called after insert/update, it means "return the result"
        if (this._insertData || this._updateData) {
            this._returnSelect = true;
            return this;
        }
        this._select = fields;
        return this;
    }

    eq(field, value) {
        this._conditions.push({ type: 'eq', field, value: sanitize(value) });
        return this;
    }

    not(field, op, value) {
        this._conditions.push({ type: 'not', field, op, value: sanitize(value) });
        return this;
    }

    in(field, values) {
        this._conditions.push({ type: 'in', field, values: values.map(v => sanitize(v)) });
        return this;
    }

    gte(field, value) {
        this._conditions.push({ type: 'gte', field, value: sanitize(value) });
        return this;
    }

    lte(field, value) {
        this._conditions.push({ type: 'lte', field, value: sanitize(value) });
        return this;
    }

    order(field, opts = {}) {
        const dir = opts.ascending === false ? 'DESC' : (opts.ascending === true ? 'ASC' : 'DESC');
        this._orderBy.push(`${field} ${dir}`);
        return this;
    }

    limit(num) {
        this._limit = num;
        return this;
    }

    single() {
        this._isSingle = true;
        return this;
    }

    insert(data) {
        this._insertData = data;
        return this;
    }

    update(data) {
        this._updateData = data;
        return this;
    }

    delete() {
        this._deleteFlag = true;
        return this;
    }

    // Build WHERE clause from conditions
    _buildWhere() {
        if (this._conditions.length === 0) return { clause: '', params: [] };

        const parts = [];
        const params = [];

        for (const cond of this._conditions) {
            if (cond.type === 'eq') {
                parts.push(`${cond.field} = ?`);
                params.push(cond.value);
            } else if (cond.type === 'not') {
                if (cond.op === 'is' && cond.value === null) {
                    parts.push(`${cond.field} IS NOT NULL`);
                } else if (cond.op === 'eq') {
                    parts.push(`${cond.field} != ?`);
                    params.push(cond.value);
                } else {
                    parts.push(`${cond.field} != ?`);
                    params.push(cond.value);
                }
            } else if (cond.type === 'in') {
                const placeholders = cond.values.map(() => '?').join(', ');
                parts.push(`${cond.field} IN (${placeholders})`);
                params.push(...cond.values);
            } else if (cond.type === 'gte') {
                parts.push(`${cond.field} >= ?`);
                params.push(cond.value);
            } else if (cond.type === 'lte') {
                parts.push(`${cond.field} <= ?`);
                params.push(cond.value);
            }
        }

        return { clause: 'WHERE ' + parts.join(' AND '), params };
    }

    _castBooleans(row) {
        if (!row) return row;
        if (row.is_from_me !== undefined) row.is_from_me = Boolean(row.is_from_me);
        if (row.is_deleted !== undefined) row.is_deleted = Boolean(row.is_deleted);
        if (row.is_valid !== undefined) row.is_valid = Boolean(row.is_valid);
        if (row.is_enabled !== undefined) row.is_enabled = Boolean(row.is_enabled);
        return row;
    }

    async execute() {
        // ─── INSERT ───
        if (this._insertData) {
            const data = { ...this._insertData };
            if (!data.id) data.id = crypto.randomUUID();

            // Sanitize all values
            const keys = Object.keys(data);
            const values = keys.map(k => sanitize(data[k]));
            const placeholders = keys.map(() => '?').join(', ');

            try {
                db.prepare(`INSERT INTO ${this.table} (${keys.join(', ')}) VALUES (${placeholders})`).run(...values);

                // Read back the inserted row for accurate data
                const inserted = db.prepare(`SELECT * FROM ${this.table} WHERE id = ?`).get(data.id);
                const result = this._castBooleans(inserted || data);

                if (this.io) {
                    this.io.emit('db_change', { table: this.table, eventType: 'INSERT', new: result });
                }

                if (this._returnSelect && this._isSingle) {
                    return { data: result, error: null };
                }
                return { data: result, error: null };
            } catch (error) {
                return {
                    data: null,
                    error: {
                        message: error.message,
                        code: error.message?.includes('UNIQUE') ? '23505' : error.code
                    }
                };
            }
        }

        // ─── UPDATE ───
        if (this._updateData) {
            const keys = Object.keys(this._updateData);
            const values = keys.map(k => sanitize(this._updateData[k]));
            const setClause = keys.map(k => `${k} = ?`).join(', ');

            const { clause, params } = this._buildWhere();

            try {
                db.prepare(`UPDATE ${this.table} SET ${setClause} ${clause}`).run(...values, ...params);

                // Fetch updated rows and emit
                const updated = db.prepare(`SELECT * FROM ${this.table} ${clause}`).all(...params);
                if (this.io) {
                    updated.forEach(record => {
                        this.io.emit('db_change', { table: this.table, eventType: 'UPDATE', new: this._castBooleans(record) });
                    });
                }
                return { data: null, error: null };
            } catch (error) {
                return { data: null, error: { message: error.message } };
            }
        }

        // ─── DELETE ───
        if (this._deleteFlag) {
            const { clause, params } = this._buildWhere();
            try {
                const toDelete = db.prepare(`SELECT * FROM ${this.table} ${clause}`).all(...params);
                db.prepare(`DELETE FROM ${this.table} ${clause}`).run(...params);

                if (this.io) {
                    toDelete.forEach(record => {
                        this.io.emit('db_change', { table: this.table, eventType: 'DELETE', old: record });
                    });
                }
                return { data: null, error: null };
            } catch (error) {
                return { data: null, error: { message: error.message } };
            }
        }

        // ─── SELECT ───
        const { clause, params } = this._buildWhere();

        let orderClause = '';
        if (this._orderBy.length > 0) {
            orderClause = 'ORDER BY ' + this._orderBy.join(', ');
        }

        let limitClause = '';
        if (this._limit) limitClause = `LIMIT ${this._limit}`;

        try {
            const sql = `SELECT ${this._select} FROM ${this.table} ${clause} ${orderClause} ${limitClause}`;

            if (this._isSingle) {
                const data = db.prepare(sql).get(...params);
                if (!data) return { data: null, error: { code: 'PGRST116', message: 'No rows found' } };
                return { data: this._castBooleans(data), error: null };
            } else {
                const data = db.prepare(sql).all(...params);
                data.forEach(d => this._castBooleans(d));
                return { data, error: null };
            }
        } catch (error) {
            return { data: null, error: { message: error.message } };
        }
    }

    // Allow await on QueryBuilder directly
    then(resolve, reject) {
        this.execute().then(resolve).catch(reject);
    }
}

let globalIo = null;
const setIo = (io) => { globalIo = io; };

const createClient = () => {
    return {
        from: (table) => new QueryBuilder(table, globalIo),
        storage: {
            from: (bucket) => ({
                upload: () => ({ data: null, error: { message: 'Local storage: use filesystem directly.' } }),
                getPublicUrl: (filePath) => ({ data: { publicUrl: `/uploads/${filePath}` } })
            })
        },
        // Stub for auth calls (no-op, we use JWT now)
        auth: {
            signInWithPassword: async () => ({ data: null, error: { message: 'Use /api/local/login instead' } }),
            getSession: async () => ({ data: { session: null } }),
            signOut: async () => ({ error: null }),
        },
        // Stub for channel/realtime (no-op, we use Socket.io now)
        channel: () => ({
            on: function() { return this; },
            subscribe: function() { return this; },
        }),
        removeChannel: () => {},
    };
};

module.exports = { createClient, setIo };
