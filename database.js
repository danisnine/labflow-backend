/**
 * database.js — LabFlow
 * PostgreSQL via Supabase
 * Ganti dari SQLite ke PostgreSQL agar bisa online
 */

const { Pool } = require('pg');

// Koneksi ke Supabase PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // wajib untuk Supabase
  max:              10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Test koneksi saat startup
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Gagal koneksi ke database:', err.message);
    console.error('   Pastikan DATABASE_URL sudah benar di .env');
  } else {
    console.log('✅ Database PostgreSQL (Supabase) terhubung!');
    release();
  }
});

/**
 * db.prepare(sql).get(...params)     → SELECT satu baris
 * db.prepare(sql).all(...params)     → SELECT semua baris
 * db.prepare(sql).run(...params)     → INSERT/UPDATE/DELETE
 *
 * Semua fungsi ini ASYNC karena PostgreSQL tidak sync seperti SQLite.
 * Tapi kita bungkus agar interface-nya mirip SQLite supaya
 * tidak perlu ubah banyak di server.js
 */

// Helper: jalankan query dengan params array
async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result;
  } finally {
    client.release();
  }
}

// Konversi placeholder SQLite (?) ke PostgreSQL ($1, $2, ...)
function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Interface mirip better-sqlite3 tapi async
const db = {
  // SELECT → return satu baris
  async get(sql, ...params) {
    const pgSql = convertPlaceholders(sql);
    const flat  = params.flat();
    const result = await query(pgSql, flat);
    return result.rows[0] || null;
  },

  // SELECT → return semua baris
  async all(sql, ...params) {
    const pgSql = convertPlaceholders(sql);
    const flat  = params.flat();
    const result = await query(pgSql, flat);
    return result.rows;
  },

  // INSERT/UPDATE/DELETE → return { lastInsertRowid, changes }
  async run(sql, ...params) {
    const pgSql = convertPlaceholders(
      // Konversi SQLite AUTOINCREMENT → PostgreSQL RETURNING id
      sql.replace(/INSERT INTO (\w+)/, 'INSERT INTO $1')
    );
    const flat   = params.flat();

    // Tambah RETURNING id untuk INSERT agar dapat lastInsertRowid
    const isInsert = pgSql.trim().toUpperCase().startsWith('INSERT');
    const finalSql = isInsert && !pgSql.includes('RETURNING')
      ? pgSql + ' RETURNING id'
      : pgSql;

    const result = await query(finalSql, flat);

    return {
      lastInsertRowid: result.rows[0]?.id || null,
      changes:         result.rowCount || 0,
    };
  },

  // Untuk kompatibilitas prepare().get() / prepare().all() / prepare().run()
  prepare(sql) {
    return {
      get:  (...params) => db.get(sql, ...params),
      all:  (...params) => db.all(sql, ...params),
      run:  (...params) => db.run(sql, ...params),
    };
  },

  // Expose pool untuk transaction jika dibutuhkan
  pool,
  query,
};

module.exports = db;
