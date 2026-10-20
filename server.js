require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const E = process.env;
const mp = new MercadoPagoConfig({ accessToken: E.MP_ACCESS_TOKEN });
const mailer = nodemailer.createTransport({
  host: E.SMTP_HOST, port: Number(E.SMTP_PORT || 587),
  auth: { user: E.SMTP_USER, pass: E.SMTP_PASS },
});

// Catálogo de e-books (o arquivo de cada um fica na pasta /private)
const PRODUCTS = {
  redacao:    { title: E.EBOOK_TITLE || 'E-book Redação ENEM',    file: E.EBOOK_FILE || 'nota1000.pdf' },
  matematica: { title: E.MATH_TITLE  || 'E-book Matemática ENEM', file: E.MATH_FILE  || 'matematica.pdf' },
};
// 1 e-book = PRICE; 2 e-books = PRICE_BUNDLE
const PRICE_ONE = Number(E.PRICE || 14.99);
const PRICE_TWO = Number(E.PRICE_BUNDLE || 24.99);
const priceFor = (n) => (n >= 2 ? PRICE_TWO : PRICE_ONE);
const fileOf = (k) => path.join(__dirname, 'private', PRODUCTS[k].file);
const available = (k) => fs.existsSync(fileOf(k));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // atrás do Render: pega o IP real do visitante

// Cabeçalhos de segurança básicos (sem CSP restrito, para não quebrar Analytics/Mercado Pago)
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=15552000',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});

// Limite de tentativas por IP (em memória): segura abuso sem precisar instalar nada
const hits = new Map();
const limit = (name, max, windowMs) => (req, res, next) => {
  const key = `${name}:${req.ip}`;
  const now = Date.now();
  const h = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (h.length >= max) return res.status(429).json({ error: 'Muitas tentativas. Aguarde um pouco e tente de novo.' });
  h.push(now);
  hits.set(key, h);
  next();
};
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Registro simples de pedidos entregues (evita e-mail duplicado)
const ORDERS = path.join(__dirname, 'orders.json');
const readOrders = () => (fs.existsSync(ORDERS) ? JSON.parse(fs.readFileSync(ORDERS)) : {});
const saveOrders = (o) => fs.writeFileSync(ORDERS, JSON.stringify(o, null, 2));

// Link de download assinado (vale para um e-book, expira em 15 dias)
const sign = (p) => crypto.createHmac('sha256', E.TOKEN_SECRET).update(p).digest('base64url');
const makeToken = (id, item) => {
  const p = Buffer.from(JSON.stringify({ id, it: item, exp: Date.now() + 15 * 864e5 })).toString('base64url');
  return `${p}.${sign(p)}`;
};
const readToken = (t = '') => {
  const [p, s] = t.split('.');
  if (!p || !s || s.length !== sign(p).length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(sign(p)))) return null;
  const d = JSON.parse(Buffer.from(p, 'base64url'));
  return d.exp > Date.now() ? d : null;
};

// E-mail do comprador: vem do formulário do nosso site (o do Mercado Pago pode chegar mascarado)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cleanEmail = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const okEmail = (e) => !!e && e.length <= 120 && EMAIL_RE.test(e) && !e.includes('|') && !e.includes(',');
const mask = (e) => (e && e.includes('@') ? e.replace(/^(.{1,2}).*(@.*)$/, '$1***$2') : e ? '(sem @)' : '(vazio)');

// 1) Cria o pagamento com os e-books escolhidos; o preço é calculado aqui, nunca na página
app.post('/checkout', limit('checkout', 10, 10 * 60e3), async (req, res) => {
  try {
    const asked = Array.isArray(req.body.items) ? req.body.items : [];
    const items = [...new Set(asked)].filter((k) => PRODUCTS[k]);
    if (!items.length) return res.status(400).json({ error: 'Escolha pelo menos um e-book.' });
    if (items.some((k) => !available(k))) return res.status(400).json({ error: 'Este e-book ainda não está disponível.' });
    const email = cleanEmail(req.body.email);
    if (!okEmail(email)) return res.status(400).json({ error: 'Digite um e-mail válido para receber o link.' });

    const pref = await new Preference(mp).create({
      body: {
        items: [{
          id: items.join('-'),
          title: items.map((k) => PRODUCTS[k].title).join(' + '),
          quantity: 1, unit_price: priceFor(items.length), currency_id: 'BRL',
        }],
        payer: { email },
        external_reference: `${items.join(',')}|${email}`,
        back_urls: { success: `${E.BASE_URL}/obrigado.html`, pending: `${E.BASE_URL}/obrigado.html`, failure: `${E.BASE_URL}/` },
        auto_return: 'approved',
        notification_url: `${E.BASE_URL}/webhook`,
      },
    });
    res.json({ url: pref.init_point });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Não foi possível iniciar o pagamento. Tente de novo.' });
  }
});

// Confere que a notificação veio mesmo do Mercado Pago
function validSignature(req) {
  if (!E.MP_WEBHOOK_SECRET) return false; // sem a chave secreta, ninguém é aceito
  const sig = req.get('x-signature');
  const id = req.query['data.id'];
  if (!sig || !id) return false;
  const parts = Object.fromEntries(sig.split(',').map((s) => s.trim().split('=')));
  const manifest = `id:${String(id).toLowerCase()};request-id:${req.get('x-request-id')};ts:${parts.ts};`;
  const h = crypto.createHmac('sha256', E.MP_WEBHOOK_SECRET).update(manifest).digest('hex');
  return !!parts.v1 && h.length === parts.v1.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(parts.v1));
}

