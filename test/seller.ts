/**
 * Toy upstream x402 service for testing the proxy.
 *
 * Exposes GET/POST /api/hello charging 0.01 USDC on Base Sepolia via the
 * standard exact scheme (EIP-3009). The proxy wraps this with an ERC-7710
 * payment option.
 *
 * Env:
 *   SELLER_ADDRESS    - payout address (defaults to a throwaway test address)
 *   SELLER_PORT       - port to listen on (default 4022)
 */
import "dotenv/config";
import express from "express";
import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { RouteConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
const NETWORK_ID = "eip155:84532" as const; // Base Sepolia
const PORT = Number(process.env.SELLER_PORT ?? 4022);
const payTo =
  process.env.SELLER_ADDRESS ?? "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const facilitatorUrl =
  "https://tx-sentinel-base-sepolia.api.cx.metamask.io/platform/v2/x402";

const app = express();

const routeConfig: RouteConfig = {
  accepts: [
    {
      scheme: "exact",
      price: "$0.01",
      network: NETWORK_ID,
      payTo,
    },
  ],
  description: "Toy x402-protected resource",
  mimeType: "application/json",
};

app.use(
  paymentMiddleware(
    {
      "GET /api/hello": routeConfig,
      "POST /api/hello": routeConfig,
    },
    new x402ResourceServer(
      new HTTPFacilitatorClient({ url: facilitatorUrl }),
    ).register(NETWORK_ID, new ExactEvmScheme()),
  ),
);

app.get("/api/hello", (_req, res) => {
  res.json({ message: "Hello from the paid upstream!", at: new Date().toISOString() });
});
app.post("/api/hello", (req, res) => {
  res.json({ message: "Hello POST!", echo: req.body ?? null });
});
app.get("/api/free", (_req, res) => {
  res.json({ message: "This endpoint is free." });
});

app.listen(PORT, () => {
  console.log(`[seller] listening on http://localhost:${PORT}`);
  console.log(`[seller] paid endpoint: http://localhost:${PORT}/api/hello (0.01 USDC, ${NETWORK_ID})`);
  console.log(`[seller] payout address: ${payTo}`);
});
