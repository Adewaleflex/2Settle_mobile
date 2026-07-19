import crypto from "node:crypto";

const UPSTREAM_URL = "https://api.2settle.io/v1/payments";
const DEFAULT_UPSTREAM_PATH = "/v1/payments";

function json(res, status, body) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.status(status).json(body);
}

function cleanEnv(value) {
  return String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

function hmac(secretKey, payload, encoding = "hex") {
  return crypto.createHmac("sha256", secretKey).update(payload).digest(encoding);
}

function buildTimestamp() {
  const timestampUnit =
    cleanEnv(process.env.TWOSETTLE_TIMESTAMP_UNIT) || "milliseconds";
  return timestampUnit === "seconds"
    ? Math.floor(Date.now() / 1000).toString()
    : Date.now().toString();
}

function signRequest({ secretKey, method, path, timestamp, body }) {
  const signatureMode =
    cleanEnv(process.env.TWOSETTLE_SIGNATURE_MODE) || "postman-bodyhash";
  const signatureEncoding =
    cleanEnv(process.env.TWOSETTLE_SIGNATURE_ENCODING) || "hex";

  if (signatureMode === "postman-bodyhash") {
    const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
    const payload = `${timestamp}|${method}|${path}|${bodyHash}`;
    const hmacKey = crypto.createHash("sha256").update(secretKey).digest("hex");
    const digest = hmac(hmacKey, payload, signatureEncoding);
    return cleanEnv(process.env.TWOSETTLE_SIGNATURE_PREFIX) === "sha256"
      ? `sha256=${digest}`
      : digest;
  }

  const payload =
    signatureMode === "timestamp-dot-body"
      ? `${timestamp}.${body}`
      : [method, path, timestamp, body].join("\n");
  const digest = hmac(secretKey, payload, signatureEncoding);
  return cleanEnv(process.env.TWOSETTLE_SIGNATURE_PREFIX) === "sha256"
    ? `sha256=${digest}`
    : digest;
}

function pickString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

function normalizePayload(body) {
  const payer = body?.payer || {};
  return {
    type: body?.type || "gift",
    fiatAmount: Number(body?.fiatAmount || 0),
    chargeFrom: body?.chargeFrom || "fiat",
    fiatCurrency: body?.fiatCurrency || "NGN",
    crypto: body?.crypto || "USDT",
    network: body?.network || "erc20",
    payer: {
      chatId: String(payer.chatId || "7389201648"),
      phone: String(payer.phone || "2348067426882"),
    },
  };
}

function proxyDiagnostics(path) {
  return {
    upstreamUrl: UPSTREAM_URL,
    signaturePath: path,
    timestampUnit:
      cleanEnv(process.env.TWOSETTLE_TIMESTAMP_UNIT) || "milliseconds",
    signatureMode:
      cleanEnv(process.env.TWOSETTLE_SIGNATURE_MODE) || "postman-bodyhash",
    signatureEncoding:
      cleanEnv(process.env.TWOSETTLE_SIGNATURE_ENCODING) || "hex",
    signaturePrefix: cleanEnv(process.env.TWOSETTLE_SIGNATURE_PREFIX) || "none",
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  const apiKey = cleanEnv(process.env.TWOSETTLE_API_KEY);
  const secretKey = cleanEnv(process.env.TWOSETTLE_SECRET_KEY);

  if (!apiKey || !secretKey) {
    return json(res, 500, {
      ok: false,
      error: "Payment creation is not configured.",
      missing: {
        TWOSETTLE_API_KEY: !apiKey,
        TWOSETTLE_SECRET_KEY: !secretKey,
      },
    });
  }

  const payload = normalizePayload(req.body || {});
  if (!payload.fiatAmount || payload.fiatAmount <= 0) {
    return json(res, 400, {
      ok: false,
      error: "Valid fiatAmount is required.",
    });
  }

  const path = cleanEnv(process.env.TWOSETTLE_PAYMENTS_SIGNATURE_PATH) ||
    DEFAULT_UPSTREAM_PATH;
  const body = JSON.stringify(payload);
  const timestamp = buildTimestamp();
  const signature = signRequest({
    secretKey,
    method: "POST",
    path,
    timestamp,
    body,
  });

  try {
    const upstream = await fetch(UPSTREAM_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": apiKey,
        "x-timestamp": timestamp,
        "x-signature": signature,
      },
      body,
    });
    const data = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      return json(res, upstream.status, {
        ok: false,
        error:
          pickString(data, ["error", "message"]) ||
          "Payment could not be created.",
        request: payload,
        diagnostics: proxyDiagnostics(path),
        upstream: data,
      });
    }

    return json(res, 200, {
      ok: true,
      request: payload,
      payment: data.data || data.payment || data.result || data,
      raw: data,
    });
  } catch {
    return json(res, 500, {
      ok: false,
      error: "Payment creation failed.",
      request: payload,
    });
  }
}
