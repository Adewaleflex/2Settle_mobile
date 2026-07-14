import crypto from "node:crypto";

const UPSTREAM_BASE_URL = "https://api.2settle.io/v1/payments/gifts";
const DEFAULT_UPSTREAM_BASE_PATH = "/v1/payments/gifts";

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

function normalizeDigits(value) {
  return String(value || "").replace(/\D/g, "");
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

function pickString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
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

function buildPayloadCandidates({ bankCode, accountNumber }) {
  return [
    {
      receiver: {
        bankCode,
        accountNumber,
      },
    },
    {
      receiver: {
        bank_code: bankCode,
        account_number: accountNumber,
      },
    },
    {
      bankCode,
      accountNumber,
    },
    {
      bank_code: bankCode,
      account_number: accountNumber,
    },
    {
      destination: {
        bankCode,
        accountNumber,
      },
    },
    {
      destination: {
        bank_code: bankCode,
        account_number: accountNumber,
      },
    },
    {
      settlement: {
        bankCode,
        accountNumber,
      },
    },
    {
      settlement: {
        bank_code: bankCode,
        account_number: accountNumber,
      },
    },
  ];
}

async function confirmClaimWithUpstream({
  apiKey,
  secretKey,
  reference,
  bankCode,
  accountNumber,
}) {
  const encodedReference = encodeURIComponent(reference);
  const path = `${DEFAULT_UPSTREAM_BASE_PATH}/${encodedReference}/claim/confirm`;
  let lastResponse = null;

  for (const payload of buildPayloadCandidates({ bankCode, accountNumber })) {
    const body = JSON.stringify(payload);
    const timestamp = buildTimestamp();
    const signature = signRequest({
      secretKey,
      method: "POST",
      path,
      timestamp,
      body,
    });

    const upstream = await fetch(
      `${UPSTREAM_BASE_URL}/${encodedReference}/claim/confirm`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-api-key": apiKey,
          "x-timestamp": timestamp,
          "x-signature": signature,
        },
        body,
      }
    );
    const data = await upstream.json().catch(() => ({}));
    lastResponse = { upstream, data, path };

    if (upstream.ok) return lastResponse;

    const message = pickString(data, ["error", "message"]) || "";
    if (!/validation/i.test(message)) return lastResponse;
  }

  return lastResponse;
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
      error: "Gift claim is not configured.",
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

  const receiver = req.body?.receiver || {};
  const bankCode = normalizeDigits(receiver.bankCode || receiver.bank_code);
  const accountNumber = normalizeDigits(
    receiver.accountNumber || receiver.account_number
  );

  if (!/^\d{6}$/.test(bankCode)) {
    return json(res, 400, {
      ok: false,
      error: "Valid 6-digit bank code is required.",
    });
  }

  if (!/^\d{10}$/.test(accountNumber)) {
    return json(res, 400, {
      ok: false,
      error: "Valid 10-digit account number is required.",
    });
  }

  try {
    const result = await confirmClaimWithUpstream({
      apiKey,
      secretKey,
      reference,
      bankCode,
      accountNumber,
    });
    const upstream = result?.upstream;
    const data = result?.data || {};
    const path = result?.path ||
      `${DEFAULT_UPSTREAM_BASE_PATH}/${encodeURIComponent(reference)}/claim/confirm`;

    if (!upstream?.ok) {
      return json(res, upstream?.status || 502, {
        ok: false,
        reference,
        error: pickString(data, ["error", "message"]) || "Gift claim could not be confirmed.",
        diagnostics: proxyDiagnostics(path),
      });
    }

    return json(res, 200, {
      ok: true,
      reference,
      status: pickString(data, ["status", "state"]) || "confirmed",
      result: data.data || data.result || data,
    });
  } catch {
    return json(res, 500, {
      ok: false,
      reference,
      error: "Gift claim failed.",
    });
  }
}
