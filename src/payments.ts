import { x402ResourceServer } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { x402ExactEvmErc7710ServerScheme } from "@metamask/x402";

import { proxyAccount } from "./config.js";
import { createMetamaskFacilitatorClients } from "./facilitators.js";

export const X402_VERSION = 2;

const resourceServer = new x402ResourceServer(createMetamaskFacilitatorClients()).register(
  "eip155:*",
  new x402ExactEvmErc7710ServerScheme(),
);

let initialized: Promise<void> | undefined;

/**
 * Fetches the facilitator's supported payment kinds. Must complete before
 * requirements can be built or payments verified/settled.
 */
export function initPayments(): Promise<void> {
  initialized ??= resourceServer.initialize();
  return initialized;
}

/**
 * True for upstream payment options the proxy can wrap with an ERC-7710
 * variant: exact-scheme EVM options payable by the proxy EOA via EIP-3009,
 * on a network the ERC-7710 facilitator supports.
 */
function isWrappable(requirement: PaymentRequirements): boolean {
  if (requirement.scheme !== "exact") return false;
  if (!requirement.network.startsWith("eip155:")) return false;
  const transferMethod = requirement.extra?.assetTransferMethod;
  if (transferMethod !== undefined && transferMethod !== "eip3009") return false;
  return (
    resourceServer.getSupportedKind(
      X402_VERSION,
      requirement.network,
      requirement.scheme,
    ) !== undefined
  );
}

/**
 * Builds the ERC-7710 payment options the proxy offers for a given set of
 * upstream payment requirements. Each wrappable upstream option gets a twin
 * with the same network/asset/amount but with the proxy EOA as payee and
 * `assetTransferMethod: "erc7710"`.
 */
export async function buildErc7710Requirements(
  upstreamAccepts: PaymentRequirements[],
): Promise<PaymentRequirements[]> {
  const requirements: PaymentRequirements[] = [];
  for (const upstream of upstreamAccepts) {
    if (!isWrappable(upstream)) continue;
    const extra = { ...upstream.extra };
    delete extra.assetTransferMethod;
    const built = await resourceServer.buildPaymentRequirements({
      scheme: upstream.scheme,
      network: upstream.network,
      payTo: proxyAccount.address,
      price: { amount: upstream.amount, asset: upstream.asset },
      maxTimeoutSeconds: upstream.maxTimeoutSeconds,
      extra: { ...extra, assetTransferMethod: "erc7710" },
    });
    requirements.push(...built);
  }
  return dedupeRequirements(requirements);
}

function dedupeRequirements(
  requirements: PaymentRequirements[],
): PaymentRequirements[] {
  const seen = new Set<string>();
  return requirements.filter((requirement) => {
    const key = JSON.stringify([
      requirement.network,
      requirement.asset,
      requirement.amount,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * True when an incoming payment payload is an ERC-7710 payment addressed to
 * this proxy (as opposed to a pass-through payment meant for the target).
 */
export function isProxyErc7710Payload(payload: PaymentPayload): boolean {
  const accepted = payload.accepted;
  return (
    accepted?.extra?.assetTransferMethod === "erc7710" &&
    typeof accepted.payTo === "string" &&
    accepted.payTo.toLowerCase() === proxyAccount.address.toLowerCase()
  );
}

export function findMatchingRequirement(
  requirements: PaymentRequirements[],
  payload: PaymentPayload,
): PaymentRequirements | undefined {
  return resourceServer.findMatchingRequirements(requirements, payload);
}

export function verifyPayment(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<VerifyResponse> {
  return resourceServer.verifyPayment(payload, requirements);
}

export function settlePayment(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<SettleResponse> {
  return resourceServer.settlePayment(payload, requirements);
}
