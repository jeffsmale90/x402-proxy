import "dotenv/config";
import { isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const privateKey = process.env.PRIVATE_KEY;
if (!privateKey || !isHex(privateKey)) {
  throw new Error(
    "PRIVATE_KEY environment variable must be set to a 0x-prefixed 32-byte hex private key",
  );
}

/**
 * The proxy's EOA. It receives ERC-7710 settlements (as payTo of the wrapped
 * payment option) and signs EIP-3009 payments to upstream x402 services.
 */
export const proxyAccount = privateKeyToAccount(privateKey);

export const PORT = Number(process.env.PORT ?? 4021);

export const MAX_BODY_SIZE = process.env.MAX_BODY_SIZE ?? "10mb";
