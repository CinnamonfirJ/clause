/**
 * EIP-712 typed data shared by the escrow, gateway, seller and buyer agents.
 *
 * Domain (PRD §5): {name:"ClauseEscrow", version:"1", chainId:196, verifyingContract:<escrow>}
 *
 * - Voucher: signed by the buyer. Carries the commitment terms (sealedHash, quotedValue,
 *   tolerance, deadline). The gateway cannot change them after signing.
 * - SellerReceipt: signed by the service's registered signer over
 *   {callId, responseHash, deliveredValue} (PRD §5 settleBatch step 2).
 * - GatewayAttestation: signed by the service's registered gateway over arrival + statusOK.
 *   [Implementation decision] The PRD lists a gatewaySig but no step that verifies it.
 *   Without verification, anyone calling the permissionless settleBatch could rewrite
 *   arrival/statusOK and force a refund. ClauseEscrow therefore verifies it against
 *   Service.gateway (an immutable field added to Service). See docs/DECISIONS.md.
 */
import { Signature, TypedDataDomain, TypedDataEncoder, Wallet, getAddress, verifyTypedData } from 'ethers';

export const EIP712_NAME = 'ClauseEscrow';
export const EIP712_VERSION = '1';
export const XLAYER_CHAIN_ID = 196;

export function clauseDomain(chainId: number, verifyingContract: string): TypedDataDomain {
  return { name: EIP712_NAME, version: EIP712_VERSION, chainId, verifyingContract: getAddress(verifyingContract) };
}

export const VOUCHER_TYPES = {
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
} as const;

export const SELLER_RECEIPT_TYPES = {
  SellerReceipt: [
    { name: 'callId', type: 'bytes32' },
    { name: 'responseHash', type: 'bytes8' },
    { name: 'deliveredValue', type: 'uint32' },
  ],
} as const;

export const GATEWAY_ATTESTATION_TYPES = {
  GatewayAttestation: [
    { name: 'callId', type: 'bytes32' },
    { name: 'responseHash', type: 'bytes8' },
    { name: 'deliveredValue', type: 'uint32' },
    { name: 'arrival', type: 'uint32' },
    { name: 'statusOK', type: 'bool' },
  ],
} as const;

/** Voucher terms as JSON-safe values (bigints as decimal strings). */
export interface VoucherData {
  callId: string;
  buyer: string;
  serviceId: string;
  nonce: string;
  maxAmount: string;
  sealedHash: string;
  quotedValue: number;
  tolerance: number;
  issuedAt: number;
  deadline: number;
  expiry: number;
}

export interface SignedVoucher extends VoucherData {
  sig: string;
}

export interface SellerReceiptData {
  callId: string;
  responseHash: string;
  deliveredValue: number;
}

export interface AttestationData {
  callId: string;
  responseHash: string;
  deliveredValue: number;
  arrival: number;
  statusOK: boolean;
  /** Empty ("0x") on the failure path: seller unreachable, gateway attests statusOK = false. */
  sellerSig: string;
  gatewaySig: string;
}

export function voucherMessage(v: VoucherData) {
  return {
    callId: v.callId,
    buyer: getAddress(v.buyer),
    serviceId: BigInt(v.serviceId),
    nonce: BigInt(v.nonce),
    maxAmount: BigInt(v.maxAmount),
    sealedHash: v.sealedHash,
    quotedValue: v.quotedValue,
    tolerance: v.tolerance,
    issuedAt: v.issuedAt,
    deadline: v.deadline,
    expiry: v.expiry,
  };
}

type TypedSigner = Pick<Wallet, 'signTypedData'>;

export async function signVoucher(signer: TypedSigner, domain: TypedDataDomain, v: VoucherData): Promise<SignedVoucher> {
  const sig = await signer.signTypedData(domain, VOUCHER_TYPES as any, voucherMessage(v));
  return { ...v, sig };
}

export async function signSellerReceipt(signer: TypedSigner, domain: TypedDataDomain, r: SellerReceiptData): Promise<string> {
  return signer.signTypedData(domain, SELLER_RECEIPT_TYPES as any, r);
}

export async function signGatewayAttestation(
  signer: TypedSigner,
  domain: TypedDataDomain,
  a: Omit<AttestationData, 'sellerSig' | 'gatewaySig'>,
): Promise<string> {
  return signer.signTypedData(domain, GATEWAY_ATTESTATION_TYPES as any, a);
}

function safeRecover(fn: () => string): string | null {
  try {
    return getAddress(fn());
  } catch {
    return null;
  }
}

export function recoverVoucherSigner(domain: TypedDataDomain, v: SignedVoucher): string | null {
  return safeRecover(() => verifyTypedData(domain, VOUCHER_TYPES as any, voucherMessage(v), v.sig));
}

export function recoverSellerSigner(domain: TypedDataDomain, r: SellerReceiptData, sig: string): string | null {
  if (!sig || sig === '0x') return null;
  return safeRecover(() => verifyTypedData(domain, SELLER_RECEIPT_TYPES as any, r, sig));
}

export function recoverGatewaySigner(domain: TypedDataDomain, a: AttestationData): string | null {
  const { sellerSig: _s, gatewaySig, ...msg } = a;
  return safeRecover(() => verifyTypedData(domain, GATEWAY_ATTESTATION_TYPES as any, msg, gatewaySig));
}

export function voucherDigest(domain: TypedDataDomain, v: VoucherData): string {
  return TypedDataEncoder.hash(domain, VOUCHER_TYPES as any, voucherMessage(v));
}

export function sameAddress(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

export function isSignature(s: string): boolean {
  try {
    Signature.from(s);
    return true;
  } catch {
    return false;
  }
}
