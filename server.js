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

// ── Auth middleware ──
const requireAuth = async (req, res, next) => {
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

const analystOnly = (req, res, next) => {
  if (req.user.role !== 'analyst')
    return res.status(403).json({ error: 'Hanya untuk Analyst' });
  next();
};

// ════════════════════════════════
//   PIN GATE
// ════════════════════════════════
app.post('/api/verify-pin', (req, res) => {
  const { pin } = req.body;
  const correctPin = process.env.APP_PIN || '123456';
  if (!pin) return res.status(400).json({ error: 'PIN wajib diisi' });
  if (String(pin).trim() !== String(correctPin).trim())
    return res.status(401).json({ error: 'PIN salah' });
  const gateToken = Buffer.from(`labflow-gate-${Date.now()}`).toString('base64');
  res.json({ success: true, gateToken });
});

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

    const existing = await db.get('SELECT id FROM users WHERE email = $1', [email]);
    if (existing) return res.status(400).json({ error: 'Email sudah terdaftar' });

    const hashed = await bcrypt.hash(password, 10);
    const result = await db.run(
      'INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4)',
      [name, email, hashed, role]
    );

    const user  = await db.get('SELECT id, name, email, role FROM users WHERE id = $1', [result.lastInsertRowid]);
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name },
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

    const user = await db.get('SELECT * FROM users WHERE email = $1', [email]);
    if (!user) return res.status(400).json({ error: 'Akun tidak ditemukan' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'Incorrect password' });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name },
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
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const user = await db.get('SELECT id, name, email, role FROM users WHERE id = $1', [req.user.id]);
    res.json(user);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update profil
