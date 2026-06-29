# 2Settle Mobile API

Small Vercel proxy for the 2Settle mobile app.

## Environment Variables

Set these in Vercel, not in the repository:

- `TWOSETTLE_API_KEY`
- `TWOSETTLE_SECRET_KEY` - used only on the server to sign upstream requests

## Endpoint

`POST /api/banks/resolve`

Request:

```json
{
  "bankCode": "000013",
  "accountNumber": "0123456789"
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
