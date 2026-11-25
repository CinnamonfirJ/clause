/**
 * Deploy ClauseEscrow (+ dev mocks on local networks) and register the two demo FX services.
 *
 * Local (chainId 31337):
 *   deploys MockUSD + MockRuleProcessor (DEV MOCKS) and uses hardhat's well-known test accounts:
 *   #1 treasury · #2 gateway attester/crank · #3 seller signer · #4 seller payee · #5 demo funder
 *
 * X Layer (chainId 196) / testnet: requires the partner-provided TapeOut values. Never deploys mocks.
 *   PROCESSOR_ADDRESS, CIRCUIT_ID_E, CIRCUIT_ID_B   ← partner (TapeOut / "Tape X")
 *   TOKEN_ADDRESS (PRD §9 #5), TREASURY_ADDRESS, FEE_BPS
 *   REGISTER_DEMO_SERVICES=true + GATEWAY_ADDRESS, SELLER_SIGNER, SELLER_PAYEE, PRICE, GRACE
 */
const fs = require('fs');
const path = require('path');
const hre = require('hardhat');
const { ethers } = hre;

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name} (see docs/TAPE-X-INTEGRATION.md)`);
  return v;
}

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  const local = chainId === 31337n;
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const out = { network: hre.network.name, chainId: Number(chainId), deployedAt: new Date().toISOString(), devMocks: local };

  let processor, circuitE, circuitB, token, treasury, gateway, sellerSigner, payee;
  const feeBps = Number(process.env.FEE_BPS ?? 100);
  const price = BigInt(process.env.PRICE ?? 10_000); // 0.01 at 6 decimals
  const grace = Number(process.env.GRACE ?? 5);

  if (local) {
    const [, t, g, s, p, funder] = signers;
    const usd = await (await ethers.getContractFactory('MockUSD')).deploy();
    const mock = await (await ethers.getContractFactory('MockRuleProcessor')).deploy();
    await usd.waitForDeployment();
    await mock.waitForDeployment();
    processor = await mock.getAddress();
    token = await usd.getAddress();
    circuitE = 1n;
    circuitB = 2n;
    treasury = t.address;
    gateway = g.address;
    sellerSigner = s.address;
    payee = p.address;
    await (await usd.mint(funder.address, 1_000_000n * 10n ** 6n)).wait();
    out.demoFunder = funder.address;
    out.processorIsDevMock = true;
  } else {
    processor = req('PROCESSOR_ADDRESS');
    circuitE = BigInt(req('CIRCUIT_ID_E'));
    circuitB = BigInt(req('CIRCUIT_ID_B'));
    token = req('TOKEN_ADDRESS');
    treasury = req('TREASURY_ADDRESS');
    const code = await ethers.provider.getCode(processor);
    if (code === '0x') throw new Error('PROCESSOR_ADDRESS has no code');
    try {
      const probe = new ethers.Contract(processor, ['function NOTICE() view returns (string)'], ethers.provider);
      const notice = await probe.NOTICE();
      if (/DEV MOCK/.test(notice)) throw new Error('refusing to use the DEV MOCK processor on a public network');
    } catch (e) {
      if (/refusing/.test(String(e.message))) throw e;
    }
    out.processorIsDevMock = false;
  }

  const escrow = await (await ethers.getContractFactory('ClauseEscrow')).deploy(treasury, feeBps);
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();
  console.log(`ClauseEscrow ${escrowAddress} (treasury ${treasury}, feeBps ${feeBps})`);

  Object.assign(out, { escrow: escrowAddress, processor, token, treasury, feeBps, circuits: { E: circuitE.toString(), B: circuitB.toString() } });

  const shouldRegister = local || process.env.REGISTER_DEMO_SERVICES === 'true';
  if (shouldRegister) {
    if (!local) {
      gateway = req('GATEWAY_ADDRESS');
      sellerSigner = req('SELLER_SIGNER');
      payee = req('SELLER_PAYEE');
    }
    const register = async (circuitId) => {
      const tx = await escrow.registerService(processor, circuitId, payee, sellerSigner, gateway, token, price, grace);
      const rc = await tx.wait();
      const ev = rc.logs.map((l) => escrow.interface.parseLog(l)).find((l) => l && l.name === 'ServiceRegistered');
      return ev.args.serviceId.toString();
    };
    const sealed = await register(circuitE);
    const live = await register(circuitB);
    out.services = { fxSealed: { id: sealed, template: 'E' }, fxLive: { id: live, template: 'B' } };
    Object.assign(out, { gateway, sellerSigner, payee, price: price.toString(), grace });
    console.log(`registered services: E=${sealed} B=${live}`);
  }

  const dir = path.join(__dirname, '..', 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${hre.network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`wrote ${file}`);
  if (!local) console.log('Record escrow + processor + circuit IDs in SUBMISSION.md / README (PRD §13).');
  void deployer;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