// 2) Mercado Pago avisa aqui; se aprovado, envia o(s) link(s) por e-mail
app.post('/webhook', async (req, res) => {
  if (!validSignature(req)) return res.sendStatus(401);
  res.sendStatus(200);
  try {
    if (req.body.type !== 'payment') return;
    const id = String(req.query['data.id']);
    const orders = readOrders();
    if (orders[id]) return;
    const pay = await new Payment(mp).get({ id }); // consulta o status real na API
    if (pay.status !== 'approved') return;

    const [itemsPart, refEmail] = String(pay.external_reference || '').split('|');
    const items = itemsPart.split(',').filter((k) => PRODUCTS[k]);
    if (!items.length) return console.error('Pagamento sem produto:', id);
    if (pay.transaction_amount < priceFor(items.length)) return console.error('Valor menor que o esperado:', id);
    // O e-mail vem do pedido (formulário do site); o do pagador do Mercado Pago só entra como reserva
    const fromForm = cleanEmail(refEmail);
    const fromPayer = cleanEmail(pay.payer && pay.payer.email);
    const email = okEmail(fromForm) ? fromForm : okEmail(fromPayer) ? fromPayer : '';
    console.log('Pagamento aprovado', id, '| e-mail:', mask(email), '| origem:', okEmail(fromForm) ? 'formulário' : 'Mercado Pago', '| itens:', items.join(','));
    if (!email) return console.error('Sem e-mail válido no pedido:', id, '| e-mail do pagador:', mask(fromPayer));

    const links = items
      .map((k) => `<li><a href="${E.BASE_URL}/download/${makeToken(id, k)}">${PRODUCTS[k].title}</a></li>`)
      .join('');
    const msg = {
      from: E.MAIL_FROM, to: email,
      subject: items.length > 1 ? 'Seus e-books chegaram' : `Seu acesso: ${PRODUCTS[items[0]].title}`,
      html: `<p>Pagamento confirmado. Obrigado pela compra!</p>
             <p>Baixe ${items.length > 1 ? 'seus e-books' : 'seu e-book'}:</p>
             <ul>${links}</ul>
             <p>Os links valem por 15 dias. Se expirarem, responda este e-mail que enviamos outros.</p>`,
    };
    // Tenta 3 vezes; se falhar, avisa o dono da loja com os dados para reenviar na mão
    let sent = false, lastErr;
    for (let i = 0; i < 3 && !sent; i++) {
      try { await mailer.sendMail(msg); sent = true; }
      catch (err) { lastErr = err; console.error(`Falha ao enviar e-mail (tentativa ${i + 1}):`, err.message); await new Promise((r) => setTimeout(r, 3000 * (i + 1))); }
    }
    if (!sent) {
      console.error('ENTREGA FALHOU:', id, email, items.join(','));
      try {
        await mailer.sendMail({
          from: E.MAIL_FROM, to: E.ALERT_EMAIL || E.SMTP_USER,
          subject: `⚠ Entrega falhou - pagamento ${id}`,
          text: `Não consegui enviar o e-book para ${email}.\nPagamento: ${id}\nItens: ${items.join(', ')}\nErro: ${lastErr && lastErr.message}\n\nLinks para reenviar manualmente:\n` +
            items.map((k) => `${PRODUCTS[k].title}: ${E.BASE_URL}/download/${makeToken(id, k)}`).join('\n'),
        });
      } catch (err2) { console.error('Nem o alerta saiu:', err2.message); }
      return;
    }
    orders[id] = { email, items, at: new Date().toISOString() };
    saveOrders(orders);
  } catch (e) {
    console.error(e);
  }
});

// Confere no Mercado Pago se o pagamento continua aprovado (cancelado/estornado bloqueia o link)
const statusCache = new Map(); // id -> { ok, at }
async function stillPaid(id) {
  const c = statusCache.get(id);
  if (c && Date.now() - c.at < 60e3) return c.ok;
  const pay = await new Payment(mp).get({ id });
  const ok = pay.status === 'approved';
  statusCache.set(id, { ok, at: Date.now() });
  return ok;
}

// 3) Download protegido
app.get('/download/:token', limit('download', 30, 10 * 60e3), async (req, res) => {
  let d;
  try { d = readToken(req.params.token); } catch { d = null; }
  if (!d) return res.status(410).send('Link inválido ou expirado.');
  try {
    if (!(await stillPaid(String(d.id)))) return res.status(403).send('Este pagamento foi cancelado ou estornado, por isso o link foi bloqueado.');
  } catch (e) {
    console.error('Não consegui conferir o pagamento', d.id, e.message);
    return res.status(503).send('Não foi possível confirmar o pagamento agora. Tente de novo em instantes.');
  }
  const k = PRODUCTS[d.it] ? d.it : 'redacao';
  res.download(fileOf(k), PRODUCTS[k].file);
});

app.listen(process.env.PORT || 3000, () => console.log('Rodando em http://localhost:3000'));
