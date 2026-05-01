/**
 * emailService.js — LabFlow
 * ══════════════════════════════════════════════════════════════
 * Kembali ke Gmail SMTP yang terbukti masuk Inbox.
 * Subject format: "RoA Result Ready - NOMOR/ROA/..."
 * (Format ini yang sebelumnya masuk Inbox — tidak diubah)
 * ══════════════════════════════════════════════════════════════
 */

const nodemailer = require('nodemailer');
const fs         = require('fs');

function createTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
}

async function sendRoaEmail({
  toEmail,
  toName,
  rdName,
  sampleName,
  roaNumber,
  approvedBy = 'Analyst',
  pdfPath,
}) {
  // ── Validasi ──
  if (!toEmail) throw new Error('toEmail kosong');
  if (!pdfPath || !fs.existsSync(pdfPath)) throw new Error(`PDF tidak ditemukan: ${pdfPath}`);

  const pdfStat = fs.statSync(pdfPath);
  if (pdfStat.size === 0) throw new Error(`PDF kosong: ${pdfPath}`);

  const transporter = createTransporter();

  // Verifikasi koneksi Gmail
  await transporter.verify().catch(e => {
    throw new Error(
      `Gmail SMTP gagal: ${e.message}\n` +
      `Pastikan EMAIL_USER dan EMAIL_PASS (App Password) sudah benar di .env`
    );
  });

  // ── Subject — format yang terbukti masuk Inbox ──
  const subject = `RoA Result Ready - ${roaNumber}`;

  // ── Nama file PDF ──
  const pdfFilename = `${roaNumber.replace(/\//g, '_')}_Analysis_Testing_Report.pdf`;

  const mailOptions = {
    from:    `"LabFlow - WIN Laboratory" <${process.env.EMAIL_USER}>`,
    to:      toEmail,
    subject,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">

        <div style="background:#0c1a35;padding:24px 28px;border-radius:8px 8px 0 0;">
          <h1 style="color:#ffffff;margin:0;font-size:20px;font-weight:700;">
            LabFlow
          </h1>
          <p style="color:rgba(255,255,255,.55);margin:5px 0 0;font-size:12px;">
            PT. Wahana Interfood Nusantara, Tbk.
          </p>
        </div>

        <div style="padding:28px 28px 20px;background:#ffffff;
                    border:1px solid #e5e7eb;border-top:none;">

          <p style="font-size:15px;color:#0c1a35;margin:0 0 12px;">
            Halo <strong>${rdName}</strong>,
          </p>

          <p style="font-size:14px;color:#374151;margin:0 0 18px;">
            Hasil analisa untuk sampel berikut telah selesai dan telah
            disetujui oleh tim laboratorium.
          </p>

          <div style="background:#f3f4f6;border-radius:8px;
                      padding:16px 18px;margin:0 0 18px;
                      border-left:4px solid #1a65f0;">
            <p style="margin:0 0 2px;font-size:11px;color:#6b7280;
                       text-transform:uppercase;letter-spacing:.05em;">RoA Number</p>
            <p style="margin:0 0 12px;font-size:15px;font-weight:700;
                       font-family:monospace;color:#0c1a35;">${roaNumber}</p>

            <p style="margin:0 0 2px;font-size:11px;color:#6b7280;
                       text-transform:uppercase;letter-spacing:.05em;">Sample Name</p>
            <p style="margin:0 0 12px;font-size:15px;font-weight:700;
                       color:#0c1a35;">${sampleName}</p>

            <p style="margin:0 0 2px;font-size:11px;color:#6b7280;
                       text-transform:uppercase;letter-spacing:.05em;">Approved By</p>
            <p style="margin:0;font-size:14px;font-weight:600;color:#065f46;">
              ${approvedBy}
            </p>
          </div>

          <p style="font-size:14px;color:#374151;margin:0 0 20px;">
            File <strong>Analysis Testing Report (PDF)</strong> terlampir
            pada email ini.
          </p>

          <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;">

          <p style="font-size:11.5px;color:#9ca3af;margin:0;">
            Email ini dikirim otomatis oleh sistem LabFlow.<br>
            Jika ada pertanyaan, hubungi tim laboratorium secara langsung.<br><br>
            <strong>PT. Wahana Interfood Nusantara, Tbk.</strong><br>
            Jalan Raya Parakan Muncang - Tanjungsari,
            Kab. Sumedang, Jawa Barat, 45365
          </p>
        </div>
      </div>
    `,
    attachments: [
      {
        filename:    pdfFilename,
        path:        pdfPath,
        contentType: 'application/pdf',
      },
    ],
  };

  const info = await transporter.sendMail(mailOptions);

  console.log(`\n✅ Email berhasil dikirim ke: ${toEmail} (${toName || rdName})`);
  console.log(`   Subject   : ${subject}`);
  console.log(`   MessageId : ${info.messageId}`);
  console.log(`   PDF       : ${pdfFilename} (${(pdfStat.size/1024).toFixed(1)} KB)\n`);

  return {
    messageId: info.messageId,
    accepted:  info.accepted  || [toEmail],
    rejected:  info.rejected  || [],
  };
}

module.exports = { sendRoaEmail };
