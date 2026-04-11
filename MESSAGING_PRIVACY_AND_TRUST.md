# Split Messaging Privacy and Trust

This document describes the current Split messaging system as implemented in the Split backend and iOS client.

It is written for technical users who care about privacy, trust minimization, and honest threat-model boundaries.

It is not a marketing claim, and it is not a third-party security audit.

## At a Glance

Split messaging currently provides:

- end-to-end encryption for message bodies
- end-to-end encryption for attachment bytes
- wallet-signed identity binding between:
  - wallet pubkey
  - Lightning address
  - messaging pubkey
- client-side verification of recipient directory proofs
- client-side verification of sender-authenticated message envelopes

Split messaging does **not** currently provide:

- metadata privacy from the Split relay
- an independently witnessed or gossip-backed directory
- Signal-style forward secrecy / double ratchet
- deniable authentication
- censorship resistance

The simplest accurate description is:

> authenticated end-to-end encryption with a client-verified server directory

## What Problem This Design Solves

The current design is trying to minimize trust in the Split backend for two specific problems:

1. The server should not be able to silently substitute a fake recipient messaging key or wallet identity.
2. The server should not be able to silently forge a sender-authenticated message.

That is the center of gravity of the current protocol.

The design is **not** primarily trying to hide:

- who is talking to whom
- when they are talking
- which Lightning address is being resolved
- which user account submitted the message

## Architecture Overview

### 1. Wallet-signed identity binding

Each messaging identity binding contains:

- `walletPubkey`
- `lightningAddress`
- `messagingPubkey`
- `signedAt`
- `version`
- wallet signature over the canonical message

The important trust property here is that the wallet signs the binding.

The backend verifies that signature before accepting the identity update.

For v2:

- the iOS client derives `walletPubkey` and `lightningAddress` locally from the wallet SDK
- the client creates or restores its messaging private key locally
- the wallet signs the binding locally
- the backend stores the verified binding and updates its cached user record from that signed binding

### 2. Server-hosted Merkle directory

Accepted v2 bindings are appended to a backend binding log.

The backend computes a Merkle root over the current log and returns:

- the resolved recipient binding
- the binding leaf hash
- the inclusion proof
- a checkpoint:
  - `rootHash`
  - `treeSize`
  - `issuedAt`

The client verifies:

- the wallet signature on the binding
- the leaf hash
- the Merkle proof up to the claimed root

The client also stores the last checkpoint it has seen and rejects:

- smaller `treeSize` values
- same-size checkpoints with a different root hash

This means the directory is **client-verifiable**.

It does **not** mean the directory is independently witnessed.

### 3. Message sending

For current v2 sends:

1. The sender builds a sealed inner payload containing:
   - plaintext body
   - sender wallet-signed identity binding
   - sender wallet signature over the message envelope
2. The sender encrypts that sealed payload to the recipient's static messaging public key using:
   - a fresh ephemeral sender Curve25519 key
   - HKDF-SHA256
   - ChaCha20-Poly1305
3. The relay receives the outer routing payload and ciphertext.

On receipt, the iOS client:

1. decrypts the sealed payload
2. verifies the sender's binding
3. verifies the sender's wallet signature over the message envelope
4. only then accepts and stores the message locally

### 4. Attachments

Attachment bytes are encrypted client-side before upload.

The relay stores ciphertext and blob metadata, not plaintext attachment content.

Attachment decryption metadata rides inside the encrypted message body.

### 5. Local storage and backup

On iOS:

- the messaging private key is stored in the keychain
- the local message store is encrypted at rest
- cached attachment files are encrypted at rest

There is no server-side backup of the messaging private key.

Important nuance:

- the messaging private key stays local to the device
- if that local key is lost, the client rotates to a new messaging key and future delivery heals through re-registration and resend
- already-imported local message history can still remain readable from the app's encrypted local store

## What the Client Verifies

The iOS client does not simply trust relay assertions.

It verifies:

- wallet signatures on identity bindings
- recipient directory inclusion proofs
- sender envelope signatures
- sealed sender payload authenticity after decryption

This is the strongest part of the current system.

The relay can route, store, delay, or drop ciphertext, but it cannot silently substitute sender or recipient identity without breaking verification.

## What Split Still Learns

The Split backend still sees significant metadata.

Today the relay can learn:

