require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const iOSEndPoints = require('./routes/iOSEndPoints');
const MessageEndPoints = require('./routes/MessageEndPoints');
const POSFeedEndpoints = require('./routes/POSFeedEndpoints');
const StripeRoutes = require('./routes/StripeRoutes');

function createApp() {
  const app = express();
  const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';

  app.use(cors({
    origin: corsOrigin,
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type'],
  }));

  app.use(StripeRoutes);
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/', (_req, res) => {
    res.status(200).json({ ok: true, service: 'split-backend-public' });
  });

  app.use(iOSEndPoints);
  app.use(MessageEndPoints);
  app.use(POSFeedEndpoints);

  return app;
}

module.exports = {
  createApp,
};
