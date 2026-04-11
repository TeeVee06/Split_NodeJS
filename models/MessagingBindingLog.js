const mongoose = require('mongoose');

const messagingBindingLogSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    walletPubkey: {
      type: String,
      required: true,
      index: true,
    },

    lightningAddress: {
      type: String,
      required: true,
      index: true,
    },

    messagingPubkey: {
      type: String,
      required: true,
    },

    messagingIdentitySignature: {
      type: String,
      required: true,
    },

    messagingIdentitySignatureVersion: {
      type: Number,
      required: true,
      default: 2,
    },

    messagingIdentitySignedAt: {
      type: Date,
      required: true,
      index: true,
    },

    leafIndex: {
      type: Number,
      required: true,
      unique: true,
      index: true,
    },

    leafHash: {
      type: String,
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

messagingBindingLogSchema.index({ walletPubkey: 1, messagingIdentitySignedAt: -1, leafIndex: -1 });
messagingBindingLogSchema.index({ lightningAddress: 1, messagingIdentitySignedAt: -1, leafIndex: -1 });

module.exports = mongoose.model('MessagingBindingLog', messagingBindingLogSchema);
