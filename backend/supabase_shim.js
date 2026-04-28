const db = require('./db');
const crypto = require('crypto');

class QueryBuilder {
    constructor(table, io) {
        this.table = table;
        this.io = io;
        this._select = '*';
        this._eq = [];
        this._limit = null;
        this._isSingle = false;
        this._insertData = null;
        this._updateData = null;
        this._deleteFlag = false;
    }

    select(fields = '*') {
        this._select = fields;
        return this;
    }

    eq(field, value) {
        this._eq.push({ field, value });
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

    async execute() {
        if (this._insertData) {
            const data = { ...this._insertData, id: this._insertData.id || crypto.randomUUID() };
            const keys = Object.keys(data);
            const values = Object.values(data);
            const placeholders = keys.map(() => '?').join(', ');
            
            try {
                db.prepare(`INSERT INTO ${this.table} (${keys.join(', ')}) VALUES (${placeholders})`).run(...values);
                if (this.io) this.io.emit('db_change', { table: this.table, eventType: 'INSERT', new: data });
                
                if (this._select) {
                    return { data, error: null };
                }
                return { data: null, error: null };
            } catch (error) {
                return { data: null, error: { message: error.message, code: error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? '23505' : error.code } };
            }
        }

        if (this._updateData) {
            const keys = Object.keys(this._updateData);
            const values = Object.values(this._updateData);
            const setClause = keys.map(k => `${k} = ?`).join(', ');
            
            let whereClause = '';
            const whereValues = [];
            if (this._eq.length > 0) {
                whereClause = 'WHERE ' + this._eq.map(c => `${c.field} = ?`).join(' AND ');
                whereValues.push(...this._eq.map(c => c.value));
            }

            try {
                db.prepare(`UPDATE ${this.table} SET ${setClause} ${whereClause}`).run(...values, ...whereValues);
                
                // Fetch the updated records to emit
                const updated = db.prepare(`SELECT * FROM ${this.table} ${whereClause}`).all(...whereValues);
                if (this.io) {
                    updated.forEach(record => {
                        this.io.emit('db_change', { table: this.table, eventType: 'UPDATE', new: record });
                    });
                }
                return { data: null, error: null };
            } catch (error) {
                return { data: null, error };
            }
        }

        if (this._deleteFlag) {
            let whereClause = '';
            const whereValues = [];
            if (this._eq.length > 0) {
                whereClause = 'WHERE ' + this._eq.map(c => `${c.field} = ?`).join(' AND ');
                whereValues.push(...this._eq.map(c => c.value));
            }
            try {
                // Fetch before delete to emit
                const toDelete = db.prepare(`SELECT * FROM ${this.table} ${whereClause}`).all(...whereValues);
                db.prepare(`DELETE FROM ${this.table} ${whereClause}`).run(...whereValues);
                
                if (this.io) {
                    toDelete.forEach(record => {
                        this.io.emit('db_change', { table: this.table, eventType: 'DELETE', old: record });
                    });
                }
                return { data: null, error: null };
            } catch (error) {
                return { data: null, error };
            }
        }

        // SELECT query
        let whereClause = '';
        const whereValues = [];
        if (this._eq.length > 0) {
            whereClause = 'WHERE ' + this._eq.map(c => `${c.field} = ?`).join(' AND ');
            whereValues.push(...this._eq.map(c => c.value));
        }

        let limitClause = '';
        if (this._limit) limitClause = `LIMIT ${this._limit}`;
        
        try {
            const query = `SELECT ${this._select} FROM ${this.table} ${whereClause} ${limitClause}`;
            if (this._isSingle) {
                const data = db.prepare(query).get(...whereValues);
                if (!data) return { data: null, error: { code: 'PGRST116', message: 'No rows found' } };
                
                // SQLite returns 1/0 for boolean, cast back
                if (data.is_from_me !== undefined) data.is_from_me = Boolean(data.is_from_me);
                if (data.is_deleted !== undefined) data.is_deleted = Boolean(data.is_deleted);
                if (data.is_valid !== undefined) data.is_valid = Boolean(data.is_valid);
                
                return { data, error: null };
            } else {
                const data = db.prepare(query).all(...whereValues);
                data.forEach(d => {
                    if (d.is_from_me !== undefined) d.is_from_me = Boolean(d.is_from_me);
                    if (d.is_deleted !== undefined) d.is_deleted = Boolean(d.is_deleted);
                    if (d.is_valid !== undefined) d.is_valid = Boolean(d.is_valid);
                });
                return { data, error: null };
            }
        } catch (error) {
            return { data: null, error };
        }
    }

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
                upload: () => { throw new Error('Not implemented locally. Check logic.') }
            })
        }
    };
};

module.exports = { createClient, setIo };
