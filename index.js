import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { Telegraf, Markup, session } from 'telegraf';

const { BOT_TOKEN, TMAIL_API_URL, TMAIL_API_KEY, PORT = 3000 } = process.env;

if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN belum diisi di environment panel.');
}

const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

const api = axios.create({
  baseURL: TMAIL_API_URL || 'http://127.0.0.1:3001',
  timeout: 15000,
  headers: TMAIL_API_KEY ? { Authorization: `Bearer ${TMAIL_API_KEY}` } : {}
});

const mainMenu = Markup.inlineKeyboard([
  [Markup.button.callback('➕ Buat Email', 'create_email')],
  [Markup.button.callback('📥 Masukkan Email', 'access_email')],
  [Markup.button.callback('👤 Email Saya', 'my_emails')]
]);

function resetState(ctx) {
  ctx.session = { step: null, data: {} };
}

bot.start(async (ctx) => {
  resetState(ctx);
  await ctx.reply(
    '📮 Ryn TMail\n\nBuat email sementara atau masukkan email yang sudah ada untuk mengambil inbox/kode terbaru.',
    mainMenu
  );
});

bot.action('create_email', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { step: 'create_pin', data: {} };
  await ctx.reply('🔐 Masukkan PIN akses minimal 6 digit untuk email baru kamu.');
});

bot.action('access_email', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { step: 'access_email_address', data: {} };
  await ctx.reply('📧 Masukkan alamat email TMail yang ingin dibuka.');
});

bot.action('my_emails', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    const { data } = await api.get('/emails', { params: { telegram_id: String(ctx.from.id) } });
    const emails = Array.isArray(data?.emails) ? data.emails : [];
    if (!emails.length) return ctx.reply('Belum ada email yang tersimpan untuk akun Telegram ini.', mainMenu);
    await ctx.reply(`📮 Email kamu:\n\n${emails.map((x, i) => `${i + 1}. ${x.address || x.email || x}`).join('\n')}`, mainMenu);
  } catch (err) {
    await ctx.reply('Gagal mengambil daftar email. Pastikan backend TMail sudah tersambung.', mainMenu);
  }
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  const step = ctx.session?.step;

  if (!step) return;

  if (step === 'create_pin') {
    if (!/^\d{6,}$/.test(text)) {
      return ctx.reply('PIN harus berupa angka dan minimal 6 digit. Coba masukkan lagi.');
    }

    try {
      const { data } = await api.post('/emails/create', {
        telegram_id: String(ctx.from.id),
        pin: text
      });
      resetState(ctx);
      const address = data?.address || data?.email;
      if (!address) throw new Error('Alamat email tidak ditemukan pada response backend.');
      return ctx.reply(
        `✅ Email berhasil dibuat.\n\n📧 ${address}\n🔐 PIN: ${text}\n\nSimpan PIN ini. PIN diperlukan saat memakai fitur Masukkan Email.`,
        mainMenu
      );
    } catch (err) {
      return ctx.reply('Gagal membuat email. Backend TMail belum tersedia atau terjadi error.', mainMenu);
    }
  }

  if (step === 'access_email_address') {
    if (!text.includes('@')) return ctx.reply('Format email tidak valid. Masukkan alamat email lengkap.');
    ctx.session.data.email = text.toLowerCase();
    ctx.session.step = 'access_email_pin';
    return ctx.reply('🔐 Sekarang masukkan PIN akses email tersebut.');
  }

  if (step === 'access_email_pin') {
    if (!/^\d{6,}$/.test(text)) return ctx.reply('PIN minimal 6 digit angka. Coba lagi.');

    const email = ctx.session.data.email;
    try {
      const { data } = await api.post('/emails/access', {
        email,
        pin: text,
        telegram_id: String(ctx.from.id)
      });

      resetState(ctx);
      const messages = Array.isArray(data?.messages) ? data.messages : [];
      if (!messages.length) {
        return ctx.reply(`✅ Akses berhasil untuk ${email}.\n\n📭 Belum ada pesan masuk.`, Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Ambil Kode Ulang', `refresh:${email}`)],
          [Markup.button.callback('🏠 Menu', 'menu')]
        ]));
      }

      const latest = messages[0];
      const otp = latest.otp || latest.code || '-';
      const sender = latest.from || latest.sender || '-';
      const subject = latest.subject || '-';
      const body = latest.text || latest.body || '';
      return ctx.reply(
        `📨 Pesan terbaru\n\n📧 Email: ${email}\n👤 Dari: ${sender}\n📝 Subjek: ${subject}\n🔑 Kode: ${otp}\n\n${body}`.slice(0, 3900),
        Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Ambil Kode Ulang', `refresh:${email}`)],
          [Markup.button.callback('🏠 Menu', 'menu')]
        ])
      );
    } catch (err) {
      return ctx.reply('❌ Email atau PIN salah, atau backend TMail sedang tidak tersedia. Coba lagi.', mainMenu);
    }
  }
});

bot.action(/^refresh:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const email = ctx.match[1];
  ctx.session = { step: 'refresh_pin', data: { email } };
  await ctx.reply(`🔐 Masukkan PIN untuk mengambil kode terbaru dari ${email}.`);
});

bot.action('menu', async (ctx) => {
  await ctx.answerCbQuery();
  resetState(ctx);
  await ctx.reply('Pilih menu:', mainMenu);
});

bot.on('text', async (ctx, next) => {
  if (ctx.session?.step !== 'refresh_pin') return next();
  const pin = ctx.message.text.trim();
  if (!/^\d{6,}$/.test(pin)) return ctx.reply('PIN minimal 6 digit angka.');

  const email = ctx.session.data.email;
  try {
    const { data } = await api.post('/emails/access', {
      email,
      pin,
      telegram_id: String(ctx.from.id)
    });
    resetState(ctx);
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const latest = messages[0];
    if (!latest) return ctx.reply('📭 Belum ada pesan baru.', mainMenu);
    const otp = latest.otp || latest.code || '-';
    return ctx.reply(`🔑 Kode terbaru untuk ${email}:\n\n${otp}`, mainMenu);
  } catch {
    return ctx.reply('❌ PIN salah atau inbox gagal diambil.', mainMenu);
  }
});

bot.catch((err) => console.error('Telegram bot error:', err));

const app = express();
app.get('/', (_, res) => res.send('Ryn TMail Telegram Bot is running'));
app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Health server aktif di port ${PORT}`));
bot.launch().then(() => console.log('Ryn TMail bot aktif'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
