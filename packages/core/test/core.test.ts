import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import {
  bytesToHex,
  checkQuote,
  clauseDomain,
  decodeInput,
  encodeInput,
  evaluate,
  FIELD_LAYOUT,
  hash8,
  hexToBytes,
  INPUT_LENGTH,
  mandatoryVectors,
  randomVectors,
  recoverGatewaySigner,
  recoverSellerSigner,
  recoverVoucherSigner,
  signGatewayAttestation,
  signSellerReceipt,
  signVoucher,
  toleranceFromBps,
  utf8,
  b64encode,
  verdictOf,
  type ClauseExtension,
} from '../src/index.ts';

test('layout covers exactly 41 contiguous bytes', () => {
  let next = 0;
  for (const f of FIELD_LAYOUT) {
    assert.equal(f.offset, next, `${f.name} offset`);
    next += f.size;
  }
  assert.equal(next, INPUT_LENGTH);
});

test('encode/decode round-trips', () => {
  for (const v of randomVectors(500, 7)) {
    const bytes = hexToBytes(v.input);
    assert.equal(bytesToHex(encodeInput(decodeInput(bytes))), v.input);
  }
});

test('encoder rejects out-of-range values', () => {
  const f = decodeInput(hexToBytes(mandatoryVectors()[0].input));
  assert.throws(() => encodeInput({ ...f, arrival: 2 ** 32 }));
  assert.throws(() => encodeInput({ ...f, statusOK: 256 }));
  assert.throws(() => encodeInput({ ...f, sealedHash: '0x11' }));
});

test('PRD mandatory vectors', () => {
  const vs = mandatoryVectors();
  assert.equal(vs.length, 8);
  for (const v of vs) assert.equal(verdictOf(v.template, hexToBytes(v.input)), v.expect, v.name);
});

test('Template E ignores bytes 29–40; Template B ignores bytes 0–15', () => {
  const r = Math.random;
  for (const v of randomVectors(300, 99)) {
    const bytes = hexToBytes(v.input);
    const mutated = bytes.slice();
    const [lo, hi] = v.template === 'E' ? [29, 41] : [0, 16];
    for (let i = lo; i < hi; i++) mutated[i] = Math.floor(r() * 256);
    assert.equal(verdictOf(v.template, mutated), verdictOf(v.template, bytes));
  }
});

test('deadline + grace does not overflow uint32', () => {
  const f = decodeInput(hexToBytes(mandatoryVectors()[0].input));
  const g = { ...f, deadline: 0xffffffff, grace: 10, arrival: 0xffffffff };
  assert.equal(verdictOf('E', g), 1);
});

test('randomized vectors contain both verdicts', () => {
  const vs = randomVectors(2000);
  const ones = vs.filter((v) => v.expect === 1).length;
  assert.ok(ones > 200 && ones < 1800, `balanced-ish: ${ones}`);
});

test('evaluate explains each clause', () => {
  const e = evaluate('B', hexToBytes(mandatoryVectors()[6].input));
  assert.equal(e.verdict, 0);
  assert.equal(e.clauses.find((c) => c.key === 'withinBand')?.pass, false);
});

test('toleranceFromBps floors', () => {
  assert.equal(toleranceFromBps(108_320, 5), 54);
  assert.equal(toleranceFromBps(100, 0), 0);
  assert.throws(() => toleranceFromBps(1, 10_001));
});

test('hash8 is first 8 bytes of sha256 of exact bytes', () => {
  // sha256("abc") = ba7816bf8f01cfea...
  assert.equal(hash8(utf8('abc')), '0xba7816bf8f01cfea');
  assert.notEqual(hash8(utf8('{"a":1}')), hash8(utf8('{"a": 1}')), 'no canonicalization');
});

test('EIP-712 signatures recover for voucher, seller receipt, gateway attestation', async () => {
  const buyer = Wallet.createRandom();
  const seller = Wallet.createRandom();
  const gateway = Wallet.createRandom();
  const domain = clauseDomain(196, '0x00000000000000000000000000000000000c1a05');
  const voucher = await signVoucher(buyer, domain, {
    callId: '0x' + '11'.repeat(32),
    buyer: buyer.address,
    serviceId: '1',
    nonce: '1',
    maxAmount: '10000',
    sealedHash: '0x1122334455667788',
    quotedValue: 1,
    tolerance: 0,
    issuedAt: 1,
    deadline: 2,
    expiry: 3,
  });
  assert.equal(recoverVoucherSigner(domain, voucher), buyer.address);
  assert.notEqual(recoverVoucherSigner(domain, { ...voucher, quotedValue: 2 }), buyer.address, 'terms are bound');

  const r = { callId: voucher.callId, responseHash: '0x1122334455667788', deliveredValue: 5 };
  const sellerSig = await signSellerReceipt(seller, domain, r);
  assert.equal(recoverSellerSigner(domain, r, sellerSig), seller.address);
  assert.equal(recoverSellerSigner(domain, r, '0x'), null);

  const a = { ...r, arrival: 2, statusOK: true };
  const gatewaySig = await signGatewayAttestation(gateway, domain, a);
  assert.equal(recoverGatewaySigner(domain, { ...a, sellerSig, gatewaySig }), gateway.address);
  assert.notEqual(recoverGatewaySigner(domain, { ...a, arrival: 1, sellerSig, gatewaySig }), gateway.address);
});

test('checkQuote catches a sealed hash that does not match the plaintext', () => {
  const text = '{"pair":"EURUSD","value":108320}';
  const good: ClauseExtension = {
    plaintextQuote: text,
    plaintextQuoteB64: b64encode(utf8(text)),
    sealedHash: hash8(utf8(text)),
    quotedValue: 108320,
  } as ClauseExtension;
  assert.equal(checkQuote(good).ok, true);
  assert.equal(checkQuote({ ...good, sealedHash: '0x0000000000000000' }).ok, false);
  assert.equal(checkQuote({ ...good, quotedValue: 1 }).ok, false, 'value must match the plaintext the buyer sees');
});