- which authenticated Split user is sending
- which authenticated Split user is receiving
- each user's wallet pubkey
- each user's Lightning address
- when a user resolves a recipient by Lightning address
- the sender/recipient graph
- message timing
- message type
- ciphertext length
- attachment existence
- attachment size
- push token registration
- when relay messages are acknowledged
- when attachments are downloaded or marked received

This is **not** a metadata-hiding system.

## What Apple / Google Still Learn

If push notifications are enabled, Apple and/or Google will also learn that:

- the Split app received a push notification
- at a particular time
- for a particular device token

Current APNs messaging pushes use a generic visible notification:

- title: `Split`
- body: `New message`

They do not contain message plaintext, but push delivery itself is still metadata.

## Relay Retention and Cleanup

Split messaging is currently a store-and-forward relay, not a stateless transport.

### Messages

Current backend behavior:

- pending relay messages are retained until acknowledged or expired
- when a message expires, the backend marks it `undelivered`
- on expiry, the backend removes:
  - ciphertext
  - nonce
  - sender ephemeral pubkey
- old relay receipts are later pruned

### Attachments

Current backend behavior:

- uploaded and linked attachment blobs expire on schedule
- the cleanup worker now deletes expired attachment blobs in the background
- terminal attachment records (`received`, `deleted`, `expired`) are later pruned on schedule
- attachments are also deleted when the recipient marks them received

This is stronger than the earlier opportunistic-only cleanup model.

## Strengths

- Message bodies are end-to-end encrypted.
- Attachment bytes are end-to-end encrypted.
- Sender identity is wallet-authenticated.
- Recipient identity is client-verified rather than blindly trusted from the relay.
- The wallet, not the server, authorizes the identity binding between wallet pubkey, Lightning address, and messaging key.
- The server does not hold the user's messaging private key in plaintext.
- Local message and attachment caches are encrypted at rest on iOS.

## Weaknesses and Residual Trust

These are real limitations that will be improved upon in future releases.

### No metadata privacy from the relay

Split still sees the social graph and timing metadata.

### No independent directory witnesses

The Merkle directory is client-verifiable, but Split still serves the checkpoint.

There is currently no witness, gossip, or external transparency mechanism to independently audit directory freshness or split-view behavior.

### No deniability

The protocol deliberately binds messages to wallet signatures.

That gives strong authenticity.

It does not give deniable authentication.

### No forward-secret ratchet

Each message uses a fresh sender ephemeral key, which is good.

But the recipient side is still a long-lived static messaging key.

If an attacker later obtains the recipient's messaging private key **and** old ciphertext, those old messages can be decrypted.

This is not a Signal-style double ratchet.

### The relay can still censor, delay, drop, or replay

The relay cannot silently forge sender-authenticated content, but it can still:

- refuse delivery
- delay delivery
- drop messages
- replay ciphertext it already has

So the current system improves confidentiality and authenticity more than it improves availability or censorship resistance.

### Profile data is not a cryptographic trust root

Fields like:

- `profilePicUrl`
- suggested contact names

are presentation metadata, not the signed identity root.

The trust root is the wallet-signed binding.

### Local encryption still depends on device security

Local encryption helps at-rest protection.

It does not make a fully compromised unlocked device safe.

## Optional Signed Contact Cards

The iOS app also supports a signed `split-contact:` payload format for out-of-band contact sharing.

That is useful as a signed contact-card format.

It is **not** currently the primary routing trust path for message delivery. The normal messaging flow still resolves recipients through the server directory and then verifies the returned binding locally.

## What We Are Not Claiming

This messaging system should **not** be described as:

- anonymous
- metadata-private
- witness-backed
- transparency-audited
- deniable
- forward-secret in the Signal sense
- censorship-resistant

That would overstate the design.

## Bottom Line

For technical users, the honest summary is:

Split messaging is meaningfully better than a plain server-trusted chat system. The relay does not get message plaintext, cannot silently replace recipient identity without failing client verification, and cannot silently forge sender-authenticated messages without failing client verification.

But Split still operates a visible relay and visible directory. The backend still learns the social graph, still controls availability and directory freshness, and the protocol deliberately prioritizes strong wallet-bound authenticity over deniability and metadata minimization.

If you want a one-line description, use this:

> Split messaging is authenticated end-to-end encryption with a client-verified server directory and explicit residual metadata trust in the relay.
