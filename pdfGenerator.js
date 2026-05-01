/**
 * pdfGenerator.js — LabFlow
 * ══════════════════════════════════════════════════════════════
 * Mengisi data ke dalam template PDF asli FRM.QM.40
 * menggunakan pendekatan overlay (BUKAN generate PDF baru).
 *
 * Cara kerja:
 *   1. Load template PDF asli (ROA-template.pdf)
 *   2. Overlay teks di atas koordinat yang sudah dipetakan
 *   3. Simpan sebagai file baru → dikirim via email
 *
 * Koordinat diambil langsung dari template menggunakan pdfplumber.
 * pdfplumber  → origin kiri atas (top dari atas)
 * pdf-lib     → origin kiri bawah (y dari bawah)
 * Konversi: yPdfLib = pageH - topY - cellH/2 - fontSize/2
 * ══════════════════════════════════════════════════════════════
 */

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fs   = require('fs');
const path = require('path');

// ── Path template PDF asli ──
const TEMPLATE_PATH = path.join(__dirname, 'ROA-template.pdf');

// ── Ukuran halaman template (dari pdfplumber) ──
const PAGE_H = 842.04;

// ── Warna ──
const BLACK      = rgb(0,    0,    0);
const WHITE      = rgb(1,    1,    1);

// ── Font sizes ──
const FS = 8.5;

// ════════════════════════════════════════════════════════
//   KONVERSI KOORDINAT
//   pdfplumber: top  = jarak dari atas halaman
//   pdf-lib:    y    = jarak dari bawah halaman
// ════════════════════════════════════════════════════════
function toY(topY, cellH, fs, pageH = PAGE_H) {
  // Posisi vertikal tengah cell
  return pageH - topY - (cellH / 2) - (fs / 2) + 1;
}

// ════════════════════════════════════════════════════════
//   HELPER TULIS TEKS
// ════════════════════════════════════════════════════════

// Teks rata kiri dalam cell
function drawLeft(page, font, text, x0, topY, cellH, fs = FS, padL = 4) {
  const str = String(text || '').trim();
  if (!str) return;
  page.drawText(str, {
    x: x0 + padL,
    y: toY(topY, cellH, fs),
    font, size: fs, color: BLACK,
  });
}

// Teks rata tengah horizontal dalam cell
function drawCenter(page, font, text, x0, x1, topY, cellH, fs = FS) {
  const str = String(text || '').trim();
  if (!str) return;
  const tw = font.widthOfTextAtSize(str, fs);
  const cx = x0 + (x1 - x0 - tw) / 2;
  page.drawText(str, {
    x: cx,
    y: toY(topY, cellH, fs),
    font, size: fs, color: BLACK,
  });
}

// Teks di koordinat absolut (y dari bawah — pdf-lib native)
function drawAbs(page, font, text, x, yFromBottom, fs = FS) {
  const str = String(text || '').trim();
  if (!str) return;
  page.drawText(str, { x, y: yFromBottom, font, size: fs, color: BLACK });
}

// Kotak putih untuk menutup teks lama di template
function whiteOut(page, x, yFromBottom, w, h) {
  page.drawRectangle({ x, y: yFromBottom, width: w, height: h, color: WHITE });
}


