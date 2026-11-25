/**
 * Human-readable ABI for ClauseEscrow. Kept in sync with the compiled artifact by
 * packages/contracts/test/abi-sync.test.cjs.
 */
export const VOUCHER_TUPLE =
  'tuple(bytes32 callId, address buyer, uint256 serviceId, uint64 nonce, uint96 maxAmount, bytes8 sealedHash, uint32 quotedValue, uint32 tolerance, uint32 issuedAt, uint32 deadline, uint32 expiry, bytes sig)';
export const ATTESTATION_TUPLE =
  'tuple(bytes32 callId, bytes8 responseHash, uint32 deliveredValue, uint32 arrival, bool statusOK, bytes sellerSig, bytes gatewaySig)';

export const CLAUSE_ESCROW_ABI = [
  'function registerService(address processor, uint256 circuitId, address payee, address signer, address gateway, address token, uint96 price, uint32 grace) returns (uint256 serviceId)',
  'function deposit(address token, uint256 amount)',
  'function depositFor(address beneficiary, address token, uint256 amount)',
  'function requestWithdraw(address token, uint256 amount)',
  'function executeWithdraw(address token)',
  `function settleBatch(${VOUCHER_TUPLE}[] v, ${ATTESTATION_TUPLE}[] a)`,
  `function reclaim(bytes32 callId, ${VOUCHER_TUPLE} v)`,
  'function previewVerdict(uint256 serviceId, bytes input) view returns (uint8)',
  'function getService(uint256 serviceId) view returns (tuple(address processor, uint256 circuitId, address payee, address signer, address gateway, address token, uint96 price, uint32 grace, uint16 feeBps))',
  'function serviceCount() view returns (uint256)',
  'function balanceOf(address account, address token) view returns (uint256)',
  'function totalBalance(address token) view returns (uint256)',
  'function pendingWithdrawal(address account, address token) view returns (uint256 amount, uint64 requestedAt)',
  'function callStatus(bytes32 callId) view returns (uint8)',
  'function treasury() view returns (address)',
  'function feeBps() view returns (uint16)',
  'function WITHDRAW_DELAY() view returns (uint256)',
  'function MAX_VOUCHER_LIFETIME() view returns (uint32)',
  'event ServiceRegistered(uint256 indexed serviceId, address indexed payee, address processor, uint256 circuitId, address signer, address gateway, address token, uint96 price, uint32 grace, uint16 feeBps)',
  'event Deposited(address indexed account, address indexed token, uint256 amount, address indexed from)',
  'event WithdrawRequested(address indexed account, address indexed token, uint256 amount, uint64 requestedAt)',
  'event Withdrawn(address indexed account, address indexed token, uint256 amount)',
  'event Adjudicated(bytes32 indexed callId, uint256 circuitId, uint8 verdict, bytes input)',
  'event Paid(bytes32 indexed callId, uint256 indexed serviceId, address payee, uint256 amount, uint256 fee)',
  'event Refunded(bytes32 indexed callId, uint256 indexed serviceId, address buyer, uint256 amount)',
  'event Reclaimed(bytes32 indexed callId, address indexed buyer)',
  'event Skipped(bytes32 indexed callId, uint8 reason)',
] as const;

/** Reasons emitted in Skipped(callId, reason). Mirror of ClauseEscrow.SkipReason. */
export const SKIP_REASONS = [
  'none',
  'length-mismatch',
  'bad-voucher-sig',
  'bad-seller-sig',
  'bad-gateway-sig',
  'call-already-resolved',
  'voucher-expired',
  'max-amount-below-price',
  'issued-after-withdraw-request',
  'insufficient-balance',
  'unknown-service',
  'processor-call-failed',
  'callid-mismatch',
  'bad-failure-attestation',
  'voucher-lifetime-too-long',
] as const;

/** Mirror of ClauseEscrow.MAX_VOUCHER_LIFETIME / WITHDRAW_DELAY (seconds). */
export const MAX_VOUCHER_LIFETIME = 600;
export const WITHDRAW_DELAY = 900;

/** ClauseEscrow.callStatus values. */
export const CALL_STATUS = ['unused', 'paid', 'refunded', 'reclaimed'] as const;
