const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// === HARDCODED TEST CREDENTIALS ===
const PAMODZI_BASE_URL = "http://pamodzigatewaysandbox.olympustech.info:10010";
const PAMODZI_AUTH_KEY = "27df052b0b2a4caa889189aeef210b87";
const AUTH_HEADER = `Basic ${PAMODZI_AUTH_KEY}`;

// === MIDDLEWARE ===
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// === HELPER: parse Pamodzi response into a readable message ===
function parseResponse(data) {
  if (!data) return "No response from payment gateway.";
  const code = data.statusCode || data.StatusCode || data.errorCode || data.ErrorCode || "";
  const msg = data.statusMessage || data.StatusMessage || data.message || data.Message || JSON.stringify(data);
  if (code === "OT001") return `SUCCESS: ${JSON.stringify(data)}`;
  if (code === "OT002") return `FAILED: ${JSON.stringify(data)}`;
  if (code === "OT099") return `SYSTEM ERROR: ${JSON.stringify(data)}`;
  return `RESPONSE (${code}): ${JSON.stringify(data)}`;
}

// === HELPER: extract transaction ID from any known field/nesting ===
function extractTxnId(data) {
  if (!data) return "";
  // Direct top-level fields
  if (data.internalTransactionId) return data.internalTransactionId;
  if (data.InternalTransactionId) return data.InternalTransactionId;
  if (data.transactionId)         return data.transactionId;
  if (data.TransactionId)         return data.TransactionId;
  if (data.txnId)                 return data.txnId;
  if (data.TxnId)                 return data.TxnId;
  // Nested inside paymentsResponse (Pamodzi typo: "transationId")
  const pr = data.paymentsResponse || data.PaymentsResponse;
  if (pr) {
    if (pr.transationId)         return pr.transationId;   // their typo
    if (pr.transactionId)        return pr.transactionId;
    if (pr.internalTransactionId) return pr.internalTransactionId;
    if (pr.TxnId)                return pr.TxnId;
    if (pr.txnId)                return pr.txnId;
  }
  return "";
}

