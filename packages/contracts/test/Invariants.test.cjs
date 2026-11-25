/**
 * Randomized invariant fuzzing (PRD §5 "Invariants (fuzz)"):
 *   I1 Σbalances ≤ escrow token balance (and Σbalances == totalBalance)
 *   I2 each callId resolves once
 *   I3 funds move only via verdict / reclaim / withdraw
 *   I4 seller paid on valid delivery even if buyer vanishes
 *   I5 circuitId / payee / feeBps / grace immutable
 */
const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { deployFixture, makeVoucher, makeAttestation, makeFailureAttestation, PRICE } = require('./helpers.cjs');

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('ClauseEscrow invariants (randomized)', function () {
  it('I1–I5 hold across 150 random operations', async () => {
    const ctx = await deployFixture();
    const { escrow, usd, buyer, payee, treasury, other } = ctx;
    const r = rng(0xc1a05e);
    const accounts = [buyer, payee, treasury, other];
    const resolved = new Map(); // callId → status
    const outstanding = []; // vouchers not yet settled
    const service1Before = await escrow.getService(1);
    let paidCount = 0;

    async function checkI1() {
      let sum = 0n;
      for (const a of accounts) sum += await escrow.balanceOf(a, usd);
      expect(sum).to.equal(await escrow.totalBalance(usd), 'Σ balances == totalBalance');
      expect(sum).to.be.lte(await usd.balanceOf(escrow), 'Σ balances ≤ token balance');
    }

    for (let step = 0; step < 150; step++) {
      const op = r();
      if (op < 0.45) {
        // settle a fresh call (random verdict / random validity)
        const { voucher } = await makeVoucher(ctx, { serviceId: r() < 0.5 ? 1n : 2n });
        const kind = r();
        const att =
          kind < 0.5
            ? await makeAttestation(ctx, voucher)
            : kind < 0.8
              ? await makeFailureAttestation(ctx, voucher)
              : await makeAttestation(ctx, voucher, { arrival: voucher.deadline + 1000 });
        const buyerBefore = await escrow.balanceOf(buyer, usd);
        const payeeBefore = await escrow.balanceOf(payee, usd);
        await escrow.connect(other).settleBatch([voucher], [att]); // buyer "vanished": a stranger settles
        const status = Number(await escrow.callStatus(voucher.callId));
        if (status !== 0) resolved.set(voucher.callId, { voucher, att, status });
        if (status === 1) {
          paidCount++;
          expect(await escrow.balanceOf(payee, usd)).to.be.gt(payeeBefore, 'I4 seller paid');
          expect(await escrow.balanceOf(buyer, usd)).to.equal(buyerBefore - PRICE);
        } else if (status === 2) {
          expect(await escrow.balanceOf(buyer, usd)).to.equal(buyerBefore, 'refund restores buyer');
        }
      } else if (op < 0.6 && resolved.size) {
        // I2: try to resolve a resolved call again (settle and reclaim)
        const entries = [...resolved.values()];
        const e = entries[Math.floor(r() * entries.length)];
        await escrow.settleBatch([e.voucher], [e.att]);
        expect(Number(await escrow.callStatus(e.voucher.callId))).to.equal(e.status, 'I2 resolves once');
      } else if (op < 0.7) {
        const { voucher } = await makeVoucher(ctx);
        outstanding.push(voucher);
      } else if (op < 0.78 && outstanding.length) {
        await network.provider.send('evm_increaseTime', [130]);
        await network.provider.send('evm_mine');
        const v = outstanding.shift();
        const before = await escrow.balanceOf(buyer, usd);
        await escrow.reclaim(v.callId, v);
        expect(await escrow.balanceOf(buyer, usd)).to.equal(before, 'reclaim moves no funds');
        resolved.set(v.callId, { voucher: v, att: await makeFailureAttestation(ctx, v), status: 3 });
      } else if (op < 0.86) {
        const amt = BigInt(1 + Math.floor(r() * 50_000));
        await usd.mint(buyer.address, amt);
        await escrow.connect(buyer).deposit(usd, amt);
      } else if (op < 0.93) {
        const bal = await escrow.balanceOf(buyer, usd);
        if (bal > 0n) await escrow.connect(buyer).requestWithdraw(usd, bal / 4n + 1n);
      } else {
        const [amt] = await escrow.pendingWithdrawal(buyer, usd);
        if (amt > 0n) {
          await network.provider.send('evm_increaseTime', [901]);
          await network.provider.send('evm_mine');
          await escrow.connect(buyer).executeWithdraw(usd);
        }
      }
      await checkI1();
    }

    const after = await escrow.getService(1);
    expect(after).to.deep.equal(service1Before, 'I5 immutable');
    expect(paidCount).to.be.gt(0);
  });
});
