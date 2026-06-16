import express, {
  type Request,
  type Response as ExpressResponse,
} from "express";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type {
  PaymentPayload,
  PaymentRequired,
  SettleResponse,
} from "@x402/core/types";

import { MAX_BODY_SIZE, PORT, proxyAccount } from "./config.js";
import {
  X402_VERSION,
  buildErc7710Requirements,
  findMatchingRequirement,
  initPayments,
  isProxyErc7710Payload,
  settlePayment,
  verifyPayment,
} from "./payments.js";
import {
  type ProxiedRequest,
  decodeUpstreamPaymentRequired,
  forwardToTarget,
  payUpstream,
} from "./upstream.js";

const app = express();
app.use(express.raw({ type: () => true, limit: MAX_BODY_SIZE }));

/** Response headers that are managed by the proxy or invalid after buffering. */
const SUPPRESSED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "payment-response",
]);

async function pipeResponse(
  res: ExpressResponse,
  upstream: Response,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  res.status(upstream.status);
  upstream.headers.forEach((value, name) => {
    if (SUPPRESSED_RESPONSE_HEADERS.has(name.toLowerCase())) return;
    res.append(name, value);
  });
  // Preserve the target's own settlement receipt under a distinct name; the
  // PAYMENT-RESPONSE header is reserved for the proxy's own settlement.
  const upstreamReceipt = upstream.headers.get("payment-response");
  if (upstreamReceipt) res.set("X-UPSTREAM-PAYMENT-RESPONSE", upstreamReceipt);
  for (const [name, value] of Object.entries(extraHeaders)) {
    res.set(name, value);
  }
  const body = Buffer.from(await upstream.arrayBuffer());
  res.send(body);
}

function sendPaymentRequired(
  req: Request,
  res: ExpressResponse,
  upstream: PaymentRequired,
  erc7710Accepts: PaymentRequired["accepts"],
  error?: string,
): void {
  const paymentRequired: PaymentRequired = {
    x402Version: X402_VERSION,
    ...(error ?? upstream.error ? { error: error ?? upstream.error } : {}),
    resource: {
      ...upstream.resource,
      url: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
    },
    accepts: [...erc7710Accepts, ...upstream.accepts],
    ...(upstream.extensions ? { extensions: upstream.extensions } : {}),
  };
  res
    .status(402)
    .set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired))
    .json({
      x402Version: X402_VERSION,
      error: paymentRequired.error ?? "Payment required",
      note: "Payment requirements are in the PAYMENT-REQUIRED header. ERC-7710 delegation payments are settled by this proxy; remaining options are passed through to the target.",
    });
}

function toProxiedRequest(req: Request): ProxiedRequest {
  return {
    method: req.method,
    headers: req.headers,
    body: Buffer.isBuffer(req.body) ? req.body : undefined,
  };
}

function parseTarget(req: Request): string | undefined {
  const target = req.query.target;
  if (typeof target !== "string" || target.length === 0) return undefined;
  try {
    const url = new URL(target);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return target;
  } catch {
    return undefined;
  }
}

function parsePaymentPayload(req: Request): {
  payload?: PaymentPayload;
  error?: string;
} {
  const header = req.header("payment-signature");
  if (!header) return {};
  try {
    return { payload: decodePaymentSignatureHeader(header) };
  } catch {
    return { error: "Malformed PAYMENT-SIGNATURE header" };
  }
}

/**
 * Handles a request carrying an ERC-7710 payment addressed to the proxy:
 * re-derives the upstream requirements, verifies and settles the delegation
 * payment via the facilitator, then pays the target with EIP-3009 and pipes
 * the result back.
 */
