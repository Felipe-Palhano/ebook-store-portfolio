# NOTA1000 E-book Store

A complete e-commerce site that sells digital study guides for ENEM, Brazil's national university entrance exam. Customers pay through Mercado Pago and automatically receive a private, time-limited download link by e-mail as soon as the payment is confirmed.

**Live site:** [nota1000.onrender.com](https://nota1000.onrender.com)

![Screenshot of the store](docs/screenshot.jpg)

## Features

- Mobile-first landing page, built for traffic coming from social media ads
- Mercado Pago Checkout Pro integration (Pix, card and boleto)
- Product selection with a bundle price for buying both e-books
- Webhook that confirms each payment on the server before releasing the product
- Automated e-mail delivery of signed download links that expire after 15 days
- Google Analytics 4 tracking, privacy policy and terms of use pages

## How it works

1. The customer picks one or both e-books, enters an e-mail and clicks **Buy**.
2. The server calculates the price itself (never trusting the page) and creates a payment preference through the Mercado Pago API.
3. When the payment is approved, Mercado Pago notifies the `/webhook` endpoint.
4. The server checks the notification signature, confirms the payment status and amount through the API, and e-mails the download links.
5. Each download re-checks the payment, so refunded or cancelled orders lose access.

## Security and reliability

- **Webhook signature check** (HMAC-SHA256 with a timing-safe comparison), so only genuine Mercado Pago notifications are accepted
- **Signed download tokens** (HMAC) that carry the order and expiry date, with no database lookup needed
- **Rate limiting per IP** on checkout and download routes
- **Security headers** (HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy)
- **E-mail retries** with an alert to the store owner, including ready-to-send links, if delivery still fails
- **Duplicate protection** so each payment triggers only one delivery

## Tech stack

- **Server:** Node.js, Express
- **Payments:** Mercado Pago SDK (Preferences and Payments APIs), webhooks
- **E-mail:** Nodemailer (SMTP)
- **Analytics:** Google Analytics 4
- **Hosting and versioning:** Render, Git/GitHub
- **Testing:** Postman

## Running locally

```bash
git clone https://github.com/Felipe-Palhano/ebook-store-portfolio.git
cd ebook-store-portfolio
npm install
cp .env.example .env   # add your own Mercado Pago and e-mail credentials
npm start              # http://localhost:3000
```

Put your PDF files inside `private/` with the names set in `.env`. The webhook needs a public address, so for local tests run `ngrok http 3000` and use that link as `BASE_URL`.

## Built with AI assistance

I built this project by directing AI coding assistants (Claude and ChatGPT), then reviewing, testing and debugging each step myself. That included fixing production issues such as API authorization errors and e-mail ports blocked by the hosting provider.

## Note

This is a portfolio copy of the live store. The e-book files, the author's photo, customer data and all credentials are not included.
