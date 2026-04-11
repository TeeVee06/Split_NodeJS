const mongoose = require('mongoose');

const messagingDeviceRegistrationSchema = new mongoose.Schema(
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

    messagingPubkey: {
      type: String,
      required: true,
      index: true,
    },

    deviceToken: {
      type: String,
      required: true,
    },

    platform: {
      type: String,
      enum: ['apns', 'fcm'],
      required: true,
    },

    environment: {
      type: String,
      enum: ['dev', 'prod'],
      required: true,
      index: true,
    },

    registrationSignature: {
      type: String,
      required: true,
    },

    registrationSignatureVersion: {
      type: Number,
      required: true,
    },

    registrationSignedAt: {
      type: Date,
      required: true,
    },

    appVersion: {
      type: String,
      default: null,
    },

    bundleId: {
      type: String,
      default: null,
    },

    lastSeenAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true }
);

messagingDeviceRegistrationSchema.index(
  { environment: 1, deviceToken: 1 },
  { unique: true }
);
messagingDeviceRegistrationSchema.index({ userId: 1, messagingPubkey: 1, environment: 1, updatedAt: -1 });

module.exports = mongoose.model('MessagingDeviceRegistration', messagingDeviceRegistrationSchema);
