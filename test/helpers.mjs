import { encodeBase64Json, decodeBase64Json } from "../dist/index.js";

export const TERMS = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "10000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};

export const PAYER = "0x857b06519E91e3A54538791bDbb0E22373e36b66";

let nonceCounter = 1;
export function freshNonce() {
  return "0x" + (nonceCounter++).toString(16).padStart(64, "0");
}

/** Build a v2 PaymentPayload; `id` adds the payment-identifier extension. */
export function payload({ id, nonce = freshNonce(), url = "https://api.example.com/reports", terms = TERMS, from = PAYER } = {}) {
  const p = {
    x402Version: 2,
    resource: { url, description: "Report", mimeType: "application/json" },
    accepted: { ...terms },
    payload: {
      signature: "0x" + "ab".repeat(65),
      authorization: {
        from,
        to: terms.payTo,
        value: terms.amount,
        validAfter: "1740672089",
        validBefore: "1740672154",
        nonce,
      },
    },
    extensions: {},
  };
  if (id) {
    p.extensions["payment-identifier"] = {
      info: { required: false, id },
      schema: { type: "object" },
    };
  }
  return p;
}

export function header(p) {
  return encodeBase64Json(p);
}

export function settleResponse(overrides = {}) {
  return {
    success: true,
    transaction: "0x" + "12".repeat(32),
    network: "eip155:84532",
    payer: PAYER,
    ...overrides,
  };
}

export function decodeSettle(res) {
  const h = typeof res.headers?.get === "function" ? res.headers.get("payment-response") : res.headers?.["payment-response"];
  return h ? decodeBase64Json(h) : undefined;
}

/** Fake adapter matching the official HTTPAdapter surface. */
export function adapter({ method = "POST", path = "/reports", query, body, headers = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    getHeader: name => lower[name.toLowerCase()],
    getMethod: () => method,
    getPath: () => path,
    getUrl: () => "https://api.example.com" + path,
    getAcceptHeader: () => "*/*",
    getUserAgent: () => "test",
    getQueryParams: () => query ?? {},
    getBody: () => body,
  };
}

export function transport(adapterOpts, response) {
  const tc = { request: { adapter: adapter(adapterOpts), routePattern: adapterOpts?.route } };
  if (response) {
    tc.responseBody = new TextEncoder().encode(typeof response.body === "string" ? response.body : JSON.stringify(response.body));
    tc.responseHeaders = { "content-type": response.contentType ?? "application/json", ...(response.headers ?? {}) };
  }
  return tc;
}
