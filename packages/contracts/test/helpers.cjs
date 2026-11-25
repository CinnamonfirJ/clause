const { ethers } = require('hardhat');

const VOUCHER_TYPES = {
  Voucher: [
    { name: 'callId', type: 'bytes32' },
    { name: 'buyer', type: 'address' },
    { name: 'serviceId', type: 'uint256' },
    { name: 'nonce', type: 'uint64' },
    { name: 'maxAmount', type: 'uint96' },
    { name: 'sealedHash', type: 'bytes8' },
    { name: 'quotedValue', type: 'uint32' },
    { name: 'tolerance', type: 'uint32' },
    { name: 'issuedAt', type: 'uint32' },
    { name: 'deadline', type: 'uint32' },
    { name: 'expiry', type: 'uint32' },
  ],
};
const SELLER_TYPES = {
  SellerReceipt: [
    { name: 'callId', type: 'bytes32' },
    { name: 'responseHash', type: 'bytes8' },
    { name: 'deliveredValue', type: 'uint32' },
  ],
};
const GATEWAY_TYPES = {
  GatewayAttestation: [
    { name: 'callId', type: 'bytes32' },
    { name: 'responseHash', type: 'bytes8' },
    { name: 'deliveredValue', type: 'uint32' },
    { name: 'arrival', type: 'uint32' },
    { name: 'statusOK', type: 'bool' },
  ],
};

const SKIP = {
  None: 0,
  LengthMismatch: 1,
  BadVoucherSig: 2,
  BadSellerSig: 3,
  BadGatewaySig: 4,
  CallAlreadyResolved: 5,
  VoucherExpired: 6,
  MaxAmountBelowPrice: 7,
  IssuedAfterWithdrawRequest: 8,
  InsufficientBalance: 9,
  UnknownService: 10,
  ProcessorCallFailed: 11,
  CallIdMismatch: 12,
  BadFailureAttestation: 13,
  VoucherLifetimeTooLong: 14,
};

const PRICE = 10_000n; // 0.01 at 6 decimals
const FEE_BPS = 100;
const GRACE = 5;

async function now() {
  return (await ethers.provider.getBlock('latest')).timestamp;
}

async function deployFixture() {
  const [deployer, treasury, gateway, seller, payee, buyer, other] = await ethers.getSigners();
  const usd = await (await ethers.getContractFactory('MockUSD')).deploy();
  const proc = await (await ethers.getContractFactory('MockRuleProcessor')).deploy();
  const escrow = await (await ethers.getContractFactory('ClauseEscrow')).deploy(treasury.address, FEE_BPS);
  await escrow.registerService(proc, 1, payee, seller, gateway, usd, PRICE, GRACE); // 1 = E
  await escrow.registerService(proc, 2, payee, seller, gateway, usd, PRICE, GRACE); // 2 = B
  await escrow.registerService(proc, 99, payee, seller, gateway, usd, PRICE, GRACE); // 3 = unknown circuit
  await usd.mint(buyer.address, 10_000_000n);
  await usd.connect(buyer).approve(escrow, ethers.MaxUint256);
  await escrow.connect(buyer).deposit(usd, 1_000_000n);
  const { chainId } = await ethers.provider.getNetwork();
  const domain = { name: 'ClauseEscrow', version: '1', chainId, verifyingContract: await escrow.getAddress() };
  return { deployer, treasury, gateway, seller, payee, buyer, other, usd, proc, escrow, domain };
}

function hash8(bytes) {
  return ethers.sha256(bytes).slice(0, 18);
}

let counter = 0;
async function makeVoucher(ctx, overrides = {}) {
  const t = await now();
  const body = ethers.toUtf8Bytes(`{"pair":"EURUSD","value":108320,"n":${counter++}}`);
  const v = {
    callId: ethers.hexlify(ethers.randomBytes(32)),
    buyer: ctx.buyer.address,
    serviceId: 1n,
    nonce: BigInt(counter),
    maxAmount: PRICE,
    sealedHash: hash8(body),
    quotedValue: 108320,
    tolerance: 50,
    issuedAt: t,
    deadline: t + 30,
    expiry: t + 120,
    ...overrides,
  };
  const signer = overrides.signer || ctx.buyer;
  delete v.signer;
  const sig = await signer.signTypedData(ctx.domain, VOUCHER_TYPES, v);
  return { voucher: { ...v, sig }, body };
}

async function makeAttestation(ctx, voucher, overrides = {}) {
  const t = await now();
  const a = {
    callId: voucher.callId,
    responseHash: voucher.sealedHash,
    deliveredValue: voucher.quotedValue,
    arrival: t,
    statusOK: true,
    ...overrides,
  };
  const sellerSigner = overrides.sellerSigner || ctx.seller;
  const gatewaySigner = overrides.gatewaySigner || ctx.gateway;
  delete a.sellerSigner;
  delete a.gatewaySigner;
  const sellerSig =
    overrides.sellerSig !== undefined
      ? overrides.sellerSig
      : await sellerSigner.signTypedData(ctx.domain, SELLER_TYPES, {
          callId: a.callId,
          responseHash: a.responseHash,
          deliveredValue: a.deliveredValue,
        });
  const gatewaySig =
    overrides.gatewaySig !== undefined
      ? overrides.gatewaySig
      : await gatewaySigner.signTypedData(ctx.domain, GATEWAY_TYPES, {
          callId: a.callId,
          responseHash: a.responseHash,
          deliveredValue: a.deliveredValue,
          arrival: a.arrival,
          statusOK: a.statusOK,
        });
  return { callId: a.callId, responseHash: a.responseHash, deliveredValue: a.deliveredValue, arrival: a.arrival, statusOK: a.statusOK, sellerSig, gatewaySig };
}

/** Failure-path attestation: seller unreachable → no seller signature, zeroed delivery fields. */
async function makeFailureAttestation(ctx, voucher, overrides = {}) {
  return makeAttestation(ctx, voucher, {
    responseHash: '0x0000000000000000',
    deliveredValue: 0,
    statusOK: false,
    sellerSig: '0x',
    ...overrides,
  });
}

function expectedInput(voucher, att, grace = GRACE) {
  return ethers.solidityPacked(
    ['bytes8', 'bytes8', 'uint32', 'uint32', 'uint32', 'uint8', 'uint32', 'uint32', 'uint32'],
    [att.responseHash, voucher.sealedHash, att.arrival, voucher.deadline, grace, att.statusOK ? 1 : 0, att.deliveredValue, voucher.quotedValue, voucher.tolerance],
  );
}

module.exports = {
  VOUCHER_TYPES,
  SELLER_TYPES,
  GATEWAY_TYPES,
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
  hash8,
};
