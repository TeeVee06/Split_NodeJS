// platformAnalytics.js
const mongoose = require("mongoose");

const PlatformAnalyticsSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: 'platform',
      immutable: true,
    },

    transactions: {
      type: Number,
      required: true,
      default: 0,
    },

    transactionVolume: {
      btcSats: {
        type: Number,
        required: true,
        default: 0,
      },
      usdCents: {
        type: Number,
        required: true,
        default: 0,
      },
    },

    merchantTransactions: {
      type: Number,
      required: true,
      default: 0,
    },

    merchantVolume: {
      btcSats: {
        type: Number,
        required: true,
        default: 0,
      },
      usdCents: {
        type: Number,
        required: true,
        default: 0,
      },
    },

    // Total sats successfully paid out to users via the rewards program.
    // Increment this only after a payout is confirmed (idempotently) to avoid double counting.
    satsRewarded: {
      type: Number,
      required: true,
      default: 0,
    },
  },
);

module.exports = mongoose.model("PlatformAnalytics", PlatformAnalyticsSchema);