async function handlePaidRequest(
  req: Request,
  res: ExpressResponse,
  target: string,
  payload: PaymentPayload,
): Promise<void> {
  const request = toProxiedRequest(req);

  // Re-derive the upstream requirements; this also confirms the target still
  // requires payment at all.
  const probe = await forwardToTarget(target, request, { stripPayment: true });
  if (probe.status !== 402) {
    await pipeResponse(res, probe);
    return;
  }
  const upstream = decodeUpstreamPaymentRequired(probe);
  if (!upstream) {
    await pipeResponse(res, probe);
    return;
  }

  const erc7710Accepts = await buildErc7710Requirements(upstream.accepts);
  const matched = findMatchingRequirement(erc7710Accepts, payload);
  if (!matched) {
    sendPaymentRequired(
      req,
      res,
      upstream,
      erc7710Accepts,
      "Payment does not match current payment requirements",
    );
    return;
  }

  const verification = await verifyPayment(payload, matched);
  if (!verification.isValid) {
    sendPaymentRequired(
      req,
      res,
      upstream,
      erc7710Accepts,
      verification.invalidReason ?? "Payment verification failed",
    );
    return;
  }

  const settlement = await settlePayment(payload, matched);
  if (!settlement.success) {
    sendPaymentRequired(
      req,
      res,
      upstream,
      erc7710Accepts,
      settlement.errorReason ?? "Payment settlement failed",
    );
    return;
  }
  const receipt = encodePaymentResponseHeader(settlement);

  try {
    const paid = await payUpstream(target, request, matched);
    await pipeResponse(res, paid, { "PAYMENT-RESPONSE": receipt });
  } catch (error) {
    // The caller's payment settled but the upstream payment failed. Return
    // the settlement receipt so the caller has proof of payment.
    console.error(`Upstream payment to ${target} failed:`, error);
    res
      .status(502)
      .set("PAYMENT-RESPONSE", receipt)
      .json({
        error: "Payment settled, but the upstream paid request failed",
        detail: error instanceof Error ? error.message : String(error),
      });
  }
}

/**
 * Handles a request with no proxy-addressed payment: forwards it as-is and,
 * when the target responds 402, augments the challenge with ERC-7710 options.
 */
async function handleUnpaidRequest(
  req: Request,
  res: ExpressResponse,
  target: string,
): Promise<void> {
  const response = await forwardToTarget(target, toProxiedRequest(req));
  if (response.status !== 402) {
    await pipeResponse(res, response);
    return;
  }
  const upstream = decodeUpstreamPaymentRequired(response);
  if (!upstream) {
    await pipeResponse(res, response);
    return;
  }
  const erc7710Accepts = await buildErc7710Requirements(upstream.accepts);
  if (erc7710Accepts.length === 0) {
    await pipeResponse(res, response);
    return;
  }
  sendPaymentRequired(req, res, upstream, erc7710Accepts);
}

async function handleProxyRequest(req: Request, res: ExpressResponse): Promise<void> {
  const target = parseTarget(req);
  if (!target) {
    res.status(400).json({
      error: "Missing or invalid 'target' query parameter (must be an http(s) URL)",
    });
    return;
  }

  const { payload, error } = parsePaymentPayload(req);
  if (error) {
    res.status(400).json({ error });
    return;
  }

  if (payload && isProxyErc7710Payload(payload)) {
    await handlePaidRequest(req, res, target, payload);
  } else {
    // No payment, or a payment addressed to the target itself: dumb pipe.
    await handleUnpaidRequest(req, res, target);
  }
}

const proxyHandler = (req: Request, res: ExpressResponse): void => {
  handleProxyRequest(req, res).catch((error: unknown) => {
    console.error("Proxy error:", error);
    if (!res.headersSent) {
      res.status(502).json({
        error: "Upstream request failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });
};

app.get("/proxy", proxyHandler);
app.post("/proxy", proxyHandler);
app.put("/proxy", proxyHandler);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", payee: proxyAccount.address });
});

async function main(): Promise<void> {
  await initPayments();
  app.listen(PORT, () => {
    console.log(`[x402-proxy] listening on http://localhost:${PORT}`);
    console.log(`[x402-proxy] payee/payer EOA: ${proxyAccount.address}`);
    console.log(
      `[x402-proxy] usage: GET|POST|PUT /proxy?target=<encoded target URL>`,
    );
  });
}

main().catch((error: unknown) => {
  console.error("Failed to start x402-proxy:", error);
  process.exit(1);
});
