/**
 * Test buyer that pays through the proxy with an ERC-7710 delegation.
 *
 * Creates a MetaMask smart account for the buyer, signs an open delegation
 * via createx402DelegationProvider, and calls the proxy. The proxy settles
 * the delegation (buyer -> proxy EOA) and pays the upstream with EIP-3009.
 *
 * Env:
 *   BUYER_PRIVATE_KEY - EOA key controlling the buyer smart account.
 *                       The smart account must hold USDC on Base Sepolia.
 *   PROXY_URL         - proxy base URL (default http://localhost:4021)
 *   TARGET_URL        - upstream resource (default http://localhost:4022/api/hello)
 *   RPC_URL           - Base Sepolia RPC (default viem public default)
 */
import "dotenv/config";
import { createPublicClient, http, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  Implementation,
  toMetaMaskSmartAccount,
} from "@metamask/smart-accounts-kit";
import { createx402DelegationProvider } from "@metamask/smart-accounts-kit/experimental";
import { x402Erc7710Client } from "@metamask/x402";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { decodePaymentResponseHeader } from "@x402/core/http";

const buyerKey = process.env.BUYER_PRIVATE_KEY;
if (!buyerKey) throw new Error("BUYER_PRIVATE_KEY must be set");

const PROXY_URL = process.env.PROXY_URL ?? "http://localhost:4021";
const TARGET_URL = process.env.TARGET_URL ?? "http://localhost:4022/api/hello";

async function main(): Promise<void> {
  // Widen to a plain Chain to avoid op-stack formatter generics, which are
  // incompatible with the client type toMetaMaskSmartAccount expects.
  const publicClient = createPublicClient({
    chain: baseSepolia as Chain,
    transport: http(process.env.RPC_URL),
  });
  const buyerAccount = privateKeyToAccount(buyerKey as Hex);

  const buyerSmartAccount = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Hybrid,
    deployParams: [buyerAccount.address, [], [], []],
    deploySalt: "0x",
    signer: { account: buyerAccount },
  });
  console.log(`[buyer] smart account: ${buyerSmartAccount.address}`);
  console.log(`[buyer] fund it with USDC on Base Sepolia before running.`);

  const erc7710Client = new x402Erc7710Client({
    delegationProvider: createx402DelegationProvider({
      account: buyerSmartAccount,
    }),
  });

  const coreClient = new x402Client().register("eip155:*", erc7710Client);
  const fetchWithPayment = wrapFetchWithPayment(fetch, coreClient);

  const url = `${PROXY_URL}/proxy?target=${encodeURIComponent(TARGET_URL)}`;
  console.log(`[buyer] GET ${url}`);
  const response = await fetchWithPayment(url, { method: "GET" });

  console.log(`[buyer] status: ${response.status}`);
  const receipt = response.headers.get("payment-response");
  if (receipt) {
    console.log("[buyer] proxy settlement:", decodePaymentResponseHeader(receipt));
  }
  const upstreamReceipt = response.headers.get("x-upstream-payment-response");
  if (upstreamReceipt) {
    console.log(
      "[buyer] upstream settlement:",
      decodePaymentResponseHeader(upstreamReceipt),
    );
  }
  console.log("[buyer] body:", await response.text());
}

main().catch((error: unknown) => {
  console.error("[buyer] failed:", error);
  process.exit(1);
});
