require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const path       = require('path');
const fs         = require('fs');

const db                 = require('./database');
const { generateRoaPDF } = require('./pdfGenerator');
const { sendRoaEmail }   = require('./emailService');

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Middleware ──
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use('/pdfs', express.static(path.join(__dirname, 'pdfs')));

// ════════════════════════════════
//   PIN GATE
// ════════════════════════════════

/**
 * POST /api/verify-pin
 * Verifikasi PIN gate sebelum halaman login.
 * PIN disimpan di .env sebagai APP_PIN.
 * Tidak perlu token — ini akses publik sebelum login.
 */
app.post('/api/verify-pin', (req, res) => {
  const { pin } = req.body;
  const correctPin = process.env.APP_PIN || '123456';

  if (!pin) {
    return res.status(400).json({ error: 'PIN wajib diisi' });
  }

  if (String(pin).trim() !== String(correctPin).trim()) {
    return res.status(401).json({ error: 'PIN salah' });
  }

  // PIN benar — kirim token session sederhana
  // Token ini hanya untuk gate, bukan untuk auth utama
  const gateToken = Buffer.from(`labflow-gate-${Date.now()}`).toString('base64');
  res.json({ success: true, gateToken });
});

// ── Cek token login ──
const requireAuth = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Tidak ada token' });
  try {
    const token = header.split(' ')[1];
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token tidak valid' });
  }
};

// ── Hanya untuk Analyst ──
const analystOnly = (req, res, next) => {
  if (req.user.role !== 'analyst')
    return res.status(403).json({ error: 'Hanya untuk Analyst' });
  next();
};

