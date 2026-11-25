// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IClauseProcessor} from "./interfaces/IClauseProcessor.sol";

/// @title ClauseEscrow — a refund layer for x402 machine payments.
/// @notice No owner. No upgradeability. No pause. No admin withdrawal.
///         The contract routes on the chip's output; it holds no rules of its own.
///         Funds move only via verdict, reclaim, or the buyer/payee's own delayed withdraw.
contract ClauseEscrow is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Constants ────────────────────────────────────────────────────────────
    /// @dev Must exceed the maximum voucher lifetime (PRD §5: "use 15 min").
    uint256 public constant WITHDRAW_DELAY = 15 minutes;
    /// @dev expiry − issuedAt is capped so every voucher signed before a withdraw request
    ///      expires before that withdrawal can execute.
    uint32 public constant MAX_VOUCHER_LIFETIME = 10 minutes;
    uint16 public constant MAX_FEE_BPS = 1_000;
    uint256 public constant INPUT_LENGTH = 41;

    bytes32 public constant VOUCHER_TYPEHASH = keccak256(
        "Voucher(bytes32 callId,address buyer,uint256 serviceId,uint64 nonce,uint96 maxAmount,bytes8 sealedHash,uint32 quotedValue,uint32 tolerance,uint32 issuedAt,uint32 deadline,uint32 expiry)"
    );
    bytes32 public constant SELLER_RECEIPT_TYPEHASH =
        keccak256("SellerReceipt(bytes32 callId,bytes8 responseHash,uint32 deliveredValue)");
    bytes32 public constant GATEWAY_ATTESTATION_TYPEHASH = keccak256(
        "GatewayAttestation(bytes32 callId,bytes8 responseHash,uint32 deliveredValue,uint32 arrival,bool statusOK)"
    );

    // ─── Types ────────────────────────────────────────────────────────────────
    enum CallStatus {
        Unused,
        Paid,
        Refunded,
        Reclaimed
    }

    /// @dev Mirrored in packages/core/src/escrow-abi.ts (SKIP_REASONS).
    enum SkipReason {
        None,
        LengthMismatch,
        BadVoucherSig,
        BadSellerSig,
        BadGatewaySig,
        CallAlreadyResolved,
        VoucherExpired,
        MaxAmountBelowPrice,
        IssuedAfterWithdrawRequest,
        InsufficientBalance,
        UnknownService,
        ProcessorCallFailed,
        CallIdMismatch,
        BadFailureAttestation,
        VoucherLifetimeTooLong
    }

    /// @notice All fields immutable after registration.
    /// @dev `gateway` is an addition to the PRD struct: the address whose signature over
    ///      {arrival, statusOK} the escrow accepts. Without it, anyone could call the
    ///      permissionless settleBatch with a rewritten arrival and force a refund.
    struct Service {
        address processor;
        uint256 circuitId;
        address payee;
        address signer;
        address gateway;
        address token;
        uint96 price;
        uint32 grace;
        uint16 feeBps;
    }

    struct Voucher {
        bytes32 callId;
        address buyer;
        uint256 serviceId;
        uint64 nonce;
        uint96 maxAmount;
        bytes8 sealedHash;
        uint32 quotedValue;
        uint32 tolerance;
        uint32 issuedAt;
        uint32 deadline;
        uint32 expiry;
        bytes sig; // buyer EIP-712
    }

    struct Attestation {
        bytes32 callId;
        bytes8 responseHash;
        uint32 deliveredValue;
        uint32 arrival;
        bool statusOK;
        bytes sellerSig; // empty only on the failure path (statusOK == false)
        bytes gatewaySig;
    }

    struct Withdrawal {
        uint256 amount;
        uint64 requestedAt;
    }

    // ─── Immutable configuration ──────────────────────────────────────────────
    address public immutable treasury;
    uint16 public immutable feeBps;

    // ─── State ────────────────────────────────────────────────────────────────
    uint256 public serviceCount;
    mapping(uint256 => Service) private _services;
    /// @notice account => token => internal balance (buyers, payees, treasury).
    mapping(address => mapping(address => uint256)) public balanceOf;
    /// @notice token => Σ balanceOf. Invariant: totalBalance[token] ≤ token.balanceOf(this).
    mapping(address => uint256) public totalBalance;
    mapping(address => mapping(address => Withdrawal)) public pendingWithdrawal;
    mapping(bytes32 => CallStatus) public callStatus;

    // ─── Events ───────────────────────────────────────────────────────────────
    event ServiceRegistered(
        uint256 indexed serviceId,
        address indexed payee,
        address processor,
        uint256 circuitId,
        address signer,
        address gateway,
        address token,
        uint96 price,
        uint32 grace,
        uint16 feeBps
    );
    event Deposited(address indexed account, address indexed token, uint256 amount, address indexed from);
    event WithdrawRequested(address indexed account, address indexed token, uint256 amount, uint64 requestedAt);
    event Withdrawn(address indexed account, address indexed token, uint256 amount);
    /// @notice Replayable by anyone: feed `input` to the circuit and compare `verdict`.
    event Adjudicated(bytes32 indexed callId, uint256 circuitId, uint8 verdict, bytes input);
    event Paid(bytes32 indexed callId, uint256 indexed serviceId, address payee, uint256 amount, uint256 fee);
    event Refunded(bytes32 indexed callId, uint256 indexed serviceId, address buyer, uint256 amount);
    event Reclaimed(bytes32 indexed callId, address indexed buyer);
    event Skipped(bytes32 indexed callId, uint8 reason);

    // ─── Errors ───────────────────────────────────────────────────────────────
    error ZeroAddress();
    error InvalidParam();
    error NotAContract();
    error LengthMismatch();
    error UnknownService();
    error BadInputLength();
    error ProcessorCallFailed();
    error NothingPending();
    error WithdrawLocked(uint256 unlocksAt);
    error InsufficientBalance();
    error CallIdMismatch();
    error AlreadyResolved();
    error NotExpired();
    error BadVoucherSig();

    constructor(address treasury_, uint16 feeBps_) EIP712("ClauseEscrow", "1") {
        if (treasury_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert InvalidParam();
        treasury = treasury_;
        feeBps = feeBps_;
    }

    // ─── Services ─────────────────────────────────────────────────────────────
    function registerService(
        address processor,
        uint256 circuitId,
        address payee,
        address signer,
        address gateway,
        address token,
        uint96 price,
        uint32 grace
    ) external returns (uint256 serviceId) {
        if (processor == address(0) || payee == address(0) || signer == address(0) || gateway == address(0) || token == address(0)) {
            revert ZeroAddress();
        }
        if (processor.code.length == 0 || token.code.length == 0) revert NotAContract();
        if (price == 0) revert InvalidParam();

        serviceId = ++serviceCount;
        _services[serviceId] = Service({
            processor: processor,
            circuitId: circuitId,
            payee: payee,
            signer: signer,
            gateway: gateway,
            token: token,
            price: price,
            grace: grace,
            feeBps: feeBps
        });
        emit ServiceRegistered(serviceId, payee, processor, circuitId, signer, gateway, token, price, grace, feeBps);
    }

    function getService(uint256 serviceId) external view returns (Service memory) {
        if (serviceId == 0 || serviceId > serviceCount) revert UnknownService();
        return _services[serviceId];
    }

    // ─── Funds ────────────────────────────────────────────────────────────────
    function deposit(address token, uint256 amount) external nonReentrant {
        _deposit(msg.sender, token, amount);
    }

    /// @notice Credit another account (e.g. fund an agent's escrow balance). Pulls from msg.sender.
    function depositFor(address beneficiary, address token, uint256 amount) external nonReentrant {
        if (beneficiary == address(0)) revert ZeroAddress();
        _deposit(beneficiary, token, amount);
    }

    function _deposit(address account, address token, uint256 amount) internal {
        if (amount == 0) revert InvalidParam();
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        balanceOf[account][token] += received;
        totalBalance[token] += received;
        emit Deposited(account, token, received, msg.sender);
    }

    /// @notice Start the 15-minute withdraw delay. Vouchers issued after this moment are rejected.
    function requestWithdraw(address token, uint256 amount) external {
        if (amount == 0) revert InvalidParam();
        if (amount > balanceOf[msg.sender][token]) revert InsufficientBalance();
        uint64 nowTs = uint64(block.timestamp);
        pendingWithdrawal[msg.sender][token] = Withdrawal({amount: amount, requestedAt: nowTs});
        emit WithdrawRequested(msg.sender, token, amount, nowTs);
    }

    function executeWithdraw(address token) external nonReentrant {
        Withdrawal memory w = pendingWithdrawal[msg.sender][token];
        if (w.amount == 0) revert NothingPending();
        uint256 unlocksAt = uint256(w.requestedAt) + WITHDRAW_DELAY;
        if (block.timestamp < unlocksAt) revert WithdrawLocked(unlocksAt);
        uint256 bal = balanceOf[msg.sender][token];
        uint256 amount = w.amount < bal ? w.amount : bal; // settlements during the delay may have reduced it
        delete pendingWithdrawal[msg.sender][token];
        balanceOf[msg.sender][token] = bal - amount;
        totalBalance[token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, token, amount);
    }

    // ─── Settlement ───────────────────────────────────────────────────────────
    /// @notice Permissionless. Each item is settled or skipped (with a Skipped event) independently.
    function settleBatch(Voucher[] calldata v, Attestation[] calldata a) external nonReentrant {
        if (v.length != a.length) revert LengthMismatch();
        for (uint256 i; i < v.length; ++i) {
            SkipReason r = _settle(v[i], a[i]);
            if (r != SkipReason.None) emit Skipped(v[i].callId, uint8(r));
        }
    }

    /// @dev PRD §5 "settleBatch — exact order per call". The processor is evaluated before any
    ///      state write so a skipped item leaves no trace; the observable effect equals the
    ///      PRD order (debit → eval → route) executed atomically.
    function _settle(Voucher calldata v, Attestation calldata a) internal returns (SkipReason) {
        if (a.callId != v.callId) return SkipReason.CallIdMismatch;
        if (v.serviceId == 0 || v.serviceId > serviceCount) return SkipReason.UnknownService;
        Service storage s = _services[v.serviceId];

        // 1. Recover voucher signer == buyer.
        if (v.buyer == address(0) || _recover(_voucherDigest(v), v.sig) != v.buyer) return SkipReason.BadVoucherSig;

        // 2. Recover sellerSig over {callId, responseHash, deliveredValue} == service.signer.
        //    Failure path: if the seller never answered, there is nothing for it to sign. The gateway
        //    (already trusted for statusOK, PRD §8) may then attest statusOK = false with zeroed
        //    delivery fields. Every template ANDs statusOK, so this path can only produce a refund.
        if (a.statusOK || a.sellerSig.length != 0) {
            if (_recover(_sellerDigest(a), a.sellerSig) != s.signer) return SkipReason.BadSellerSig;
        } else if (a.responseHash != bytes8(0) || a.deliveredValue != 0) {
            return SkipReason.BadFailureAttestation;
        }
        //    Gateway signature over {arrival, statusOK} (see Service.gateway).
        if (_recover(_gatewayDigest(a), a.gatewaySig) != s.gateway) return SkipReason.BadGatewaySig;

        // 3. Reject if callId used, now > expiry, or maxAmount < price.
        if (callStatus[v.callId] != CallStatus.Unused) return SkipReason.CallAlreadyResolved;
        if (block.timestamp > v.expiry) return SkipReason.VoucherExpired;
        if (v.maxAmount < s.price) return SkipReason.MaxAmountBelowPrice;
        if (v.expiry < v.issuedAt || v.expiry - v.issuedAt > MAX_VOUCHER_LIFETIME) return SkipReason.VoucherLifetimeTooLong;

        // 4. Reject if pending withdrawal and issuedAt > withdrawRequestedAt.
        Withdrawal storage w = pendingWithdrawal[v.buyer][s.token];
        if (w.amount != 0 && v.issuedAt > w.requestedAt) return SkipReason.IssuedAfterWithdrawRequest;

        uint256 price = s.price;
        if (balanceOf[v.buyer][s.token] < price) return SkipReason.InsufficientBalance;

        // 6. Build 41-byte input: commitments from voucher, delivery from attestation, grace from service.
        bytes memory input = _buildInput(v, a, s.grace);

        // 7. processor.eval(circuitId, input) → verdict.
        (bool ok, uint8 verdict) = _eval(s.processor, s.circuitId, input);
        if (!ok) return SkipReason.ProcessorCallFailed;

        // 5. Debit price from buyer balance; mark used.
        balanceOf[v.buyer][s.token] -= price;
        callStatus[v.callId] = verdict == 1 ? CallStatus.Paid : CallStatus.Refunded;

        // 8. 1 → price − fee to payee, fee to fixed treasury. 0 → credit buyer.
        if (verdict == 1) {
            uint256 fee = (price * s.feeBps) / 10_000;
            balanceOf[s.payee][s.token] += price - fee;
            if (fee != 0) balanceOf[treasury][s.token] += fee;
            emit Paid(v.callId, v.serviceId, s.payee, price - fee, fee);
        } else {
            balanceOf[v.buyer][s.token] += price;
            emit Refunded(v.callId, v.serviceId, v.buyer, price);
        }

        // 9. Emit Adjudicated(callId, circuitId, verdict, fullInputBytes).
        emit Adjudicated(v.callId, s.circuitId, verdict, input);
        return SkipReason.None;
    }

    /// @notice Timeout reclaim: after expiry, finalize an unsettled call as refunded.
    /// @dev Funds never leave the buyer's balance before adjudication, so this moves no tokens;
    ///      it voids the voucher permanently and gives the call a terminal on-chain state.
    ///      Permissionless, but requires the buyer's real signature so nobody can grief a
    ///      seller by voiding a callId with a forged voucher.
    function reclaim(bytes32 callId, Voucher calldata v) external {
        if (v.callId != callId) revert CallIdMismatch();
        if (callStatus[callId] != CallStatus.Unused) revert AlreadyResolved();
        if (block.timestamp <= v.expiry) revert NotExpired();
        if (v.buyer == address(0) || _recover(_voucherDigest(v), v.sig) != v.buyer) revert BadVoucherSig();
        callStatus[callId] = CallStatus.Reclaimed;
        emit Reclaimed(callId, v.buyer);
    }

    /// @notice Gas-free verdict preview through the same processor the escrow uses.
    function previewVerdict(uint256 serviceId, bytes calldata input) external view returns (uint8) {
        if (serviceId == 0 || serviceId > serviceCount) revert UnknownService();
        if (input.length != INPUT_LENGTH) revert BadInputLength();
        Service storage s = _services[serviceId];
        (bool ok, uint8 verdict) = _eval(s.processor, s.circuitId, input);
        if (!ok) revert ProcessorCallFailed();
        return verdict;
    }

    // ─── Internals ────────────────────────────────────────────────────────────
    /// @dev [VERIFY — partner-owned] The ONLY place the processor ABI is assumed.
    ///      Any return value other than exactly 1 is treated as 0 (refund).
    function _eval(address processor, uint256 circuitId, bytes memory input) internal view returns (bool ok, uint8 verdict) {
        (bool success, bytes memory ret) =
            processor.staticcall(abi.encodeCall(IClauseProcessor.eval, (circuitId, input)));
        if (!success || ret.length < 32) return (false, 0);
        uint256 raw = abi.decode(ret, (uint256));
        return (true, raw == 1 ? 1 : 0);
    }

    /// @dev 41-byte unified input, PRD §4. Big-endian packed. [VERIFY against real eval ABI]
    function _buildInput(Voucher calldata v, Attestation calldata a, uint32 grace) internal pure returns (bytes memory) {
        return abi.encodePacked(
            a.responseHash, //  0..8   seller-signed attestation
            v.sealedHash, //    8..16  buyer voucher
            a.arrival, //      16..20  gateway attestation
            v.deadline, //     20..24  buyer voucher
            grace, //          24..28  service registration
            a.statusOK ? uint8(1) : uint8(0), // 28 gateway attestation
            a.deliveredValue, // 29..33 seller-signed attestation
            v.quotedValue, //  33..37  buyer voucher
            v.tolerance //     37..41  buyer voucher
        );
    }

    function _voucherDigest(Voucher calldata v) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    VOUCHER_TYPEHASH,
                    v.callId,
                    v.buyer,
                    v.serviceId,
                    v.nonce,
                    v.maxAmount,
                    v.sealedHash,
                    v.quotedValue,
                    v.tolerance,
                    v.issuedAt,
                    v.deadline,
                    v.expiry
                )
            )
        );
    }

    function _sellerDigest(Attestation calldata a) internal view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(SELLER_RECEIPT_TYPEHASH, a.callId, a.responseHash, a.deliveredValue)));
    }

    function _gatewayDigest(Attestation calldata a) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(GATEWAY_ATTESTATION_TYPEHASH, a.callId, a.responseHash, a.deliveredValue, a.arrival, a.statusOK)
            )
        );
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        return err == ECDSA.RecoverError.NoError ? signer : address(0);
    }

    /// @notice EIP-712 domain separator (for off-chain tooling).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
