import crypto from "node:crypto";

const UPSTREAM_BASE_URL = "https://api.2settle.io/v1/payments";
const DEFAULT_UPSTREAM_BASE_PATH = "/v1/payments";

function json(res, status, body) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.status(status).json(body);
}

function cleanEnv(value) {
  return String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

function normalizeReference(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const cleaned = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/^2S-?/, "");
  if (!/^[A-Z0-9]{6}$/.test(cleaned)) return null;
  return `2S-${cleaned}`;
}

function hmac(secretKey, payload, encoding = "hex") {
  return crypto.createHmac("sha256", secretKey).update(payload).digest(encoding);
}

function buildTimestamp() {
  const timestampUnit = cleanEnv(process.env.TWOSETTLE_TIMESTAMP_UNIT) || "milliseconds";
  return timestampUnit === "seconds"
    ? Math.floor(Date.now() / 1000).toString()
    : Date.now().toString();
}

function signRequest({ secretKey, method, path, timestamp, body }) {
  const signatureMode = cleanEnv(process.env.TWOSETTLE_SIGNATURE_MODE) || "postman-bodyhash";
  const signatureEncoding = cleanEnv(process.env.TWOSETTLE_SIGNATURE_ENCODING) || "hex";

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

function pickValue(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

function pickDeepValue(source, keys) {
  const direct = pickValue(source, keys);
  if (direct) return direct;

  for (const containerKey of ["data", "gift", "result", "payment"]) {
    const nested = source?.[containerKey];
    if (nested && typeof nested === "object") {
      const nestedValue = pickValue(nested, keys);
      if (nestedValue) return nestedValue;
    }
  }

  return null;
}

function proxyDiagnostics(path) {
  return {
    upstreamUrl: UPSTREAM_BASE_URL,
    signaturePath: path,
    timestampUnit: cleanEnv(process.env.TWOSETTLE_TIMESTAMP_UNIT) || "milliseconds",
    signatureMode: cleanEnv(process.env.TWOSETTLE_SIGNATURE_MODE) || "postman-bodyhash",
    signatureEncoding: cleanEnv(process.env.TWOSETTLE_SIGNATURE_ENCODING) || "hex",
    signaturePrefix: cleanEnv(process.env.TWOSETTLE_SIGNATURE_PREFIX) || "none",
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  const apiKey = cleanEnv(process.env.TWOSETTLE_API_KEY);
  const secretKey = cleanEnv(process.env.TWOSETTLE_SECRET_KEY);

  if (!apiKey || !secretKey) {
    return json(res, 500, {
      ok: false,
      error: "Gift lookup is not configured.",
      missing: {
        TWOSETTLE_API_KEY: !apiKey,
        TWOSETTLE_SECRET_KEY: !secretKey,
      },
    });
  }

  const reference = normalizeReference(req.query?.reference);
  if (!reference) {
    return json(res, 400, {
      ok: false,
      error: "Valid gift reference is required. Use 2S-XXXXXX.",
    });
  }

  const encodedReference = encodeURIComponent(reference);
  const path = `${DEFAULT_UPSTREAM_BASE_PATH}/${encodedReference}`;
  const timestamp = buildTimestamp();
  const body = "{}";
  const signature = signRequest({
    secretKey,
    method: "GET",
    path,
    timestamp,
    body,
  });

  try {
    const upstream = await fetch(`${UPSTREAM_BASE_URL}/${encodedReference}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-api-key": apiKey,
        "x-timestamp": timestamp,
        "x-signature": signature,
      },
    });
    const data = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      return json(res, upstream.status, {
        ok: false,
        valid: false,
        reference,
        error: pickValue(data, ["error", "message"]) || "Gift ID could not be verified.",
        diagnostics: proxyDiagnostics(path),
      });
    }

    return json(res, 200, {
      ok: true,
      valid: data.valid !== false,
      reference,
      amount: pickDeepValue(data, [
        "amount",
        "amountNgn",
        "amount_ngn",
        "fiatAmount",
        "fiat_amount",
        "settlementAmount",
        "settlement_amount",
        "value",
      ]),
      currency:
        pickDeepValue(data, [
          "currency",
          "fiatCurrency",
          "fiat_currency",
          "settlementCurrency",
          "settlement_currency",
        ]) || "NGN",
      status: pickDeepValue(data, ["status", "state"]),
      gift: data.data || data.gift || data.result || data,
    });
  } catch {
    return json(res, 500, {
      ok: false,
      valid: false,
      reference,
      error: "Gift lookup failed.",
    });
  }
}