// ════════════════════════════════
//   AUTH
// ════════════════════════════════

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role)
      return res.status(400).json({ error: 'Semua field wajib diisi' });
    if (!['rd','analyst'].includes(role))
      return res.status(400).json({ error: 'Role tidak valid' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password minimal 6 karakter' });

    const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing)
      return res.status(400).json({ error: 'Email sudah terdaftar' });

    const hashed = await bcrypt.hash(password, 10);
    const result = await db.prepare(
      'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)'
    ).run(name, email, hashed, role);

    const user  = await db.prepare('SELECT id, name, email, role FROM users WHERE id = ?')
                    .get(result.lastInsertRowid);
    const token = jwt.sign(
      { id:user.id, email:user.email, role:user.role, name:user.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ user, token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email dan password wajib diisi' });

    const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user)
      return res.status(400).json({ error: 'Akun tidak ditemukan' });

    const match = await bcrypt.compare(password, user.password);
    if (!match)
      return res.status(400).json({ error: 'Incorrect password' });

    const token = jwt.sign(
      { id:user.id, email:user.email, role:user.role, name:user.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    const { password: _, ...safeUser } = user;
    res.json({ user: safeUser, token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Cek sesi
app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = await db.prepare('SELECT id, name, email, role FROM users WHERE id = ?')
                 .get(req.user.id);
  res.json(user);
});

// Update profil
app.patch('/api/auth/profile', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nama wajib diisi' });
  await db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
  res.json({ success: true });
});

// Ganti password
app.patch('/api/auth/password', requireAuth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const match = await bcrypt.compare(oldPassword, user.password);
    if (!match)
      return res.status(400).json({ error: 'Password lama salah' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, req.user.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ════════════════════════════════
//   RoA
// ════════════════════════════════

// Generate nomor RoA otomatis
/**
 * genRoaNumber()
 * ─────────────────────────────────────────────────────────────
 * Generate nomor RoA otomatis dengan format:
 *   XXX/ROA/WIN-LAB/MM/DD
 *
 * Aturan penomoran:
 *   - Nomor urut reset ke 001 setiap bulan baru
 *   - Filter berdasarkan BULAN + TAHUN yang sama (bukan bulan saja)
 *     → April 2026 dan April 2027 dihitung terpisah
 *   - Pakai MAX nomor urut (bukan COUNT) → aman meski ada RoA yang dihapus
 *
 * Contoh:
 *   April 2026: 001, 002, 003 ... 008
 *   Mei   2026: 001, 002, 003 ... (reset dari awal)
 *   April 2027: 001, 002, 003 ... (reset lagi, tahun berbeda)
 *
 * Cara kerja query:
 *   1. Cari semua RoA dengan pola: %/ROA/WIN-LAB/MM/YYYY%
 *      (format ini tidak ada di nomor RoA, jadi kita parse dari roa_number)
 *   2. Ambil MAX dari 3 digit pertama (nomor urut)
 *   3. Tambah +1
 *   4. Jika tidak ada data bulan ini → mulai dari 001
 * ─────────────────────────────────────────────────────────────
 */
async function genRoaNumber() {
  const now  = new Date();
  const yyyy = String(now.getFullYear());
  const mm   = String(now.getMonth()+1).padStart(2,'0');
  const dd   = String(now.getDate()).padStart(2,'0');

  // Pola pencarian: nomor RoA bulan MM tahun YYYY
  // Format nomor: 008/ROA/WIN-LAB/04/30
  // Kita cari yang bulannya = mm DAN tahunnya = yyyy
  // Caranya: ambil semua RoA bulan ini lalu filter tahun dari submission_date
  // Lebih akurat: filter dari kolom submission_date yang sudah ada di database

  // ── Query: ambil nomor urut terbesar di bulan + tahun yang sama ──
  // Logika:
  //   - submission_date format: 'YYYY-MM-DD'
  //   - TO_CHAR(submission_date::date, 'YYYY-MM') = '2026-04' untuk April 2026
  //   - SUBSTR(roa_number, 1, 3) ambil 3 digit pertama nomor urut
  //   - CAST ke integer untuk MAX yang benar (001 < 002 < 010 dst)
  // PostgreSQL: gunakan TO_CHAR untuk format tanggal
  const row = await db.prepare(`
    SELECT MAX(CAST(SUBSTR(roa_number, 1, 3) AS INTEGER)) AS max_seq
    FROM   roa_requests
    WHERE  TO_CHAR(submission_date::date, 'YYYY-MM') = ?
  `).get(`${yyyy}-${mm}`);

  // Kalau tidak ada data bulan ini → mulai dari 1
  // Kalau ada → lanjut dari yang terbesar + 1
  const nextSeq = (row?.max_seq ?? 0) + 1;

  return `${String(nextSeq).padStart(3,'0')}/ROA/WIN-LAB/${mm}/${dd}`;
}

// ── Durasi normal per parameter (dalam hari) ──
const PARAM_DAYS = {
  'Moisture Content':1,'Total Fat Content':3,'POV':2,'FFA':2,'Brix':1,'pH':1,
  'Viscosity':1,'Fineness':1,'Total Plate Count':2,'Yeast':5,'Mold':5,
  'Enterobacteriaceae':1,'Coliform':1,'Escherichia coli':2,'Salmonella sp':4,
};

// ── Helper: tambah N hari ke string tanggal 'YYYY-MM-DD' ──
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

// ── Helper: ambil tanggal terbesar dari dua string 'YYYY-MM-DD' ──
function maxDate(a, b) {
  return a >= b ? a : b;
}

/**
 * calculateFinenessDueDate
 * ─────────────────────────────────────────────────────────────
 * Menghitung due date untuk parameter Fineness menggunakan
 * sistem antrian (queue). Setiap sampel membutuhkan 1 hari
 * dan tidak boleh ada yang berjalan paralel.
 *
 * Logika:
 *   1. Ambil semua RoA aktif (pending/testing) yang punya Fineness
 *   2. Urutkan berdasarkan due_date ASC, lalu created_at ASC
 *   3. Ambil due_date terakhir dari antrian
 *   4. due_date baru = max(analysis_date, last_due_date + 1 hari)
 *
 * Jika antrian kosong → gunakan analysis_date itu sendiri
 *
 * @param {string} analysisDate  - format 'YYYY-MM-DD'
 * @param {number|null} excludeId - ID RoA yang sedang diedit (agar tidak hitung diri sendiri)
 * @returns {string} due date dalam format 'YYYY-MM-DD'
 */
function calculateFinenessDueDate(analysisDate, excludeId = null) {
  // Ambil semua RoA aktif yang mengandung parameter Fineness
  // Status approved tidak masuk antrian
  let sql = `
    SELECT due_date, created_at
    FROM   roa_requests
    WHERE  status IN ('pending', 'testing')
    AND    parameters LIKE '%Fineness%'
  `;
  const args = [];

  // Kalau ada excludeId (untuk edit/recalculate), skip RoA itu sendiri
  if (excludeId !== null) {
    sql  += ' AND id != ?';
    args.push(excludeId);
  }

  // Urutkan: due_date dulu, lalu created_at sebagai tiebreaker
  sql += ' ORDER BY due_date ASC, created_at ASC';

  const queue = await db.prepare(sql).all(...args);

  // Tidak ada antrian → pakai analysis_date langsung
  if (queue.length === 0) {
    return analysisDate;
  }

  // Ambil due_date paling akhir dari antrian
  const lastDueDate = queue[queue.length - 1].due_date;

  // due_date baru = max(analysis_date, last_due_date + 1 hari)
  const nextSlot = addDays(lastDueDate, 1);
  return maxDate(analysisDate, nextSlot);
}

/**
 * calculateDueDate
 * ─────────────────────────────────────────────────────────────
 * Menghitung due date untuk satu RoA berdasarkan parameter-nya.
 *
 * Aturan:
 * - Parameter normal → analysis_date + maxDays
 * - Parameter Fineness → pakai sistem antrian (queue)
 * - Kalau ada keduanya → ambil tanggal paling akhir (max)
 *
 * @param {string}   analysisDate - format 'YYYY-MM-DD'
 * @param {string[]} params       - daftar parameter yang dipilih
 * @param {number|null} excludeId - ID RoA yang dikecualikan dari antrian
 * @returns {string} due date dalam format 'YYYY-MM-DD'
 */
function calculateDueDate(analysisDate, params, excludeId = null) {
  const hasFineness    = params.includes('Fineness');
  const otherParams    = params.filter(p => p !== 'Fineness');

  // ── Due date dari parameter non-Fineness ──
  let normalDueDate = analysisDate; // default: tidak ada parameter lain
  if (otherParams.length > 0) {
    const maxDays = Math.max(...otherParams.map(p => PARAM_DAYS[p] || 1));
    normalDueDate = addDays(analysisDate, maxDays);
  }

  // ── Due date dari Fineness (queue) ──
  let finenessDueDate = null;
  if (hasFineness) {
    finenessDueDate = calculateFinenessDueDate(analysisDate, excludeId);
  }

  // ── Ambil yang paling akhir ──
  if (finenessDueDate !== null) {
    return maxDate(normalDueDate, finenessDueDate);
  }
  return normalDueDate;
}

/**
 * GET /api/fineness-queue
 * ─────────────────────────────────────────────────────────────
 * Endpoint untuk melihat antrian Fineness saat ini.
 * Berguna untuk debugging dan tampilan di frontend.
 */
app.get('/api/fineness-queue', requireAuth, (req, res) => {
  try {
    const queue = await db.prepare(`
      SELECT
        id,
        roa_number,
        sample_name,
        rd_name,
        analysis_date,
        due_date,
        status,
        created_at
      FROM   roa_requests
      WHERE  status IN ('pending', 'testing')
      AND    parameters LIKE '%Fineness%'
      ORDER  BY due_date ASC, created_at ASC
    `).all();

    res.json({
      count: queue.length,
      queue,
      next_available: queue.length === 0
        ? 'Antrian kosong — bisa langsung diproses'
        : addDays(queue[queue.length - 1].due_date, 1),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/roa/estimate-due-date
 * ─────────────────────────────────────────────────────────────
 * Endpoint untuk estimasi due date sebelum submit.
 * Frontend memanggil ini secara real-time saat user
 * memilih tanggal analisa di step 2 modal Add RoA.
 *
 * Tidak menyimpan data apapun — hanya kalkulasi saja.
 */
app.post('/api/roa/estimate-due-date', requireAuth, (req, res) => {
  try {
    const { analysis_date, parameters } = req.body;

    if (!analysis_date || !parameters?.length)
      return res.status(400).json({ error: 'analysis_date dan parameters wajib diisi' });

    const params = Array.isArray(parameters) ? parameters : JSON.parse(parameters);

    // Hitung due date menggunakan fungsi yang sama dengan POST /api/roa
    // Sehingga estimasi di frontend == hasil aktual saat submit
    const dueDate = calculateDueDate(analysis_date, params);

    // Juga kembalikan info antrian Fineness kalau ada
    let finessInfo = null;
    if (params.includes('Fineness')) {
      const queue = await db.prepare(`
        SELECT id, roa_number, sample_name, due_date
        FROM   roa_requests
        WHERE  status IN ('pending', 'testing')
        AND    parameters LIKE '%Fineness%'
        ORDER  BY due_date ASC, created_at ASC
      `).all();

      finessInfo = {
        queue_length:   queue.length,
        your_slot:      dueDate,
        queue_preview:  queue.map(r => ({
          roa_number:  r.roa_number,
          sample_name: r.sample_name,
          due_date:    r.due_date,
        })),
      };
    }

    res.json({
      due_date:     dueDate,
      analysis_date,
      has_fineness: params.includes('Fineness'),
      fineness_queue: finessInfo,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET semua RoA
app.get('/api/roa', requireAuth, (req, res) => {
  try {
    const { status, search } = req.query;
    let sql  = 'SELECT * FROM roa_requests WHERE 1=1';
    const args = [];

    if (status && status !== 'all') {
      sql += ' AND status = ?';
      args.push(status);
    }
    if (search) {
      sql += ' AND (roa_number LIKE ? OR sample_name LIKE ? OR rd_name LIKE ?)';
      const s = `%${search}%`;
      args.push(s, s, s);
    }
    sql += ' ORDER BY created_at DESC';

    const rows = await db.prepare(sql).all(...args);
    res.json(rows.map(r => ({
      ...r,
      parameters: JSON.parse(r.parameters || '[]'),
      results:    JSON.parse(r.results    || '{}'),
    })));
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET satu RoA dengan audit trail
app.get('/api/roa/:id', requireAuth, (req, res) => {
  try {
    const roa = await db.prepare('SELECT * FROM roa_requests WHERE id = ?').get(req.params.id);
    if (!roa) return res.status(404).json({ error: 'Tidak ditemukan' });

    const trail = await db.prepare(
      'SELECT * FROM audit_trail WHERE roa_id = ? ORDER BY created_at ASC'
    ).all(roa.id);

    res.json({
      ...roa,
      parameters: JSON.parse(roa.parameters || '[]'),
      results:    JSON.parse(roa.results    || '{}'),
      trail,
    });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST buat RoA baru (R&D)
app.post('/api/roa', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'rd')
      return res.status(403).json({ error: 'Hanya untuk R&D' });

    const { submission_date, sample_name, batch_number, best_before,
            parameters, analysis_date } = req.body;

    if (!sample_name || !parameters?.length || !analysis_date)
      return res.status(400).json({ error: 'Field wajib tidak lengkap' });

    const params  = Array.isArray(parameters) ? parameters : JSON.parse(parameters);

    // Hitung due date dengan logika baru:
    // - Fineness  → sistem antrian (queue), 1 hari per sampel, tidak paralel
    // - Lainnya   → analysis_date + maxDays seperti biasa
    // - Keduanya  → ambil tanggal paling akhir (max)
    const dueDateStr = calculateDueDate(analysis_date, params);

    const roaNum = await genRoaNumber();

    const result = await db.prepare(`
      INSERT INTO roa_requests
        (roa_number, submission_date, rd_id, rd_name, sample_name,
         batch_number, best_before, parameters, status, analysis_date, due_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      roaNum,
      submission_date || new Date().toISOString().split('T')[0],
      req.user.id,
      req.user.name,
      sample_name,
      batch_number || '',
      best_before  || '',
      JSON.stringify(params),
      analysis_date,
      dueDateStr,
    );

    await db.prepare(
      'INSERT INTO audit_trail (roa_id, action, by_name, by_role) VALUES (?, ?, ?, ?)'
    ).run(result.lastInsertRowid, 'Submitted', req.user.name, 'R&D');

    const newRoa = await db.prepare('SELECT * FROM roa_requests WHERE id = ?')
                     .get(result.lastInsertRowid);
    res.json({ ...newRoa, parameters: params, results: {} });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH start analysis (Analyst)
app.patch('/api/roa/:id/start', requireAuth, analystOnly, (req, res) => {
  try {
    const roa = await db.prepare('SELECT * FROM roa_requests WHERE id = ?').get(req.params.id);
    if (!roa) return res.status(404).json({ error: 'Tidak ditemukan' });
    if (roa.status !== 'pending')
      return res.status(400).json({ error: 'RoA bukan status pending' });

    await db.prepare(
      'UPDATE roa_requests SET status = ?, analyst_id = ?, analyst_name = ? WHERE id = ?'
    ).run('testing', req.user.id, req.user.name, roa.id);

    await db.prepare(
      'INSERT INTO audit_trail (roa_id, action, by_name, by_role) VALUES (?, ?, ?, ?)'
    ).run(roa.id, 'Analysis Started', req.user.name, 'Analyst');

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH simpan hasil analisa (Analyst)
app.patch('/api/roa/:id/results', requireAuth, analystOnly, (req, res) => {
  try {
    const { results } = req.body;
    await db.prepare('UPDATE roa_requests SET results = ? WHERE id = ?')
      .run(JSON.stringify(results), req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST approve → generate PDF → kirim email ke R&D submitter
// ─────────────────────────────────────────────────────────────────
// MULTI-ANALYST SAFE:
//   - Email SELALU dikirim ke R&D yang submit RoA (bukan ke analis)
//   - Analis yang approve hanya dicatat di: analyst_name + audit_trail
//   - Tidak ada akses ke email analis di sini — by design
// ─────────────────────────────────────────────────────────────────
app.post('/api/roa/:id/approve', requireAuth, analystOnly, async (req, res) => {
  try {
    // ── Ambil data RoA ──
    const roa = await db.prepare('SELECT * FROM roa_requests WHERE id = ?').get(req.params.id);
    if (!roa) return res.status(404).json({ error: 'Tidak ditemukan' });
    if (roa.status !== 'testing')
      return res.status(400).json({ error: 'RoA bukan status testing' });

    const today   = new Date().toISOString().split('T')[0];
    const results = req.body.results || JSON.parse(roa.results || '{}');

    // ── KEAMANAN: pastikan RoA punya rd_id yang valid ──
    if (!roa.rd_id) {
      console.error('❌ RoA tidak punya rd_id — tidak bisa kirim email');
      return res.status(400).json({ error: 'Data R&D tidak ditemukan di RoA ini' });
    }

    // ── 1. Ambil data R&D submitter dari database ──
    // Ini dilakukan SEBELUM update, agar kita yakin data tersedia
    // Email tujuan = email R&D yang submit, bukan email analis yang approve
    const rdSubmitter = await db.prepare(
      'SELECT id, name, email, role FROM users WHERE id = ?'
    ).get(roa.rd_id);

    if (!rdSubmitter) {
      console.error(`❌ User R&D dengan id=${roa.rd_id} tidak ditemukan di database`);
      return res.status(400).json({ error: 'Akun R&D submitter tidak ditemukan' });
    }

    if (rdSubmitter.role !== 'rd') {
      // Situasi aneh — rd_id menunjuk ke bukan R&D, log tapi tetap lanjut
      console.warn(`⚠️  rd_id=${roa.rd_id} bukan role R&D (role: ${rdSubmitter.role})`);
    }

    if (!rdSubmitter.email) {
      console.error(`❌ Email R&D submitter (id=${roa.rd_id}) kosong`);
      return res.status(400).json({ error: 'Email R&D submitter tidak ditemukan' });
    }

    // LOG: pastikan tujuan email sudah jelas sebelum proses dimulai
    console.log(`
📋 Proses Approve RoA ${roa.roa_number}`);
    console.log(`   Diapprove oleh : ${req.user.name} (${req.user.email}) [Analyst]`);
    console.log(`   Email tujuan   : ${rdSubmitter.email} [R&D Submitter]`);
    console.log(`   Nama R&D       : ${rdSubmitter.name}`);

    // ── 2. Update status jadi approved ──
    // analyst_name = siapa yang approve (untuk audit & PDF)
    // rd_id tetap tidak berubah (tetap R&D asli yang submit)
    await db.prepare(`
      UPDATE roa_requests
      SET status = 'approved', approved_date = ?, results = ?, analyst_name = ?
      WHERE id = ?
    `).run(today, JSON.stringify(results), req.user.name, roa.id);

    // ── 3. Catat di audit trail ──
    await db.prepare(
      'INSERT INTO audit_trail (roa_id, action, by_name, by_role) VALUES (?, ?, ?, ?)'
    ).run(
      roa.id,
      `Approved by ${req.user.name}`,
      req.user.name,
      'Analyst'
    );

    const updatedRoa = await db.prepare('SELECT * FROM roa_requests WHERE id = ?').get(roa.id);

    // ── 4. Generate PDF dari template ──
    let pdfPath = null;
    try {
      pdfPath = await generateRoaPDF({
        ...updatedRoa,
        parameters: JSON.parse(updatedRoa.parameters || '[]'),
        results:    JSON.parse(updatedRoa.results    || '{}'),
      });
      await db.prepare('UPDATE roa_requests SET pdf_path = ? WHERE id = ?')
        .run(pdfPath, roa.id);
      console.log(`✅ PDF berhasil dibuat: ${pdfPath}`);
    } catch (e) {
      console.error('❌ Gagal buat PDF:', e.message);
      // Tetap lanjut walau PDF gagal — status tetap approved
    }

    // ── 5. Kirim email ke R&D SUBMITTER ──
    // PENTING: toEmail selalu dari rdSubmitter.email (dari database berdasarkan rd_id RoA)
    // BUKAN dari req.user.email (email analis yang sedang login)
    if (pdfPath) {
      try {
        await sendRoaEmail({
          toEmail:      rdSubmitter.email,    // ← email R&D yang submit
          toName:       rdSubmitter.name,     // ← nama R&D yang submit
          rdName:       rdSubmitter.name,
          sampleName:   updatedRoa.sample_name,
          roaNumber:    updatedRoa.roa_number,
          approvedBy:   req.user.name,        // ← nama analis (untuk info di email)
          pdfPath,
        });
        console.log(`✅ Email berhasil dikirim ke: ${rdSubmitter.email} (${rdSubmitter.name})`);
        console.log(`   Bukan ke analis: ${req.user.email}
`);
      } catch (e) {
        console.error('❌ Gagal kirim email:', e.message);
        // Email gagal tidak membatalkan approval — RoA tetap approved
      }
    } else {
      console.warn('⚠️  PDF tidak tersedia — email tidak dikirim');
    }

    res.json({
      success:          true,
      pdfPath,
      approvedBy:       req.user.name,
      emailSentTo:      rdSubmitter.email,   // konfirmasi ke frontend: email kemana
      emailSentToName:  rdSubmitter.name,
    });

  } catch (e) {
    console.error('❌ Error di approve endpoint:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE hapus RoA (Analyst only)
app.delete('/api/roa/:id', requireAuth, analystOnly, (req, res) => {
  try {
    const roa = await db.prepare('SELECT * FROM roa_requests WHERE id = ?').get(req.params.id);
    if (!roa) return res.status(404).json({ error: 'Tidak ditemukan' });

    if (roa.pdf_path && fs.existsSync(roa.pdf_path)) {
      fs.unlinkSync(roa.pdf_path);
    }

    await db.prepare('DELETE FROM audit_trail   WHERE roa_id = ?').run(roa.id);
    await db.prepare('DELETE FROM roa_requests  WHERE id = ?').run(roa.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET download PDF
// ─────────────────────────────────────────────────────────────
// Satu source of truth: PDF selalu dari template ROA (pdfGenerator.js)
// Kalau file sudah ada → langsung download
// Kalau belum ada (misal data lama) → generate dulu lalu download
app.get('/api/roa/:id/pdf', requireAuth, async (req, res) => {
  try {
    const roa = await db.prepare('SELECT * FROM roa_requests WHERE id = ?').get(req.params.id);
    if (!roa) return res.status(404).json({ error: 'RoA tidak ditemukan' });
    if (roa.status !== 'approved')
      return res.status(400).json({ error: 'PDF hanya tersedia untuk RoA yang sudah Approved' });

    // Cek apakah file PDF sudah ada
    let pdfPath = roa.pdf_path;

    if (!pdfPath || !fs.existsSync(pdfPath)) {
      // File belum ada → generate dari template (sama persis dengan saat approve)
      console.log(`📄 PDF belum ada untuk RoA ${roa.roa_number} — generate dari template...`);
      try {
        pdfPath = await generateRoaPDF({
          ...roa,
          parameters: JSON.parse(roa.parameters || '[]'),
          results:    JSON.parse(roa.results    || '{}'),
        });
        // Simpan path ke database
        await db.prepare('UPDATE roa_requests SET pdf_path = ? WHERE id = ?')
          .run(pdfPath, roa.id);
        console.log(`✅ PDF berhasil digenerate: ${pdfPath}`);
      } catch (e) {
        console.error('❌ Gagal generate PDF:', e.message);
        return res.status(500).json({ error: 'Gagal generate PDF dari template' });
      }
    }

    // Set nama file yang rapi saat download
    const fileName = `${roa.roa_number.replace(/\//g, '_')}_Analysis_Testing_Report.pdf`;
    res.download(pdfPath, fileName);

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Jalankan server ──
app.listen(PORT, () => {
  console.log('\n====================================');
  console.log('  ⚗️  LabFlow Backend BERJALAN!');
  console.log('====================================');
  console.log(`  URL     : http://localhost:${PORT}`);
  console.log(`  Database: labflow.db`);
  console.log(`  Email   : ${process.env.EMAIL_USER || 'BELUM DISET'}`);
  console.log('====================================\n');
});