app.patch('/api/auth/profile', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Nama wajib diisi' });
    await db.run('UPDATE users SET name = $1 WHERE id = $2', [name, req.user.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Ganti password
app.patch('/api/auth/password', requireAuth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const user = await db.get('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const match = await bcrypt.compare(oldPassword, user.password);
    if (!match) return res.status(400).json({ error: 'Password lama salah' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await db.run('UPDATE users SET password = $1 WHERE id = $2', [hashed, req.user.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ════════════════════════════════
//   RoA HELPERS
// ════════════════════════════════

const PARAM_DAYS = {
  'Moisture Content':1,'Total Fat Content':3,'POV':2,'FFA':2,'Brix':1,'pH':1,
  'Viscosity':1,'Fineness':1,'Total Plate Count':2,'Yeast':5,'Mold':5,
  'Enterobacteriaceae':1,'Coliform':1,'Escherichia coli':2,'Salmonella sp':4,
};

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

function maxDate(a, b) { return a >= b ? a : b; }

// Generate nomor RoA — reset per bulan+tahun, pakai MAX bukan COUNT
async function genRoaNumber() {
  const now  = new Date();
  const yyyy = String(now.getFullYear());
  const mm   = String(now.getMonth()+1).padStart(2,'0');
  const dd   = String(now.getDate()).padStart(2,'0');

  // Filter bulan + tahun yang sama agar reset setiap bulan baru
  const row = await db.get(
    `SELECT MAX(CAST(SUBSTRING(roa_number FROM 1 FOR 3) AS INTEGER)) AS max_seq
     FROM   roa_requests
     WHERE  TO_CHAR(submission_date::date, 'YYYY-MM') = $1`,
    [`${yyyy}-${mm}`]
  );

  const nextSeq = (row?.max_seq ?? 0) + 1;
  return `${String(nextSeq).padStart(3,'0')}/ROA/WIN-LAB/${mm}/${dd}`;
}

// Fineness queue — hitung due date antrian
async function calculateFinenessDueDate(analysisDate, excludeId = null) {
  let sql  = `SELECT due_date, created_at FROM roa_requests
              WHERE status IN ('pending','testing') AND parameters LIKE '%Fineness%'`;
  const args = [];

  if (excludeId !== null) {
    sql += ` AND id != $${args.length + 1}`;
    args.push(excludeId);
  }
  sql += ' ORDER BY due_date ASC, created_at ASC';

  const queue = await db.all(sql, args);
  if (queue.length === 0) return analysisDate;

  const lastDueDate = queue[queue.length - 1].due_date;
  const nextSlot    = addDays(lastDueDate, 1);
  return maxDate(analysisDate, nextSlot);
}

// Hitung due date keseluruhan
async function calculateDueDate(analysisDate, params, excludeId = null) {
  const hasFineness = params.includes('Fineness');
  const otherParams = params.filter(p => p !== 'Fineness');

  let normalDueDate = analysisDate;
  if (otherParams.length > 0) {
    const maxD = Math.max(...otherParams.map(p => PARAM_DAYS[p] || 1));
    normalDueDate = addDays(analysisDate, maxD);
  }

  if (!hasFineness) return normalDueDate;

  const finenessDueDate = await calculateFinenessDueDate(analysisDate, excludeId);
  return maxDate(normalDueDate, finenessDueDate);
}

// ════════════════════════════════
//   ESTIMATE DUE DATE
// ════════════════════════════════
app.post('/api/roa/estimate-due-date', requireAuth, async (req, res) => {
  try {
    const { analysis_date, parameters } = req.body;
    if (!analysis_date || !parameters?.length)
      return res.status(400).json({ error: 'analysis_date dan parameters wajib' });

    const params  = Array.isArray(parameters) ? parameters : JSON.parse(parameters);
    const dueDate = await calculateDueDate(analysis_date, params);

    let finesseInfo = null;
    if (params.includes('Fineness')) {
      const queue = await db.all(
        `SELECT id, roa_number, sample_name, due_date
         FROM roa_requests
         WHERE status IN ('pending','testing') AND parameters LIKE '%Fineness%'
         ORDER BY due_date ASC, created_at ASC`
      );
      finesseInfo = {
        queue_length:  queue.length,
        your_slot:     dueDate,
        queue_preview: queue.map(r => ({
          roa_number: r.roa_number, sample_name: r.sample_name, due_date: r.due_date
        })),
      };
    }

    res.json({ due_date: dueDate, analysis_date, has_fineness: params.includes('Fineness'), fineness_queue: finesseInfo });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ════════════════════════════════
//   FINENESS QUEUE
// ════════════════════════════════
app.get('/api/fineness-queue', requireAuth, async (req, res) => {
  try {
    const queue = await db.all(
      `SELECT id, roa_number, sample_name, rd_name, analysis_date, due_date, status, created_at
       FROM roa_requests
       WHERE status IN ('pending','testing') AND parameters LIKE '%Fineness%'
       ORDER BY due_date ASC, created_at ASC`
    );
    const last = queue[queue.length - 1];
    res.json({
      count: queue.length,
      queue,
      next_available: queue.length === 0 ? 'Antrian kosong' : addDays(last.due_date, 1),
    });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ════════════════════════════════
//   ROA ROUTES
// ════════════════════════════════

// GET semua RoA
app.get('/api/roa', requireAuth, async (req, res) => {
  try {
    const { status, search } = req.query;
    let sql  = 'SELECT * FROM roa_requests WHERE 1=1';
    const args = [];

    if (status && status !== 'all') {
      args.push(status);
      sql += ` AND status = $${args.length}`;
    }
    if (search) {
      const s = `%${search}%`;
      args.push(s, s, s);
      sql += ` AND (roa_number ILIKE $${args.length-2} OR sample_name ILIKE $${args.length-1} OR rd_name ILIKE $${args.length})`;
    }
    sql += ' ORDER BY created_at DESC';

    const rows = await db.all(sql, args);
    res.json(rows.map(r => ({
      ...r,
      parameters: typeof r.parameters === 'string' ? JSON.parse(r.parameters) : r.parameters,
      results:    typeof r.results    === 'string' ? JSON.parse(r.results)    : r.results,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET satu RoA
app.get('/api/roa/:id', requireAuth, async (req, res) => {
  try {
    const roa = await db.get('SELECT * FROM roa_requests WHERE id = $1', [req.params.id]);
    if (!roa) return res.status(404).json({ error: 'Tidak ditemukan' });

    const trail = await db.all(
      'SELECT * FROM audit_trail WHERE roa_id = $1 ORDER BY created_at ASC',
      [roa.id]
    );

    res.json({
      ...roa,
      parameters: typeof roa.parameters === 'string' ? JSON.parse(roa.parameters) : roa.parameters,
      results:    typeof roa.results    === 'string' ? JSON.parse(roa.results)    : roa.results,
      trail,
    });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST buat RoA baru (R&D)
app.post('/api/roa', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'rd')
      return res.status(403).json({ error: 'Hanya untuk R&D' });

    const { submission_date, sample_name, batch_number, best_before, parameters, analysis_date } = req.body;
    if (!sample_name || !parameters?.length || !analysis_date)
      return res.status(400).json({ error: 'Field wajib tidak lengkap' });

    const params     = Array.isArray(parameters) ? parameters : JSON.parse(parameters);
    const dueDateStr = await calculateDueDate(analysis_date, params);
    const roaNum     = await genRoaNumber();
    const submDate   = submission_date || new Date().toISOString().split('T')[0];

    const result = await db.run(
      `INSERT INTO roa_requests
        (roa_number, submission_date, rd_id, rd_name, sample_name,
         batch_number, best_before, parameters, status, analysis_date, due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10)`,
      [roaNum, submDate, req.user.id, req.user.name, sample_name,
       batch_number||'', best_before||'', JSON.stringify(params), analysis_date, dueDateStr]
    );

    await db.run(
      'INSERT INTO audit_trail (roa_id, action, by_name, by_role) VALUES ($1,$2,$3,$4)',
      [result.lastInsertRowid, 'Submitted', req.user.name, 'R&D']
    );

    const newRoa = await db.get('SELECT * FROM roa_requests WHERE id = $1', [result.lastInsertRowid]);
    res.json({ ...newRoa, parameters: params, results: {} });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH start analysis (Analyst)
app.patch('/api/roa/:id/start', requireAuth, analystOnly, async (req, res) => {
  try {
    const roa = await db.get('SELECT * FROM roa_requests WHERE id = $1', [req.params.id]);
    if (!roa) return res.status(404).json({ error: 'Tidak ditemukan' });
    if (roa.status !== 'pending') return res.status(400).json({ error: 'RoA bukan status pending' });

    await db.run(
      'UPDATE roa_requests SET status=$1, analyst_id=$2, analyst_name=$3 WHERE id=$4',
      ['testing', req.user.id, req.user.name, roa.id]
    );
    await db.run(
      'INSERT INTO audit_trail (roa_id, action, by_name, by_role) VALUES ($1,$2,$3,$4)',
      [roa.id, 'Analysis Started', req.user.name, 'Analyst']
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH simpan results
app.patch('/api/roa/:id/results', requireAuth, analystOnly, async (req, res) => {
  try {
    const { results } = req.body;
    await db.run(
      'UPDATE roa_requests SET results=$1 WHERE id=$2',
      [JSON.stringify(results), req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST approve → generate PDF → kirim email
app.post('/api/roa/:id/approve', requireAuth, analystOnly, async (req, res) => {
  try {
    const roa = await db.get('SELECT * FROM roa_requests WHERE id = $1', [req.params.id]);
    if (!roa) return res.status(404).json({ error: 'Tidak ditemukan' });
    if (roa.status !== 'testing') return res.status(400).json({ error: 'RoA bukan status testing' });

    if (!roa.rd_id) return res.status(400).json({ error: 'Data R&D tidak ditemukan' });

    // Ambil data R&D submitter
    const rdSubmitter = await db.get(
      'SELECT id, name, email, role FROM users WHERE id = $1',
      [roa.rd_id]
    );
    if (!rdSubmitter) return res.status(400).json({ error: 'Akun R&D submitter tidak ditemukan' });
    if (!rdSubmitter.email) return res.status(400).json({ error: 'Email R&D submitter tidak ditemukan' });

    const today   = new Date().toISOString().split('T')[0];
    const results = req.body.results || (typeof roa.results === 'string' ? JSON.parse(roa.results) : roa.results || {});

    // Update status
    await db.run(
      `UPDATE roa_requests SET status='approved', approved_date=$1, results=$2, analyst_name=$3 WHERE id=$4`,
      [today, JSON.stringify(results), req.user.name, roa.id]
    );
    await db.run(
      'INSERT INTO audit_trail (roa_id, action, by_name, by_role) VALUES ($1,$2,$3,$4)',
      [roa.id, `Approved by ${req.user.name}`, req.user.name, 'Analyst']
    );

    const updatedRoa = await db.get('SELECT * FROM roa_requests WHERE id = $1', [roa.id]);

    // Generate PDF
    let pdfPath = null;
    try {
      const params  = typeof updatedRoa.parameters === 'string' ? JSON.parse(updatedRoa.parameters) : updatedRoa.parameters;
      const resData = typeof updatedRoa.results    === 'string' ? JSON.parse(updatedRoa.results)    : updatedRoa.results;

      pdfPath = await generateRoaPDF({ ...updatedRoa, parameters: params, results: resData });
      await db.run('UPDATE roa_requests SET pdf_path=$1 WHERE id=$2', [pdfPath, roa.id]);
      console.log(`✅ PDF: ${pdfPath}`);
    } catch (e) {
      console.error('❌ PDF error:', e.message);
    }

    // Kirim email ke R&D submitter
    if (pdfPath) {
      try {
        await sendRoaEmail({
          toEmail:    rdSubmitter.email,
          toName:     rdSubmitter.name,
          rdName:     rdSubmitter.name,
          sampleName: updatedRoa.sample_name,
          roaNumber:  updatedRoa.roa_number,
          approvedBy: req.user.name,
          pdfPath,
        });
        console.log(`✅ Email → ${rdSubmitter.email}`);
      } catch (e) {
        console.error('❌ Email error:', e.message);
      }
    }

    res.json({
      success:         true,
      pdfPath,
      approvedBy:      req.user.name,
      emailSentTo:     rdSubmitter.email,
      emailSentToName: rdSubmitter.name,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE RoA (Analyst only)
app.delete('/api/roa/:id', requireAuth, analystOnly, async (req, res) => {
  try {
    const roa = await db.get('SELECT * FROM roa_requests WHERE id = $1', [req.params.id]);
    if (!roa) return res.status(404).json({ error: 'Tidak ditemukan' });

    if (roa.pdf_path && fs.existsSync(roa.pdf_path)) fs.unlinkSync(roa.pdf_path);

    await db.run('DELETE FROM audit_trail   WHERE roa_id = $1', [roa.id]);
    await db.run('DELETE FROM roa_requests  WHERE id     = $1', [roa.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET download PDF
app.get('/api/roa/:id/pdf', requireAuth, async (req, res) => {
  try {
    const roa = await db.get('SELECT * FROM roa_requests WHERE id = $1', [req.params.id]);
    if (!roa) return res.status(404).json({ error: 'RoA tidak ditemukan' });
    if (roa.status !== 'approved') return res.status(400).json({ error: 'Hanya RoA yang sudah Approved' });

    let pdfPath = roa.pdf_path;

    // Regenerate jika file tidak ada
    if (!pdfPath || !fs.existsSync(pdfPath)) {
      const params  = typeof roa.parameters === 'string' ? JSON.parse(roa.parameters) : roa.parameters;
      const resData = typeof roa.results    === 'string' ? JSON.parse(roa.results)    : roa.results;

      pdfPath = await generateRoaPDF({ ...roa, parameters: params, results: resData });
      await db.run('UPDATE roa_requests SET pdf_path=$1 WHERE id=$2', [pdfPath, roa.id]);
    }

    const fileName = `${roa.roa_number.replace(/\//g,'_')}_Analysis_Testing_Report.pdf`;
    res.download(pdfPath, fileName);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Gagal generate PDF' });
  }
});

// ── Start server ──
app.listen(PORT, () => {
  console.log('\n====================================');
  console.log('  ⚗️  LabFlow Backend BERJALAN!');
  console.log('====================================');
  console.log(`  URL     : http://localhost:${PORT}`);
  console.log(`  Email   : ${process.env.EMAIL_USER || 'BELUM DISET'}`);
  console.log('====================================\n');
});
