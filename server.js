const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

const PAMODZI_BASE_URL = "http://pamodzigatewaysandbox.olympustech.info:10010";
const PAMODZI_AUTH_KEY = "27df052b0b2a4caa889189aeef210b87";
const AUTH_HEADER = `Basic ${PAMODZI_AUTH_KEY}`;

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Extract clean status from Pamodzi response
function parseStatus(data) {
  if (!data) return { ok: false, label: "Failed", detail: "No response from gateway." };
  const code = data.statusCode || data.StatusCode || "";
  const note = data.notification || data.Notification || data.message || data.Message || "";
  if (code === "OT001") return { ok: true,  label: "Success", detail: note || "Payment completed." };
  if (code === "OT002") return { ok: false, label: "Failed",  detail: note || "Payment was not completed." };
  if (code === "OT099") return { ok: false, label: "System Error", detail: note || "A system error occurred. Try again." };
  return { ok: false, label: "Unknown", detail: note || `Unexpected code: ${code}` };
}

// Extract transaction ID from any known field or nesting
function extractTxnId(data) {
  if (!data) return "";
  if (data.internalTransactionId) return data.internalTransactionId;
  if (data.InternalTransactionId) return data.InternalTransactionId;
  if (data.transactionId)         return data.transactionId;
  if (data.TransactionId)         return data.TransactionId;
  if (data.txnId)                 return data.txnId;
  const pr = data.paymentsResponse || data.PaymentsResponse;
  if (pr) {
    if (pr.transationId)          return pr.transationId;  // Pamodzi typo
    if (pr.transactionId)         return pr.transactionId;
    if (pr.internalTransactionId) return pr.internalTransactionId;
    if (pr.txnId)                 return pr.txnId;
  }
  return "";
}

// ============================================================
// POST /initiate — Send STK push prompt to phone
// Body: { phoneNumber, amount, narration }
// ============================================================
app.post("/initiate", async (req, res) => {
  const { phoneNumber, amount, narration } = req.body;
  if (!phoneNumber || !amount) {
    return res.status(400).json({ ok: false, label: "Error", detail: "phoneNumber and amount are required." });
  }

  try {
    const response = await axios.post(
      `${PAMODZI_BASE_URL}/PamodziPayments/V1/Mobile/MobileRequestPayment`,
      { clientPhoneNumber: phoneNumber, clientNarration: narration || "Payment", amount: parseFloat(amount) },
      { headers: { Authorization: AUTH_HEADER, "Content-Type": "application/json" }, timeout: 30000 }
    );

    const data  = response.data;
    const s     = parseStatus(data);
    const txnId = extractTxnId(data);

    return res.json({
      ok:     s.ok,
      label:  s.label,
      detail: s.detail,
      txnId,
      phone:  phoneNumber,
      amount: parseFloat(amount).toFixed(2),
      time:   new Date().toLocaleString(),
    });
  } catch (err) {
    const detail = err.response ? `Gateway error ${err.response.status}` : err.message;
    return res.status(500).json({ ok: false, label: "Error", detail });
  }
});

// ============================================================
// GET /verify — Check payment status
// Query: txnId, phoneNumber
// ============================================================
app.get("/verify", async (req, res) => {
  const { txnId, phoneNumber } = req.query;
  if (!txnId || !phoneNumber) {
    return res.status(400).json({ ok: false, label: "Error", detail: "txnId and phoneNumber are required." });
  }

  try {
    const response = await axios.get(
      `${PAMODZI_BASE_URL}/PamodziPayments/V1/Mobile/MobileVerificationPayment`,
      {
        params: { InternalTransactionId: txnId, ClientPhoneNumber: phoneNumber },
        headers: { Authorization: AUTH_HEADER },
        timeout: 45000,
      }
    );

    const data = response.data;
    const s    = parseStatus(data);

    return res.json({
      ok:     s.ok,
      label:  s.label,
      detail: s.detail,
      txnId,
      phone:  phoneNumber,
      time:   new Date().toLocaleString(),
    });
  } catch (err) {
    const detail = err.code === "ECONNABORTED"
      ? "Verification timed out. The customer may not have responded yet."
      : err.response ? `Gateway error ${err.response.status}` : err.message;
    return res.status(500).json({ ok: false, label: "Timeout", detail });
  }
});

// ============================================================
// POST /pay — Initiate + auto-verify in one call
// Body: { phoneNumber, amount, narration }
// ============================================================
app.post("/pay", async (req, res) => {
  const { phoneNumber, amount, narration } = req.body;
  if (!phoneNumber || !amount) {
    return res.status(400).json({ ok: false, label: "Error", detail: "phoneNumber and amount are required." });
  }

  try {
    const initResp = await axios.post(
      `${PAMODZI_BASE_URL}/PamodziPayments/V1/Mobile/MobileRequestPayment`,
      { clientPhoneNumber: phoneNumber, clientNarration: narration || "Payment", amount: parseFloat(amount) },
      { headers: { Authorization: AUTH_HEADER, "Content-Type": "application/json" }, timeout: 30000 }
    );

    const initData = initResp.data;
    const initS    = parseStatus(initData);
    const txnId    = extractTxnId(initData);

    if (!initS.ok || !txnId) {
      return res.json({ ok: false, label: initS.label, detail: initS.detail, txnId: "", phone: phoneNumber, amount: parseFloat(amount).toFixed(2), time: new Date().toLocaleString() });
    }

    const verifyResp = await axios.post(
      `${PAMODZI_BASE_URL}/PamodziPayments/V1/Mobile/MobileRequestVerifyPayment`,
      { txnID: txnId },
      { headers: { Authorization: AUTH_HEADER, "Content-Type": "application/json" }, timeout: 60000 }
    );

    const verifyS = parseStatus(verifyResp.data);

    return res.json({
      ok:     verifyS.ok,
      label:  verifyS.label,
      detail: verifyS.detail,
      txnId,
      phone:  phoneNumber,
      amount: parseFloat(amount).toFixed(2),
      time:   new Date().toLocaleString(),
    });
  } catch (err) {
    const detail = err.code === "ECONNABORTED"
      ? "Request timed out. The customer may not have responded in time."
      : err.response ? `Gateway error ${err.response.status}` : err.message;
    return res.status(500).json({ ok: false, label: "Timeout", detail });
  }
});

// Health check
app.get("/", (req, res) => {
  res.type("text").send("Pamodzi Payment Server is running.\nPOST /initiate  |  GET /verify  |  POST /pay");
});

app.listen(PORT, () => console.log(`Pamodzi server running on port ${PORT}`));