// ============================================================
// ENDPOINT 1 — Initiate STK Push Payment
// POST /initiate
// Body: { phoneNumber, amount, narration }
// ============================================================
app.post("/initiate", async (req, res) => {
  const { phoneNumber, amount, narration } = req.body;

  if (!phoneNumber || !amount) {
    return res.status(400).send("ERROR: phoneNumber and amount are required.");
  }

  try {
    const response = await axios.post(
      `${PAMODZI_BASE_URL}/PamodziPayments/V1/Mobile/MobileRequestPayment`,
      {
        clientPhoneNumber: phoneNumber,
        clientNarration: narration || "Payment",
        amount: parseFloat(amount),
      },
      {
        headers: {
          Authorization: AUTH_HEADER,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    const data = response.data;
    const message = parseResponse(data);
    const txnId = extractTxnId(data);

    let receipt = `--- PAMODZI PAYMENT RECEIPT ---\n`;
    receipt += `Status   : ${message}\n`;
    receipt += `Phone    : ${phoneNumber}\n`;
    receipt += `Amount   : ZMW ${parseFloat(amount).toFixed(2)}\n`;
    if (txnId) receipt += `Txn ID   : ${txnId}\n`;
    receipt += `Time     : ${new Date().toLocaleString()}\n`;
    receipt += `-------------------------------`;

    return res.type("text").send(receipt);
  } catch (err) {
    const errMsg =
      err.response
        ? `ERROR ${err.response.status}: ${JSON.stringify(err.response.data)}`
        : `ERROR: ${err.message}`;
    return res.status(500).type("text").send(errMsg);
  }
});

// ============================================================
// ENDPOINT 2 — Verify Payment
// GET /verify?txnId=TNXxxx&phoneNumber=2609xxxxxxxx
// ============================================================
app.get("/verify", async (req, res) => {
  const { txnId, phoneNumber } = req.query;

  if (!txnId || !phoneNumber) {
    return res.status(400).send("ERROR: txnId and phoneNumber query params are required.");
  }

  try {
    const response = await axios.get(
      `${PAMODZI_BASE_URL}/PamodziPayments/V1/Mobile/MobileVerificationPayment`,
      {
        params: {
          InternalTransactionId: txnId,
          ClientPhoneNumber: phoneNumber,
        },
        headers: {
          Authorization: AUTH_HEADER,
        },
        timeout: 30000,
      }
    );

    const data = response.data;
    const message = parseResponse(data);

    let receipt = `--- PAMODZI VERIFICATION RECEIPT ---\n`;
    receipt += `Status   : ${message}\n`;
    receipt += `Txn ID   : ${txnId}\n`;
    receipt += `Phone    : ${phoneNumber}\n`;
    receipt += `Time     : ${new Date().toLocaleString()}\n`;
    receipt += `------------------------------------`;

    return res.type("text").send(receipt);
  } catch (err) {
    const errMsg =
      err.response
        ? `ERROR ${err.response.status}: ${JSON.stringify(err.response.data)}`
        : `ERROR: ${err.message}`;
    return res.status(500).type("text").send(errMsg);
  }
});

// ============================================================
// ENDPOINT 3 — Initiate AND Verify in one request
// POST /pay
// Body: { phoneNumber, amount, narration }
// Initiates payment then auto-verifies result
// ============================================================
app.post("/pay", async (req, res) => {
  const { phoneNumber, amount, narration } = req.body;

  if (!phoneNumber || !amount) {
    return res.status(400).send("ERROR: phoneNumber and amount are required.");
  }

  try {
    // Step 1: Initiate
    const initResponse = await axios.post(
      `${PAMODZI_BASE_URL}/PamodziPayments/V1/Mobile/MobileRequestPayment`,
      {
        clientPhoneNumber: phoneNumber,
        clientNarration: narration || "Payment",
        amount: parseFloat(amount),
      },
      {
        headers: {
          Authorization: AUTH_HEADER,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    const initData = initResponse.data;
    const txnId = extractTxnId(initData);

    if (!txnId) {
      const failMsg = parseResponse(initData);
      let receipt = `--- PAMODZI PAYMENT RECEIPT ---\n`;
      receipt += `Initiate : ${failMsg}\n`;
      receipt += `Verify   : Skipped (no transaction ID returned)\n`;
      receipt += `Phone    : ${phoneNumber}\n`;
      receipt += `Amount   : ZMW ${parseFloat(amount).toFixed(2)}\n`;
      receipt += `Time     : ${new Date().toLocaleString()}\n`;
      receipt += `-------------------------------`;
      return res.type("text").send(receipt);
    }

    // Step 2: Verify using the one-request endpoint
    const verifyResponse = await axios.post(
      `${PAMODZI_BASE_URL}/PamodziPayments/V1/Mobile/MobileRequestVerifyPayment`,
      { txnID: txnId },
      {
        headers: {
          Authorization: AUTH_HEADER,
          "Content-Type": "application/json",
        },
        timeout: 60000,
      }
    );

    const verifyData = verifyResponse.data;
    const initMsg = parseResponse(initData);
    const verifyMsg = parseResponse(verifyData);

    let receipt = `--- PAMODZI COMBINED PAYMENT RECEIPT ---\n`;
    receipt += `Initiate : ${initMsg}\n`;
    receipt += `Verify   : ${verifyMsg}\n`;
    receipt += `Txn ID   : ${txnId}\n`;
    receipt += `Phone    : ${phoneNumber}\n`;
    receipt += `Amount   : ZMW ${parseFloat(amount).toFixed(2)}\n`;
    receipt += `Time     : ${new Date().toLocaleString()}\n`;
    receipt += `---------------------------------------`;

    return res.type("text").send(receipt);
  } catch (err) {
    const errMsg =
      err.response
        ? `ERROR ${err.response.status}: ${JSON.stringify(err.response.data)}`
        : `ERROR: ${err.message}`;
    return res.status(500).type("text").send(errMsg);
  }
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/", (req, res) => {
  res.type("text").send(
    "Pamodzi Payment Server is running.\n\nEndpoints:\n" +
    "  POST /initiate       — Initiate STK push (body: phoneNumber, amount, narration)\n" +
    "  GET  /verify         — Verify payment (query: txnId, phoneNumber)\n" +
    "  POST /pay            — Initiate + Verify in one call (body: phoneNumber, amount, narration)"
  );
});

app.listen(PORT, () => {
  console.log(`Pamodzi Payment Server running on port ${PORT}`);
});
