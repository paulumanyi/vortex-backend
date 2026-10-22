import { Keypair } from "@stellar/stellar-sdk";

/**
 * Build the canonical message a solver signs to update its mutable profile
 * (issue #273). Kept stable so existing clients keep working.
 */
export function buildUpdateSolverMessage(address: string): string {
  return `update-solver:${address}`;
}

/**
 * Build the canonical message a solver signs to change its active status
 * (deactivate / reactivate / deregister).
 */
export function buildSolverStatusMessage(address: string, action: string): string {
  return `solver-status:${address}:${action}`;
}

/**
 * Build the canonical message the primary solver address signs to add or
 * remove a delegated operational signer (issue #639).
 */
export function buildDelegateMessage(
  address: string,
  action: "add" | "remove",
  delegateAddress: string,
): string {
  return `solver-delegate:${address}:${action}:${delegateAddress}`;
}

/**
 * Verify that `signature` (base64) over `message` was produced by `address`.
 */
export function verifyStellarSignature(
  address: string,
  message: string,
  signature: string,
): boolean {
  try {
    const keypair = Keypair.fromPublicKey(address);
    return keypair.verify(Buffer.from(message), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}
