const mongoose = require('mongoose');

const moonPayPurchaseSchema = new mongoose.Schema(
  {
    walletPubkey: {
      type: String,
      required: true,
      index: true,
    },
    moonpayTransactionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    transactionStatus: {
      type: String,
      required: true,
      default: 'pending',
      index: true,
    },
    lockedAmountSats: {
      type: Number,
      required: true,
      min: 1,
      index: true,
    },
    estimatedSpendAmountCents: {
      type: Number,
      required: true,
      min: 1,
    },
    rewardAmountCents: {
      type: Number,
      required: true,
      min: 0,
    },
    consumedAt: {
      type: Date,
      default: null,
      index: true,
    },
    matchedClaimTxid: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

module.exports = mongoose.model('MoonPayPurchase', moonPayPurchaseSchema);
