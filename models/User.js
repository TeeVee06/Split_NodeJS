const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    // 🔑 canonical identity
    walletPubkey: {
      type: String,
      required: true,
      unique: true,
      index: true,
      immutable: true,
    },

    sparkAddress: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },

    lightningAddress: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },

    profilePicUrl: {
      type: String,
      default: null,
    },

    messagingPubkey: {
      type: String,
      default: null,
      index: true,
    },

    messagingPubkeyV2: {
      type: String,
      default: null,
      index: true,
    },

    messagingKeySignature: {
      type: String,
      default: null,
    },

    messagingKeySignatureVersion: {
      type: Number,
      default: null,
    },

    messagingKeySignedAt: {
      type: Date,
      default: null,
    },

    messagingKeyUpdatedAt: {
      type: Date,
      default: null,
    },

    // During the signed-identity migration we keep the old messaging-key-only
    // proof fields above and add the new bundle proof fields below.
    messagingIdentitySignature: {
      type: String,
      default: null,
    },

    messagingIdentitySignatureVersion: {
      type: Number,
      default: null,
    },

    messagingIdentitySignedAt: {
      type: Date,
      default: null,
    },

    messagingIdentityUpdatedAt: {
      type: Date,
      default: null,
    },

    messagingIdentityV2Signature: {
      type: String,
      default: null,
    },

    messagingIdentityV2SignatureVersion: {
      type: Number,
      default: null,
    },

    messagingIdentityV2SignedAt: {
      type: Date,
      default: null,
    },

    messagingIdentityV2UpdatedAt: {
      type: Date,
      default: null,
    },

    accountCreatedDate: {
      type: Date,
      default: Date.now,
    },

    lastLoginDate: {
      type: Date,
    },

    lifetimeMerchantSpendCents: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
