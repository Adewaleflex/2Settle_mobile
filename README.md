# 2Settle Mobile API

Small Vercel proxy for the 2Settle mobile app.

## Environment Variables

Set these in Vercel, not in the repository:

- `TWOSETTLE_API_KEY`
- `TWOSETTLE_SECRET_KEY` - used only on the server to sign upstream requests

## Endpoints

`POST /api/banks/resolve`

Request:

```json
{
  "bankCode": "000013",
  "accountNumber": "0123456789"
}
```

`GET /api/gifts/:reference`

The reference can be sent as `2S-AND6DF` or `AND6DF`; the proxy normalizes it to
the full `2S-XXXXXX` format before signing the upstream request.

Response:

```json
{
  "ok": true,
  "valid": true,
  "reference": "2S-AND6DF",
  "amount": "5000",
  "currency": "NGN",
  "status": "pending"
}
```

`POST /api/gifts/:reference/claim/confirm`

Request:

```json
{
  "receiver": {
    "bankCode": "000013",
    "accountNumber": "0123456789"
  }
}
```

Response:

```json
{
  "ok": true,
  "valid": true,
  "accountName": "ACCOUNT NAME",
  "bankName": "BANK NAME",
  "bankCode": "000013",
  "accountNumber": "0123456789"
}
```
