const mongoose = require('mongoose');

const directMessageSchema = new mongoose.Schema(
  {
    senderUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    senderWalletPubkey: {
      type: String,
      required: true,
      index: true,
    },

    senderMessagingPubkey: {
      type: String,
      required: true,
    },

    senderLightningAddress: {
      type: String,
      default: null,
      index: true,
    },

    senderMessagingIdentitySignature: {
      type: String,
      default: null,
    },

    senderMessagingIdentitySignatureVersion: {
      type: Number,
      default: null,
    },

    senderMessagingIdentitySignedAt: {
      type: Date,
      default: null,
    },

    senderEnvelopeSignature: {
      type: String,
      default: null,
    },

    senderEnvelopeSignatureVersion: {
      type: Number,
      default: null,
    },

    recipientUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    recipientWalletPubkey: {
      type: String,
      required: true,
      index: true,
    },

    recipientLightningAddress: {
      type: String,
      required: true,
      index: true,
    },

    recipientMessagingPubkey: {
      type: String,
      required: true,
      index: true,
    },

    clientMessageId: {
      type: String,
      required: true,
    },

    messageType: {
      type: String,
      default: 'text',
      enum: ['text', 'payment_request', 'payment_request_paid', 'attachment', 'reaction'],
    },

    status: {
      type: String,
      required: true,
      default: 'pending',
      enum: [
        'pending',
        'delivered',
        'rekey_required',
        'same_key_retry_required',
        'failed_same_key',
        'undelivered',
      ],
      index: true,
    },

    sameKeyRetryCount: {
      type: Number,
      default: 0,
    },

    envelopeVersion: {
      type: Number,
      default: 1,
    },

    ciphertext: {
      type: String,
      default: null,
    },

    nonce: {
      type: String,
      default: null,
    },

    senderEphemeralPubkey: {
      type: String,
      default: null,
    },

    createdAtClient: {
      type: Date,
      default: null,
    },

    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },

    deliveredAt: {
      type: Date,
      default: null,
    },

    rekeyRequiredAt: {
      type: Date,
      default: null,
    },

    sameKeyDecryptFailedAt: {
      type: Date,
      default: null,
    },

    failedAt: {
      type: Date,
      default: null,
    },

    expiredAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

directMessageSchema.index({ senderUserId: 1, clientMessageId: 1 }, { unique: true });
directMessageSchema.index({ recipientUserId: 1, recipientMessagingPubkey: 1, status: 1, createdAt: 1 });

module.exports = mongoose.model('DirectMessage', directMessageSchema);
