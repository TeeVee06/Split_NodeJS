require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const { PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const router = express.Router();

const s3Client = require('../integrations/r2');
const User = require('../models/User');
const UserBlock = require('../models/UserBlock');
const POSFeedPost = require('../models/POSFeedPost');
const POSFeedPostReport = require('../models/POSFeedPostReport');
const userAuthMiddleware = require('../middlewares/userAuthMiddleware');

const ANONYMOUS_POSTER_LABEL = 'anonymous';

function sanitizePosterLightningAddress(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const atIndex = normalized.indexOf('@');

  if (atIndex <= 0 || atIndex === normalized.length - 1) {
    return ANONYMOUS_POSTER_LABEL;
  }

  if (normalized.indexOf('@', atIndex + 1) !== -1) {
    return ANONYMOUS_POSTER_LABEL;
  }

  return normalized;
}

function formatPosterHandle(lightningAddress) {
  const sanitized = sanitizePosterLightningAddress(lightningAddress);
  const atIndex = sanitized.indexOf('@');

  if (atIndex > 0) {
    return sanitized.slice(0, atIndex);
  }

  return ANONYMOUS_POSTER_LABEL;
}

function sanitizePOSFeedPost(post, options = {}) {
  if (!post || typeof post !== 'object') {
    return post;
  }

  const reportCount = Math.max(0, Number(post.reportCount || 0));

  return {
    ...post,
    posterLightningAddress: sanitizePosterLightningAddress(post.posterLightningAddress),
    reportCount,
    isFlagged: !!post.isFlagged || reportCount > 0,
    viewerHasReported: !!options.viewerHasReported,
    isOwnPost: !!options.isOwnPost,
  };
}

async function fetchBlockedPosterUserIds(viewerUserId) {
  const blocks = await UserBlock.find({ blockerUserId: viewerUserId })
    .select('blockedUserId')
    .lean();

  return blocks
    .map((block) => block?.blockedUserId)
    .filter(Boolean);
}

async function fetchViewerReportedPostIds(viewerUserId, postIds) {
  const normalizedPostIds = Array.isArray(postIds)
    ? postIds.filter(Boolean)
    : [];

  if (!normalizedPostIds.length) {
    return new Set();
  }

  const reports = await POSFeedPostReport.find({
    reporterUserId: viewerUserId,
    postId: { $in: normalizedPostIds },
  })
    .select('postId')
    .lean();

  return new Set(
    reports
      .map((report) => String(report?.postId || ''))
      .filter(Boolean)
  );
}

const upload = multer({
  limits: {
    fileSize: 8 * 1024 * 1024,
    files: 4,
  },
});

async function fetchPublicProofPosts(limit = 30) {
  const cappedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(50, Math.trunc(limit)))
    : 30;

  const posts = await POSFeedPost.find({})
    .select(
      '_id posterLightningAddress posterProfilePicUrl amountSats placeText caption imageUrl imageUrls createdAt paidAt'
    )
    .sort({ createdAt: -1 })
    .limit(cappedLimit)
    .lean();

  return posts.map(formatPublicProofPost);
}

function formatPublicProofPost(post) {
  const amountSats = Math.max(0, Number(post.amountSats || 0));
  const amountBtc = amountSats / 100_000_000;
  const createdAt = post.createdAt ? new Date(post.createdAt) : new Date();
  const posterLightningAddress = sanitizePosterLightningAddress(post.posterLightningAddress);
  const imageUrls = Array.isArray(post.imageUrls) && post.imageUrls.length
    ? post.imageUrls
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    : [String(post.imageUrl || '').trim()].filter(Boolean);

  return {
    id: String(post._id),
    posterLightningAddress,
    posterHandle: formatPosterHandle(posterLightningAddress),
    posterProfilePicUrl: post.posterProfilePicUrl || null,
    amountSats,
    amountBtcText: `${amountBtc.toFixed(8)} BTC`,
    placeText: String(post.placeText || '').trim() || 'Verified payment',
    caption: String(post.caption || '').trim(),
    imageUrl: imageUrls[0] || '',
    imageUrls,
    imageCount: imageUrls.length,
    createdAt: createdAt.toISOString(),
    displayDate: formatDisplayDate(createdAt),
  };
}

function formatDisplayDate(date) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  } catch (_) {
    return date.toISOString();
  }
}


