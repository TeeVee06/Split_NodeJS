const mongoose = require('mongoose');

const messageAttachmentSchema = new mongoose.Schema(
  {
    senderUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    recipientUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    recipientLightningAddress: {
      type: String,
      required: true,
      index: true,
    },

    objectKey: {
      type: String,
      required: true,
      unique: true,
    },

    uploadContentType: {
      type: String,
      default: 'application/octet-stream',
    },

    sizeBytes: {
      type: Number,
      required: true,
      min: 1,
    },

    status: {
      type: String,
      required: true,
      default: 'uploaded',
      enum: ['uploaded', 'linked', 'received', 'deleted', 'expired'],
      index: true,
    },

    linkedMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DirectMessage',
      default: null,
      index: true,
    },

    linkedClientMessageId: {
      type: String,
      default: null,
    },

    receivedAt: {
      type: Date,
      default: null,
    },

    deletedAt: {
      type: Date,
      default: null,
    },

    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

messageAttachmentSchema.index({ senderUserId: 1, recipientUserId: 1, status: 1, createdAt: 1 });

module.exports = mongoose.model('MessageAttachment', messageAttachmentSchema);
