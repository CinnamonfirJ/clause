require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');

const accounts = process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      // Conservative target until X Layer opcode support is confirmed (PRD §9). Partner/deployer to verify.
      evmVersion: 'paris',
    },
  },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: process.env.LOCAL_RPC_URL || 'http://127.0.0.1:8545', chainId: 31337 },
    xlayer: {
      url: process.env.XLAYER_RPC_URL || 'https://rpc.xlayer.tech',
      chainId: 196,
      accounts,
    },
    xlayerTestnet: {
      // [VERIFY] X Layer testnet RPC/chainId — set via env before use.
      url: process.env.XLAYER_TESTNET_RPC_URL || '',
      chainId: Number(process.env.XLAYER_TESTNET_CHAIN_ID || 1952),
      accounts,
    },
  },
  mocha: { timeout: 300000 },
};
