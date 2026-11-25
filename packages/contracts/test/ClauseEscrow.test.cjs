const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const {
  SKIP,
  PRICE,
  FEE_BPS,
  GRACE,
  now,
  deployFixture,
  makeVoucher,
  makeAttestation,
  makeFailureAttestation,
  expectedInput,
} = require('./helpers.cjs');

async function skipReasonOf(tx, escrow) {
  const rc = await tx.wait();
  const logs = rc.logs.map((l) => {
    try {
      return escrow.interface.parseLog(l);
    } catch {
      return null;
    }
  });
  const skipped = logs.find((l) => l && l.name === 'Skipped');
  return skipped ? Number(skipped.args.reason) : SKIP.None;
}

async function increaseTime(s) {
  await network.provider.send('evm_increaseTime', [s]);
  await network.provider.send('evm_mine');
}

describe('ClauseEscrow', function () {
  let ctx;
  beforeEach(async () => {
    ctx = await deployFixture();
  });

  describe('verdict routing', () => {
    it('verdict 1 pays seller (price − fee) and fee to treasury, emits replayable Adjudicated', async () => {
      const { escrow, usd, buyer, payee, treasury, other } = ctx;
      const { voucher } = await makeVoucher(ctx);
      const att = await makeAttestation(ctx, voucher);
      const tx = await escrow.connect(other).settleBatch([voucher], [att]);
      await expect(tx)
        .to.emit(escrow, 'Adjudicated')
        .withArgs(voucher.callId, 1n, 1, expectedInput(voucher, att));
      const fee = (PRICE * BigInt(FEE_BPS)) / 10_000n;
      expect(await escrow.balanceOf(buyer, usd)).to.equal(1_000_000n - PRICE);
      expect(await escrow.balanceOf(payee, usd)).to.equal(PRICE - fee);
      expect(await escrow.balanceOf(treasury, usd)).to.equal(fee);
      expect(await escrow.callStatus(voucher.callId)).to.equal(1); // Paid
    });

    it('verdict 0 (hash differs) refunds the buyer in full', async () => {
      const { escrow, usd, buyer, payee } = ctx;
      const { voucher } = await makeVoucher(ctx);
      const att = await makeAttestation(ctx, voucher, { responseHash: '0xdeadbeefdeadbeef' });
      await expect(escrow.settleBatch([voucher], [att])).to.emit(escrow, 'Refunded').withArgs(voucher.callId, 1n, buyer.address, PRICE);
      expect(await escrow.balanceOf(buyer, usd)).to.equal(1_000_000n);
      expect(await escrow.balanceOf(payee, usd)).to.equal(0n);
      expect(await escrow.callStatus(voucher.callId)).to.equal(2); // Refunded
    });

    it('late arrival (deadline + grace + 1) refunds; boundary (deadline + grace) pays', async () => {
      const { escrow } = ctx;
      const a = await makeVoucher(ctx);
      const late = await makeAttestation(ctx, a.voucher, { arrival: a.voucher.deadline + GRACE + 1 });
      await expect(escrow.settleBatch([a.voucher], [late])).to.emit(escrow, 'Refunded');
      const b = await makeVoucher(ctx);
      const edge = await makeAttestation(ctx, b.voucher, { arrival: b.voucher.deadline + GRACE });
      await expect(escrow.settleBatch([b.voucher], [edge])).to.emit(escrow, 'Paid');
    });

    it('Template B pays within band and refunds outside it', async () => {
      const { escrow } = ctx;
      const a = await makeVoucher(ctx, { serviceId: 2n });
      await expect(escrow.settleBatch([a.voucher], [await makeAttestation(ctx, a.voucher, { deliveredValue: 108320 - 50, responseHash: '0x0101010101010101' })])).to.emit(escrow, 'Paid');
      const b = await makeVoucher(ctx, { serviceId: 2n });
      await expect(escrow.settleBatch([b.voucher], [await makeAttestation(ctx, b.voucher, { deliveredValue: 108320 + 51 })])).to.emit(escrow, 'Refunded');
    });

    it('seller dead: gateway-only failure attestation (statusOK=false, no seller sig) refunds', async () => {
      const { escrow, usd, buyer } = ctx;
      const { voucher } = await makeVoucher(ctx);
      const att = await makeFailureAttestation(ctx, voucher);
      await expect(escrow.settleBatch([voucher], [att])).to.emit(escrow, 'Refunded');
      expect(await escrow.balanceOf(buyer, usd)).to.equal(1_000_000n);
    });

    it('seller paid on valid delivery even if the buyer vanishes (anyone may settle)', async () => {
      const { escrow, other, payee, usd } = ctx;
      const { voucher } = await makeVoucher(ctx);
      await escrow.connect(other).settleBatch([voucher], [await makeAttestation(ctx, voucher)]);
      expect(await escrow.balanceOf(payee, usd)).to.be.gt(0n);
    });

    it('settles a batch of 10 with mixed verdicts', async () => {
      const { escrow, usd, buyer } = ctx;
      const vs = [];
      const as = [];
      for (let i = 0; i < 10; i++) {
        const { voucher } = await makeVoucher(ctx);
        vs.push(voucher);
        as.push(i < 5 ? await makeAttestation(ctx, voucher) : await makeFailureAttestation(ctx, voucher));
      }
      const rc = await (await escrow.settleBatch(vs, as)).wait();
      console.log(`      gas: settleBatch(10) with DEV MOCK processor = ${rc.gasUsed} (${rc.gasUsed / 10n}/call) — real TapeOut eval gas is partner-measured (PRD §9 #2)`);
      expect(await escrow.balanceOf(buyer, usd)).to.equal(1_000_000n - 5n * PRICE);
    });
  });

  describe('trust boundary — who cannot cheat', () => {
    it('gateway cannot swap commitment terms after the buyer signed', async () => {
      const { escrow } = ctx;
      const { voucher } = await makeVoucher(ctx);
      const swapped = { ...voucher, quotedValue: 999999 };
      const att = await makeAttestation(ctx, swapped);
      expect(await skipReasonOf(await escrow.settleBatch([swapped], [att]), escrow)).to.equal(SKIP.BadVoucherSig);
    });

    it('gateway cannot forge the response hash (seller signature binds it)', async () => {
      const { escrow } = ctx;
      const { voucher } = await makeVoucher(ctx);
      const honest = await makeAttestation(ctx, voucher, { responseHash: '0xdeadbeefdeadbeef' });
      const forged = await makeAttestation(ctx, voucher, { responseHash: voucher.sealedHash, sellerSig: honest.sellerSig });
      expect(await skipReasonOf(await escrow.settleBatch([voucher], [forged]), escrow)).to.equal(SKIP.BadSellerSig);
    });

    it('nobody can rewrite arrival/statusOK on a permissionless settle (gateway signature binds them)', async () => {
      const { escrow, other } = ctx;
      const { voucher } = await makeVoucher(ctx);
      const real = await makeAttestation(ctx, voucher);
      const rewritten = { ...real, arrival: real.arrival + 100000 };
      expect(await skipReasonOf(await escrow.connect(other).settleBatch([voucher], [rewritten]), escrow)).to.equal(SKIP.BadGatewaySig);
    });

    it('statusOK=true without a seller signature is rejected', async () => {
      const { escrow } = ctx;
      const { voucher } = await makeVoucher(ctx);
      const att = await makeAttestation(ctx, voucher, { sellerSig: '0x' });
      expect(await skipReasonOf(await escrow.settleBatch([voucher], [att]), escrow)).to.equal(SKIP.BadSellerSig);
    });

    it('failure attestation must zero the delivery fields', async () => {
      const { escrow } = ctx;
      const { voucher } = await makeVoucher(ctx);
      const att = await makeFailureAttestation(ctx, voucher, { responseHash: voucher.sealedHash });
      expect(await skipReasonOf(await escrow.settleBatch([voucher], [att]), escrow)).to.equal(SKIP.BadFailureAttestation);
    });

    it('a voucher signed by someone other than the buyer is rejected', async () => {
      const { escrow, other } = ctx;
      const { voucher } = await makeVoucher(ctx, { signer: other });
      expect(await skipReasonOf(await escrow.settleBatch([voucher], [await makeAttestation(ctx, voucher)]), escrow)).to.equal(SKIP.BadVoucherSig);
    });
  });

  describe('step 3/4 rejections', () => {
    it('each callId resolves once', async () => {
      const { escrow } = ctx;
      const { voucher } = await makeVoucher(ctx);
      const att = await makeAttestation(ctx, voucher);
      await escrow.settleBatch([voucher], [att]);
      expect(await skipReasonOf(await escrow.settleBatch([voucher], [att]), escrow)).to.equal(SKIP.CallAlreadyResolved);
    });

    it('rejects after expiry', async () => {
      const { escrow } = ctx;
      const { voucher } = await makeVoucher(ctx);
      const att = await makeAttestation(ctx, voucher);
      await increaseTime(200);
      expect(await skipReasonOf(await escrow.settleBatch([voucher], [att]), escrow)).to.equal(SKIP.VoucherExpired);
    });

    it('rejects maxAmount < price', async () => {
      const { escrow } = ctx;
      const { voucher } = await makeVoucher(ctx, { maxAmount: PRICE - 1n });
      expect(await skipReasonOf(await escrow.settleBatch([voucher], [await makeAttestation(ctx, voucher)]), escrow)).to.equal(SKIP.MaxAmountBelowPrice);
    });

    it('rejects voucher lifetime above MAX_VOUCHER_LIFETIME', async () => {
      const { escrow } = ctx;
      const t = await now();
      const { voucher } = await makeVoucher(ctx, { issuedAt: t, expiry: t + 601 });
      expect(await skipReasonOf(await escrow.settleBatch([voucher], [await makeAttestation(ctx, voucher)]), escrow)).to.equal(SKIP.VoucherLifetimeTooLong);
    });

    it('rejects insufficient buyer balance', async () => {
      const { escrow, other, domain } = ctx;
      const { voucher } = await makeVoucher(ctx, { buyer: other.address, signer: other });
      expect(await skipReasonOf(await escrow.settleBatch([voucher], [await makeAttestation(ctx, voucher)]), escrow)).to.equal(SKIP.InsufficientBalance);
    });

    it('processor failure skips without moving funds', async () => {
      const { escrow, usd, buyer } = ctx;
      const { voucher } = await makeVoucher(ctx, { serviceId: 3n });
      expect(await skipReasonOf(await escrow.settleBatch([voucher], [await makeAttestation(ctx, voucher)]), escrow)).to.equal(SKIP.ProcessorCallFailed);
      expect(await escrow.balanceOf(buyer, usd)).to.equal(1_000_000n);
      expect(await escrow.callStatus(voucher.callId)).to.equal(0);
    });

    it('length mismatch reverts the batch', async () => {
      const { escrow } = ctx;
      const { voucher } = await makeVoucher(ctx);
      await expect(escrow.settleBatch([voucher], [])).to.be.revertedWithCustomError(escrow, 'LengthMismatch');
    });
  });

  describe('delayed withdraw', () => {
    it('vouchers issued after a withdraw request are rejected; earlier ones still settle', async () => {
      const { escrow, usd, buyer } = ctx;
      const before = await makeVoucher(ctx);
      await increaseTime(2);
      await escrow.connect(buyer).requestWithdraw(usd, 500_000n);
      await increaseTime(2);
      const after = await makeVoucher(ctx);
      expect(await skipReasonOf(await escrow.settleBatch([after.voucher], [await makeAttestation(ctx, after.voucher)]), escrow)).to.equal(SKIP.IssuedAfterWithdrawRequest);
      await expect(escrow.settleBatch([before.voucher], [await makeAttestation(ctx, before.voucher)])).to.emit(escrow, 'Paid');
    });

    it('cannot execute before 15 minutes; pays min(requested, balance) after', async () => {
      const { escrow, usd, buyer } = ctx;
      await escrow.connect(buyer).requestWithdraw(usd, 1_000_000n);
      const pending = await makeVoucher(ctx, { issuedAt: (await now()) - 1 });
      await escrow.settleBatch([pending.voucher], [await makeAttestation(ctx, pending.voucher)]);
      await expect(escrow.connect(buyer).executeWithdraw(usd)).to.be.revertedWithCustomError(escrow, 'WithdrawLocked');
      await increaseTime(15 * 60);
      const bal = await usd.balanceOf(buyer);
      await escrow.connect(buyer).executeWithdraw(usd);
      expect(await usd.balanceOf(buyer)).to.equal(bal + 1_000_000n - PRICE);
      expect(await escrow.balanceOf(buyer, usd)).to.equal(0n);
    });

    it('payee can withdraw earnings through the same delayed path', async () => {
      const { escrow, usd, payee } = ctx;
      const { voucher } = await makeVoucher(ctx);
      await escrow.settleBatch([voucher], [await makeAttestation(ctx, voucher)]);
      const earned = await escrow.balanceOf(payee, usd);
      await escrow.connect(payee).requestWithdraw(usd, earned);
      await increaseTime(15 * 60);
      await escrow.connect(payee).executeWithdraw(usd);
      expect(await usd.balanceOf(payee)).to.equal(earned);
    });
  });

  describe('timeout reclaim', () => {
    it('only after expiry, only with the real buyer signature, and blocks later settlement', async () => {
      const { escrow, other } = ctx;
      const { voucher } = await makeVoucher(ctx);
      await expect(escrow.connect(other).reclaim(voucher.callId, voucher)).to.be.revertedWithCustomError(escrow, 'NotExpired');
      await increaseTime(121);
      const forged = { ...voucher, nonce: voucher.nonce + 1n };
      await expect(escrow.reclaim(voucher.callId, forged)).to.be.revertedWithCustomError(escrow, 'BadVoucherSig');
      await expect(escrow.connect(other).reclaim(voucher.callId, voucher)).to.emit(escrow, 'Reclaimed').withArgs(voucher.callId, voucher.buyer);
      expect(await escrow.callStatus(voucher.callId)).to.equal(3);
      await expect(escrow.reclaim(voucher.callId, voucher)).to.be.revertedWithCustomError(escrow, 'AlreadyResolved');
    });
  });

  describe('immutability & no admin path', () => {
    it('ABI exposes no owner, pause, upgrade or setter functions', async () => {
      const names = ctx.escrow.interface.fragments.filter((f) => f.type === 'function').map((f) => f.name);
      for (const n of names) expect(n).to.not.match(/owner|pause|upgrade|^set[A-Z]|admin|sweep|rescue/);
    });

    it('service fields are fixed at registration', async () => {
      const s = await ctx.escrow.getService(1);
      expect(s.circuitId).to.equal(1n);
      expect(s.payee).to.equal(ctx.payee.address);
      expect(s.feeBps).to.equal(FEE_BPS);
      expect(s.grace).to.equal(GRACE);
      expect(s.gateway).to.equal(ctx.gateway.address);
    });

    it('registerService validates inputs', async () => {
      const { escrow, proc, payee, seller, gateway, usd } = ctx;
      await expect(escrow.registerService(ethers.ZeroAddress, 1, payee, seller, gateway, usd, PRICE, 5)).to.be.revertedWithCustomError(escrow, 'ZeroAddress');
      await expect(escrow.registerService(payee.address, 1, payee, seller, gateway, usd, PRICE, 5)).to.be.revertedWithCustomError(escrow, 'NotAContract');
      await expect(escrow.registerService(proc, 1, payee, seller, gateway, usd, 0, 5)).to.be.revertedWithCustomError(escrow, 'InvalidParam');
    });
  });
});
