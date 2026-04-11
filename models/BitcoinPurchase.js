// models/BitcoinPurchase.js
const mongoose = require("mongoose");

const bitcoinPurchaseSchema = new mongoose.Schema(
  {
    // Split canonical user id (wallet pubkey)
    walletPubkey: {
      type: String,
      required: true,
      index: true,
    },

    // On-chain txid from Stripe: session.transaction_details.transaction_id
    txid: {
      type: String,
      required: true,
      unique: true, // ensures idempotency on webhook retries
      index: true,
    },

    // USD value of the BTC purchase (in cents)
    spendAmountCents: {
      type: Number,
      required: true,
      min: 0,
    },

    // Reward credit amount (in cents) (e.g. 10% of spendAmountCents)
    rewardAmountCents: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false }, // only createdAt
    versionKey: false,
  }
);

module.exports = mongoose.model("BitcoinPurchase", bitcoinPurchaseSchema);