router.get('/public-api/proof-of-spend/posts', async (req, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const posts = await fetchPublicProofPosts(limitRaw);
    return res.status(200).json({ posts });
  } catch (error) {
    console.error('Error fetching public Proof of Spend posts:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.get('/pos-feed/posts', userAuthMiddleware, async (req, res) => {
  try {
    const viewer = await User.findById(req.userId).select('_id');
    if (!viewer) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(50, Math.trunc(limitRaw)))
      : 25;

    const blockedPosterUserIds = await fetchBlockedPosterUserIds(viewer._id);
    const feedFilter = blockedPosterUserIds.length
      ? { posterUserId: { $nin: blockedPosterUserIds } }
      : {};

    const posts = await POSFeedPost.find(feedFilter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const viewerReportedPostIds = await fetchViewerReportedPostIds(
      viewer._id,
      posts.map((post) => post?._id).filter(Boolean)
    );

    return res.status(200).json({
      posts: posts.map((post) => sanitizePOSFeedPost(post, {
        viewerHasReported: viewerReportedPostIds.has(String(post._id)),
        isOwnPost: String(post.posterUserId) === String(viewer._id),
      })),
    });
  } catch (error) {
    console.error('Error fetching POS feed posts:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.get('/pos-feed/my-posts', userAuthMiddleware, async (req, res) => {
  try {
    const viewer = await User.findById(req.userId).select('_id');
    if (!viewer) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(100, Math.trunc(limitRaw)))
      : 50;

    const posts = await POSFeedPost.find({ posterUserId: viewer._id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json({
      posts: posts.map((post) => sanitizePOSFeedPost(post, {
        viewerHasReported: false,
        isOwnPost: true,
      })),
    });
  } catch (error) {
    console.error('Error fetching my POS feed posts:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/pos-feed/posts', userAuthMiddleware, upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'images', maxCount: 4 },
]), async (req, res) => {
  const uploadedImages = [];

  try {
    const user = await User.findById(req.userId).select(
      '_id lightningAddress sparkAddress profilePicUrl'
    );

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const posterLightningAddress = sanitizePosterLightningAddress(user.lightningAddress);
    if (posterLightningAddress === ANONYMOUS_POSTER_LABEL) {
      return res.status(409).json({
        error: 'A Lightning address is required to create a Proof of Spend post.',
      });
    }

    const filesByField = req.files || {};
    const uploadedFiles = [
      ...(Array.isArray(filesByField.images) ? filesByField.images : []),
      ...(Array.isArray(filesByField.image) ? filesByField.image : []),
    ];

    if (!uploadedFiles.length) {
      return res.status(400).json({ error: 'At least one image file is required' });
    }

    if (uploadedFiles.length > 4) {
      return res.status(400).json({ error: 'A Proof of Spend post can include at most 4 images' });
    }

    if (uploadedFiles.some((file) => !file.mimetype || !file.mimetype.startsWith('image/'))) {
      return res.status(400).json({ error: 'All uploads must be image files' });
    }

    const transactionId = String(req.body.transactionId || '').trim();
    const placeText = String(req.body.placeText || '').trim();
    const caption = String(req.body.caption || '').trim();
    const paidAtRaw = String(req.body.paidAt || '').trim();
    const amountSats = Number(req.body.amountSats);

    if (!transactionId) {
      return res.status(400).json({ error: 'transactionId is required' });
    }

    if (!Number.isFinite(amountSats) || amountSats <= 0) {
      return res.status(400).json({ error: 'amountSats must be a positive number' });
    }

    if (caption.length > 500) {
      return res.status(400).json({ error: 'caption is too long' });
    }

    if (placeText.length > 160) {
      return res.status(400).json({ error: 'placeText is too long' });
    }

    const paidAt = paidAtRaw ? new Date(paidAtRaw) : null;
    if (paidAtRaw && Number.isNaN(paidAt.getTime())) {
      return res.status(400).json({ error: 'paidAt is invalid' });
    }

    const existing = await POSFeedPost.findOne({
      posterUserId: user._id,
      transactionId,
    }).select('_id');

    if (existing) {
      return res.status(409).json({ error: 'A Proof of Spend post already exists for this transaction.' });
    }

    try {
      for (const file of uploadedFiles) {
        const objectKey = `pos-feed/${crypto.randomUUID()}.jpg`;

        const processedBuffer = await sharp(file.buffer)
          .rotate()
          .resize({
            width: 1600,
            height: 1600,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality: 88, mozjpeg: true })
          .toBuffer();

        await s3Client.send(new PutObjectCommand({
          Bucket: process.env.R2_BUCKET,
          Key: objectKey,
          Body: processedBuffer,
          ContentType: 'image/jpeg',
          ACL: 'public-read',
        }));

        uploadedImages.push({
          imageUrl: `${process.env.PUBLIC_CDN_BASE_URL || "https://cdn.example.invalid"}/${objectKey}`,
          imageObjectKey: objectKey,
        });
      }
    } catch (uploadError) {
      for (const uploadedImage of uploadedImages) {
        try {
          await s3Client.send(new DeleteObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: uploadedImage.imageObjectKey,
          }));
        } catch (cleanupError) {
          console.error('Error cleaning up failed POS feed upload image:', cleanupError);
        }
      }

      uploadedImages.length = 0;

      throw uploadError;
    }

    const imageUrl = uploadedImages[0]?.imageUrl || '';
    const imageObjectKey = uploadedImages[0]?.imageObjectKey || '';

    const post = await POSFeedPost.create({
      posterUserId: user._id,
      posterLightningAddress,
      posterProfilePicUrl: user.profilePicUrl || null,
      transactionId,
      amountSats: Math.trunc(amountSats),
      paidAt: paidAt || null,
      placeText,
      caption,
      imageUrl,
      imageUrls: uploadedImages.map((image) => image.imageUrl),
      imageObjectKey,
      imageObjectKeys: uploadedImages.map((image) => image.imageObjectKey),
    });

    return res.status(201).json({ post });
  } catch (error) {
    for (const uploadedImage of uploadedImages) {
      try {
        await s3Client.send(new DeleteObjectCommand({
          Bucket: process.env.R2_BUCKET,
          Key: uploadedImage.imageObjectKey,
        }));
      } catch (cleanupError) {
        console.error('Error cleaning up POS feed image after route failure:', cleanupError);
      }
    }

    if (error && error.code === 11000) {
      return res.status(409).json({ error: 'A Proof of Spend post already exists for this transaction.' });
    }

    console.error('Error creating POS feed post:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/pos-feed/posts/:id/report', userAuthMiddleware, async (req, res) => {
  try {
    const reporter = await User.findById(req.userId)
      .select('_id walletPubkey lightningAddress');

    if (!reporter) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const post = await POSFeedPost.findById(req.params.id).lean();
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    if (String(post.posterUserId) === String(reporter._id)) {
      return res.status(400).json({ error: 'You cannot report your own post.' });
    }

    const existingReport = await POSFeedPostReport.findOne({
      postId: post._id,
      reporterUserId: reporter._id,
    }).select('_id');

    if (existingReport) {
      return res.status(200).json({
        ok: true,
        didUpdate: false,
        post: sanitizePOSFeedPost(post, {
          viewerHasReported: true,
          isOwnPost: false,
        }),
      });
    }

    await POSFeedPostReport.create({
      postId: post._id,
      reporterUserId: reporter._id,
    });

    const updatedPost = await POSFeedPost.findByIdAndUpdate(
      post._id,
      {
        $inc: { reportCount: 1 },
        $set: {
          isFlagged: true,
          lastReportedAt: new Date(),
        },
      },
      { new: true }
    ).lean();

    if (!updatedPost) {
      return res.status(404).json({ error: 'Post not found' });
    }

    console.log('=== POS FEED POST FLAG START ===');
    console.log(
      JSON.stringify(
        {
          flaggedAt: new Date().toISOString(),
          reporterUserId: String(reporter._id),
          reporterWalletPubkey: reporter.walletPubkey || null,
          reporterLightningAddress: reporter.lightningAddress || null,
          postId: String(updatedPost._id),
          posterUserId: String(updatedPost.posterUserId),
          posterLightningAddress: updatedPost.posterLightningAddress || null,
          transactionId: updatedPost.transactionId || null,
          amountSats: updatedPost.amountSats ?? null,
          placeText: updatedPost.placeText || null,
          caption: updatedPost.caption || null,
          imageUrl: updatedPost.imageUrl || null,
          reportCount: Math.max(0, Number(updatedPost.reportCount || 0)),
          isFlagged: !!updatedPost.isFlagged,
        },
        null,
        2
      )
    );
    console.log('=== POS FEED POST FLAG END ===');

    return res.status(200).json({
      ok: true,
      didUpdate: true,
      post: sanitizePOSFeedPost(updatedPost, {
        viewerHasReported: true,
        isOwnPost: false,
      }),
    });
  } catch (error) {
    if (error && error.code === 11000) {
      try {
        const post = await POSFeedPost.findById(req.params.id).lean();
        if (post) {
          return res.status(200).json({
            ok: true,
            didUpdate: false,
            post: sanitizePOSFeedPost(post, {
              viewerHasReported: true,
              isOwnPost: String(post.posterUserId) === String(req.userId),
            }),
          });
        }
      } catch (lookupError) {
        console.warn('Error resolving duplicate POS feed report state:', lookupError);
      }
    }

    console.error('Error flagging POS feed post:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.delete('/pos-feed/posts/:id', userAuthMiddleware, async (req, res) => {
  try {
    const viewer = await User.findById(req.userId).select('_id');
    if (!viewer) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const post = await POSFeedPost.findOneAndDelete({
      _id: req.params.id,
      posterUserId: viewer._id,
    }).lean();

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const objectKeys = Array.isArray(post.imageObjectKeys) && post.imageObjectKeys.length
      ? post.imageObjectKeys
      : [post.imageObjectKey].filter(Boolean);

    for (const objectKey of objectKeys) {
      try {
        await s3Client.send(new DeleteObjectCommand({
          Bucket: process.env.R2_BUCKET,
          Key: objectKey,
        }));
      } catch (storageError) {
        console.error('Error deleting POS feed post image from storage:', storageError);
      }
    }

    try {
      await POSFeedPostReport.deleteMany({ postId: post._id });
    } catch (reportCleanupError) {
      console.error('Error deleting POS feed post reports:', reportCleanupError);
    }

    return res.status(200).json({ success: true, deletedPostId: String(post._id) });
  } catch (error) {
    console.error('Error deleting POS feed post:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;
