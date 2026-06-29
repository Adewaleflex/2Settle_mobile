const UPSTREAM_URL = "https://api.2settle.io/banks/resolve";

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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  const apiKey = process.env.TWOSETTLE_API_KEY;
  const secretKey = process.env.TWOSETTLE_SECRET_KEY;

  if (!apiKey || !secretKey) {
    return json(res, 500, {
      ok: false,
      error: "Bank resolver is not configured.",
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

    const upstream = await fetch(UPSTREAM_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": apiKey,
        "x-secret-key": secretKey,
      },
      body: JSON.stringify({
        bankCode,
        accountNumber,
        bank_code: bankCode,
        account_number: accountNumber,
      }),
    });

    const data = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      return json(res, upstream.status, {
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
