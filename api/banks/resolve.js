const UPSTREAM_URL = "https://api.2settle.io/v1/banks/resolve";
const DEFAULT_UPSTREAM_PATH = "/v1/banks/resolve";

import crypto from "node:crypto";

function json(res, status, body) {
  res.status(status).json(body);
}

function normalizeDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function pickString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function cleanEnv(value) {
  return String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

function hmac(secretKey, payload, encoding = "hex") {
  return crypto
    .createHmac("sha256", secretKey)
    .update(payload)
    .digest(encoding);
}

function buildPayload({ bankCode, accountNumber }) {
  const bodyStyle = cleanEnv(process.env.TWOSETTLE_BODY_STYLE);

  if (bodyStyle === "snake") {
    return { bank_code: bankCode, account_number: accountNumber };
  }

  if (bodyStyle === "both") {
    return { bankCode, accountNumber, bank_code: bankCode, account_number: accountNumber };
  }

  return { bankCode, accountNumber };
}

function buildPayloadCandidates({ bankCode, accountNumber }) {
  const bodyStyle = cleanEnv(process.env.TWOSETTLE_BODY_STYLE);

  if (bodyStyle) {
    return [buildPayload({ bankCode, accountNumber })];
  }

  return [
    { bankCode, accountNumber },
    { bank_code: bankCode, account_number: accountNumber },
    { bankCode, accountNumber, bank_code: bankCode, account_number: accountNumber },
  ];
}

function buildTimestamp() {
  const timestampUnit = cleanEnv(process.env.TWOSETTLE_TIMESTAMP_UNIT) || "milliseconds";
  return timestampUnit === "seconds"
    ? Math.floor(Date.now() / 1000).toString()
    : Date.now().toString();
}

function signRequest({ secretKey, method, path, timestamp, body }) {
  const signatureMode = cleanEnv(process.env.TWOSETTLE_SIGNATURE_MODE) || "method-path-timestamp-body";
  const signatureEncoding = cleanEnv(process.env.TWOSETTLE_SIGNATURE_ENCODING) || "hex";

  const payload =
    signatureMode === "timestamp-dot-body"
      ? `${timestamp}.${body}`
      : [method, path, timestamp, body].join("\n");
  const digest = hmac(secretKey, payload, signatureEncoding);

  return cleanEnv(process.env.TWOSETTLE_SIGNATURE_PREFIX) === "sha256"
    ? `sha256=${digest}`
    : digest;
}

async function resolveWithUpstream({ apiKey, secretKey, bankCode, accountNumber }) {
  const path = cleanEnv(process.env.TWOSETTLE_SIGNATURE_PATH) || DEFAULT_UPSTREAM_PATH;
  let lastResponse = null;

  for (const payload of buildPayloadCandidates({ bankCode, accountNumber })) {
    const timestamp = buildTimestamp();
    const body = JSON.stringify(payload);
    const signature = signRequest({
      secretKey,
      method: "POST",
      path,
      timestamp,
      body,
    });

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
    lastResponse = { upstream, data };

    const message = pickString(data, ["error", "message"]) || "";
    if (!(upstream.status === 401 && /signature/i.test(message))) {
      return lastResponse;
    }
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
      error: "Bank resolver is not configured.",
      missing: {
        TWOSETTLE_API_KEY: !apiKey,
        TWOSETTLE_SECRET_KEY: !secretKey,
      },
    });
  }

  try {
    const bankCode = normalizeDigits(req.body?.bankCode || req.body?.bank_code);
    const accountNumber = normalizeDigits(
      req.body?.accountNumber || req.body?.account_number
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

    const resolved = await resolveWithUpstream({
      apiKey,
      secretKey,
      bankCode,
      accountNumber,
    });

    const upstream = resolved?.upstream;
    const data = resolved?.data || {};

    if (!upstream?.ok) {
      return json(res, upstream?.status || 502, {
        ok: false,
        error:
          pickString(data, ["error", "message"]) ||
          "Unable to resolve bank account.",
      });
    }

    return json(res, 200, {
      ok: true,
      valid: data.valid !== false,
      accountName: pickString(data, [
        "accountName",
        "account_name",
        "account_name_enquiry",
      ]),
      bankName: pickString(data, ["bankName", "bank_name"]),
      bankCode,
      accountNumber,
    });
  } catch {
    return json(res, 500, {
      ok: false,
      error: "Bank resolution failed.",
    });
  }
}
