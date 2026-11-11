'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const ROOT = __dirname;

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Health check for Render.
app.get('/health', (_req, res) => res.status(200).json({ ok: true, service: 'spl-admin' }));

// The supplied frontend calls these APIs. They intentionally fail closed until
// the original backend/payment-provider implementation and credentials are supplied.
app.post('/api/register', (_req, res) => {
  res.status(503).json({
    message: 'Registration API is not configured. Restore the original backend before accepting registrations.'
  });
});

app.post('/api/nekpay/collect', (_req, res) => {
  res.status(503).json({
    message: 'Payment gateway is not configured. Add the verified NEKpay server integration before accepting payments.'
  });
});

app.use(express.static(ROOT, {
  index: 'index.html',
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ message: 'API route not found' });
  const indexFile = path.join(ROOT, 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  next();
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`SPL server listening on ${PORT}`);
});