// ════════════════════════════════════════════════════════
//   FORMAT TANGGAL INDONESIA
// ════════════════════════════════════════════════════════
function fmtDateID(d) {
  if (!d) return '';
  const BULAN = [
    'Januari','Februari','Maret','April','Mei','Juni',
    'Juli','Agustus','September','Oktober','November','Desember',
  ];
  const dt = new Date(d + 'T00:00:00Z');
  return `${dt.getUTCDate()} ${BULAN[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

// ════════════════════════════════════════════════════════
//   KOORDINAT TEPAT — diverifikasi dari pdfplumber
//   Semua nilai "top" & "bottom" = koordinat pdfplumber
//   (jarak dari atas halaman dalam points)
// ════════════════════════════════════════════════════════

// Kolom Result & Standard (sama untuk semua tabel analisa)
const COL_RES = { x0: 297.8, x1: 444.7 };
const COL_STD = { x0: 444.7, x1: 591.5 };

// ── Identitas Sample (Table 2, Page 1) ──
// x0 = posisi x mulai teks (setelah label + titik dua)
const ID = {
  tanggal_sampling: { x0: 121, top: 78.8,  cellH: 18.9 },
  tanggal_analisa:  { x0: 413, top: 78.8,  cellH: 18.9 },
  pic_sampling:     { x0: 121, top: 97.7,  cellH: 18.8 },
  pic_analis:       { x0: 413, top: 97.7,  cellH: 18.8 },
  produk:           { x0: 121, top: 116.5, cellH: 18.9 },
  bn_exp:           { x0: 413, top: 116.5, cellH: 18.9 },
};

// ── Kimia (Table 4, Page 1) ──
const KIMIA = [
  { en: 'Moisture Content',  top: 311.1, cellH: 18.8 },
  { en: 'Total Fat Content', top: 329.9, cellH: 18.9 },
  { en: 'POV',               top: 348.8, cellH: 18.8 },
  { en: 'FFA',               top: 367.6, cellH: 18.9 },
  { en: 'pH',                top: 386.5, cellH: 18.8 },
  { en: 'Brix',              top: 405.3, cellH: 19.0 },
];

// ── Fisik (Table 5, Page 1) ──
const FISIK = [
  { en: 'Viscosity', top: 464.9, cellH: 19.0 },
  { en: 'Fineness',  top: 483.9, cellH: 18.8 },
];

// ── Mikrobiologi (Table 1, Page 2) ──
// null = Heavy Metal → tidak diisi (row static di template)
const MIKRO = [
  { en: 'Total Plate Count',  top: 33.8,  cellH: 18.9 },
  { en: 'Yeast',              top: 52.7,  cellH: 18.8 },
  { en: 'Mold',               top: 71.5,  cellH: 18.9 },
  { en: null,                 top: 90.4,  cellH: 70.8 }, // Heavy Metal — skip
  { en: 'Coliform',           top: 161.2, cellH: 18.8 },
  { en: 'Escherichia coli',   top: 180.0, cellH: 18.9 },
  { en: 'Salmonella sp',      top: 198.9, cellH: 18.8 },
  { en: 'Enterobacteriaceae', top: 217.7, cellH: 18.8 },
];

// ══════════════════════════════════════════════════════════════
//   FUNGSI UTAMA GENERATE PDF
// ══════════════════════════════════════════════════════════════
async function generateRoaPDF(roaData) {

  // ── Validasi template ──
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(
      `\n❌ File template tidak ditemukan!\n` +
      `   Path: ${TEMPLATE_PATH}\n` +
      `   Pastikan file ROA-template.pdf ada di folder backend.\n`
    );
  }

  // ── 1. Load template PDF ──
  const templateBytes = fs.readFileSync(TEMPLATE_PATH);
  const pdfDoc        = await PDFDocument.load(templateBytes);

  // ── 2. Embed font ──
  const font  = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // ── 3. Ambil halaman ──
  const pages = pdfDoc.getPages();
  const page1 = pages[0];
  const page2 = pages[1];

  // ── 4. Parse data ──
  const results = typeof roaData.results    === 'string'
    ? JSON.parse(roaData.results)    : (roaData.results    || {});
  const params  = typeof roaData.parameters === 'string'
    ? JSON.parse(roaData.parameters) : (roaData.parameters || []);

  // ── 5. Format BN/EXP ──
  const bnExp = [
    roaData.batch_number,
    roaData.best_before ? fmtDateID(roaData.best_before) : null,
  ].filter(Boolean).join(' / ');

  // ══════════════════════════════════════════════
  //   HALAMAN 1
  // ══════════════════════════════════════════════

  // ── Identitas Sample ──
  drawLeft(page1, font, fmtDateID(roaData.submission_date),
    ID.tanggal_sampling.x0, ID.tanggal_sampling.top, ID.tanggal_sampling.cellH);

  drawLeft(page1, font, fmtDateID(roaData.analysis_date),
    ID.tanggal_analisa.x0, ID.tanggal_analisa.top, ID.tanggal_analisa.cellH);

  drawLeft(page1, font, roaData.rd_name || '',
    ID.pic_sampling.x0, ID.pic_sampling.top, ID.pic_sampling.cellH);

  drawLeft(page1, font, roaData.analyst_name || '',
    ID.pic_analis.x0, ID.pic_analis.top, ID.pic_analis.cellH);

  drawLeft(page1, font, roaData.sample_name || '',
    ID.produk.x0, ID.produk.top, ID.produk.cellH);

  drawLeft(page1, font, bnExp,
    ID.bn_exp.x0, ID.bn_exp.top, ID.bn_exp.cellH);

  // ── Hasil Analisa Kimia ──
  for (const row of KIMIA) {
    if (!params.includes(row.en)) continue;
    const res = results[row.en] || {};
    drawCenter(page1, font, res.result   || '',
      COL_RES.x0, COL_RES.x1, row.top, row.cellH);
    drawCenter(page1, font, res.standard || '',
      COL_STD.x0, COL_STD.x1, row.top, row.cellH);
  }

  // ── Hasil Analisa Fisik ──
  for (const row of FISIK) {
    if (!params.includes(row.en)) continue;
    const res = results[row.en] || {};
    drawCenter(page1, font, res.result   || '',
      COL_RES.x0, COL_RES.x1, row.top, row.cellH);
    drawCenter(page1, font, res.standard || '',
      COL_STD.x0, COL_STD.x1, row.top, row.cellH);
  }

  // ══════════════════════════════════════════════
  //   HALAMAN 2
  // ══════════════════════════════════════════════

  // ── Hasil Analisa Mikrobiologi ──
  for (const row of MIKRO) {
    if (!row.en) continue;                   // Heavy Metal — skip
    if (!params.includes(row.en)) continue;  // Tidak dipilih — skip
    const res = results[row.en] || {};
    drawCenter(page2, font, res.result   || '',
      COL_RES.x0, COL_RES.x1, row.top, row.cellH);
    drawCenter(page2, font, res.standard || '',
      COL_STD.x0, COL_STD.x1, row.top, row.cellH);
  }

  // ── Signature ──
  // Nama analyst TIDAK ditambahkan — biarkan area QR code bersih
  // sesuai template asli. Hanya tanggal approve yang diupdate.

  // ── Tanggal approve — ganti placeholder di template ──
  if (roaData.approved_date) {
    const dateStr = roaData.approved_date;

    // "Date: 2026-04-20" di template ada di top≈333.9, y_pdfl ≈ PAGE_H-342 = 500
    // Tutup teks lama dengan kotak putih lalu tulis baru
    const dateY = PAGE_H - 343;

    // Kiri: x≈30
    whiteOut(page2, 28, dateY - 1, 70, 12);
    drawAbs(page2, font, dateStr, 30, dateY, FS);

    // Kanan: x≈436
    whiteOut(page2, 434, dateY - 1, 70, 12);
    drawAbs(page2, font, dateStr, 436, dateY, FS);
  }

  // ══════════════════════════════════════════════
  //   SIMPAN FILE PDF
  // ══════════════════════════════════════════════
  const pdfBytes = await pdfDoc.save();

  const pdfDir = path.join(__dirname, 'pdfs');
  if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });

  const safeNum  = (roaData.roa_number || 'RoA').replace(/\//g, '_');
  const fileName = `RoA_${safeNum}.pdf`;
  const filePath = path.join(pdfDir, fileName);

  fs.writeFileSync(filePath, pdfBytes);
  console.log(`✅ PDF berhasil dibuat dari template: ${filePath}`);

  return filePath;
}

module.exports = { generateRoaPDF };
