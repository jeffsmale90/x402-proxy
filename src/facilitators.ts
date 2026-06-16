import { HTTPFacilitatorClient } from "@x402/core/server";

const FACILITATOR_PATH = "/platform/v2/x402";

function facilitatorUrl(sentinelName: string): string {
  return `https://tx-sentinel-${sentinelName}.api.cx.metamask.io${FACILITATOR_PATH}`;
}

/**
 * MetaMask tx-sentinel facilitator endpoints.
 *
 * URL pattern: https://tx-sentinel-{chain}-{mainnet|sepolia|testnet}.api.cx.metamask.io/platform/v2/x402
 *
 * Network support is discovered from each facilitator's /supported response at startup.
 */
export const METAMASK_FACILITATOR_URLS = [
  // Ethereum
  facilitatorUrl("ethereum-mainnet"),
  facilitatorUrl("ethereum-sepolia"),
  // Base
  facilitatorUrl("base-mainnet"),
  facilitatorUrl("base-sepolia"),
  // Linea
  facilitatorUrl("linea-mainnet"),
  //facilitatorUrl("linea-sepolia"),
  // Monad
  facilitatorUrl("monad-mainnet"),
  //facilitatorUrl("monad-testnet"),
  // Arbitrum
  facilitatorUrl("arbitrum-mainnet"),
  //facilitatorUrl("arbitrum-sepolia"),
] as const;

export function createMetamaskFacilitatorClients(): HTTPFacilitatorClient[] {
  return METAMASK_FACILITATOR_URLS.map(
    (url) => new HTTPFacilitatorClient({ url }),
  );
}
