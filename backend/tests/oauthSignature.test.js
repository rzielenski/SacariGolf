/**
 * Verifies the hand-rolled OAuth 1.0a signer with two independent oracles:
 *
 *  1) Twitter's published "Creating a signature" BASE STRING — exercises the
 *     gnarly percent-encoding (spaces → %2520, '+' → %252B, '!' → %2521,
 *     ',' → %252C) and parameter sorting. NB: Twitter's docs show a signature
 *     that does NOT match their own base string + keys (their example secrets
 *     are inconsistent), so we deliberately do NOT assert against it.
 *
 *  2) OAuth Core 1.0 Appendix A.5.1 — the canonical, self-consistent
 *     HMAC-SHA1 vector that OAuth libraries validate against. We assert both
 *     its base string and its final base64 signature, proving the full pipeline.
 *
 * Run after `npm run build`.
 */
const assert = require('assert');
const { signatureBaseString, computeSignature } = require('../dist/utils/tweet');

// ── 1) Twitter base-string encoding oracle ──────────────────────────────────
const twUrl = 'https://api.twitter.com/1.1/statuses/update.json';
const twParams = {
  status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
  include_entities: 'true',
  oauth_consumer_key: 'xvz1evFS4wEEPTGEFPHBog',
  oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
  oauth_signature_method: 'HMAC-SHA1',
  oauth_timestamp: '1318622958',
  oauth_token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
  oauth_version: '1.0',
};
const twExpectedBase =
  'POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&' +
  'include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26' +
  'oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26' +
  'oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26' +
  'oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26' +
  'oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen' +
  '%252C%2520a%2520signed%2520OAuth%2520request%2521';
assert.strictEqual(signatureBaseString('POST', twUrl, twParams), twExpectedBase, 'Twitter base string mismatch');

// ── 2) OAuth Core 1.0 A.5.1 — base string AND signature ─────────────────────
const ocUrl = 'http://photos.example.net/photos';
const ocParams = {
  file: 'vacation.jpg',
  size: 'original',
  oauth_consumer_key: 'dpf43f3p2l4k3l03',
  oauth_token: 'nnch734d00sl2jdk',
  oauth_signature_method: 'HMAC-SHA1',
  oauth_timestamp: '1191242096',
  oauth_nonce: 'kllo9940pd9333jh',
  oauth_version: '1.0',
};
const ocExpectedBase =
  'GET&http%3A%2F%2Fphotos.example.net%2Fphotos&file%3Dvacation.jpg%26' +
  'oauth_consumer_key%3Ddpf43f3p2l4k3l03%26oauth_nonce%3Dkllo9940pd9333jh%26' +
  'oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1191242096%26' +
  'oauth_token%3Dnnch734d00sl2jdk%26oauth_version%3D1.0%26size%3Doriginal';
const ocConsumerSecret = 'kd94hf93k423kf44';
const ocTokenSecret = 'pfkkdhi9sl3r4s00';
const ocExpectedSig = 'tR3+Ty81lMeYAr/Fid0kMTYa/WM=';

assert.strictEqual(signatureBaseString('GET', ocUrl, ocParams), ocExpectedBase, 'OAuth Core base string mismatch');
assert.strictEqual(
  computeSignature('GET', ocUrl, ocParams, ocConsumerSecret, ocTokenSecret),
  ocExpectedSig,
  'OAuth Core signature mismatch',
);

console.log('OAuth 1.0a signer verified (Twitter base string + OAuth Core 1.0 A.5.1 signature) ✓');
