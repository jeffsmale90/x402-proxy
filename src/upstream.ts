import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { wrapFetchWithPayment } from "@x402/fetch";

import { proxyAccount } from "./config.js";

/** Hop-by-hop and transport headers that must not be forwarded either way. */
const HOP_BY_HOP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
  "content-length",
  // fetch handles compression transparently; forwarded bodies are decompressed
  "accept-encoding",
  "content-encoding",
]);

export interface ProxiedRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer | undefined;
}

function buildForwardHeaders(
  incoming: ProxiedRequest["headers"],
  options: { stripPayment: boolean },
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (options.stripPayment && lower === "payment-signature") continue;
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item);
    }
  }
  return headers;
}

function buildRequestInit(
  request: ProxiedRequest,
  options: { stripPayment: boolean },
): RequestInit {
  const init: RequestInit = {
    method: request.method,
    headers: buildForwardHeaders(request.headers, options),
    redirect: "manual",
  };
  if (
    request.body &&
    request.body.length > 0 &&
    !["GET", "HEAD"].includes(request.method.toUpperCase())
  ) {
    init.body = new Uint8Array(request.body);
  }
  return init;
}

/**
 * Forwards the caller's request to the target as-is (minus hop-by-hop
 * headers, and minus the payment header when `stripPayment` is set).
 */
export function forwardToTarget(
  target: string,
  request: ProxiedRequest,
  options: { stripPayment: boolean } = { stripPayment: false },
): Promise<Response> {
  return fetch(target, buildRequestInit(request, options));
}

/**
 * Decodes the x402 v2 PAYMENT-REQUIRED header from an upstream 402 response.
 * Returns undefined when the response is not a decodable v2 challenge.
 */
export function decodeUpstreamPaymentRequired(
  response: Response,
): PaymentRequired | undefined {
  const header = response.headers.get("payment-required");
  if (!header) return undefined;
  try {
    const paymentRequired = decodePaymentRequiredHeader(header);
    if (paymentRequired.x402Version !== 2) return undefined;
    if (!Array.isArray(paymentRequired.accepts)) return undefined;
    return paymentRequired;
  } catch (error) {
    console.warn(`Failed to decode upstream PAYMENT-REQUIRED header: ${error}`);
    return undefined;
  }
}

/**
 * Requests the target, paying with an EIP-3009 signature from the proxy EOA
 * when challenged. A policy pins the payment to the exact network/asset and
 * caps the amount at what the caller settled with the proxy, so the proxy can
 * never be induced to overpay.
 */
export function payUpstream(
  target: string,
  request: ProxiedRequest,
  settled: Pick<PaymentRequirements, "network" | "asset" | "amount">,
): Promise<Response> {
  const client = new x402Client()
    .register("eip155:*", new ExactEvmScheme(toClientEvmSigner(proxyAccount)))
    .registerPolicy((_version, requirements) =>
      requirements.filter((requirement) => {
        const transferMethod = requirement.extra?.assetTransferMethod;
        return (
          requirement.scheme === "exact" &&
          requirement.network === settled.network &&
          requirement.asset.toLowerCase() === settled.asset.toLowerCase() &&
          BigInt(requirement.amount) <= BigInt(settled.amount) &&
          (transferMethod === undefined || transferMethod === "eip3009")
        );
      }),
    );

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  return fetchWithPayment(target, buildRequestInit(request, { stripPayment: true }));
}
