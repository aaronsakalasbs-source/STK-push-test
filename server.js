/**
 * ============================================================
 *  PAMODZI GATEWAY API - PROXY SERVER (TESTING)
 *  Base URL : http://pamodzigatewaysandbox.olympustech.info:10010
 *  Auth Key : hardcoded below (Basic Authorization)
 * ============================================================
 *
 *  HOW TO RUN:
 *    1. Place this file and package.json in the same folder
 *    2. Run:  npm install
 *    3. Run:  node server.js
 *    4. Open your browser at:  http://localhost:3000
 *
 *  Your index.html must fetch to http://localhost:3000/api/...
 *  This server will forward every request to Pamodzi and return
 *  the real response back to your frontend.
 * ============================================================
 */

const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = 3000;

// ─── HARDCODED CREDENTIALS (for testing only) ────────────────
const PAMODZI_BASE_URL =
  "http://pamodzigatewaysandbox.olympustech.info:10010";
const AUTH_KEY = "27df052b0b2a4caa889189aeef210b87";
// ─────────────────────────────────────────────────────────────

// Middleware
app.use(cors()); // Allow all origins (frontend on same machine)
app.use(express.json()); // Parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Parse form bodies
app.use(express.static(path.join(__dirname))); // Serve index.html from same folder

// ─── HELPER: Build standard Pamodzi headers ──────────────────
function pamodziHeaders() {
  return {
    Authorization: `Basic ${AUTH_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

// ─── HELPER: Interpret Pamodzi response codes ─────────────────
//
//  OT001  →  Successful
//  OT002  →  Failed
//  OT099  →  System Error
//  401    →  Unauthorized (wrong Authorization key)
//
function interpretCode(code) {
  const map = {
    OT001: "SUCCESS - Transaction / request completed successfully.",
    OT002: "FAILED  - Transaction failed. Check parameters and try again.",
    OT099: "SYSTEM ERROR - Something went wrong on the Pamodzi server side.",
    401: "UNAUTHORIZED - The Authorization key is wrong or missing.",
  };
  return map[code] || `Unknown code: ${code}`;
}

// ─── HELPER: Forward errors cleanly ──────────────────────────
function handleError(res, err) {
  console.error("[Proxy Error]", err.message);
  res.status(500).json({
    error: "Could not reach Pamodzi server.",
    detail: err.message,
    tip: "Make sure you are connected to the internet and the Pamodzi sandbox is online.",
  });
}

// =============================================================
//  ENDPOINT 1 — User Login
//  Method : POST
//  Pamodzi: /olympusgateway/V1/login/companylogin
//  Body   : { userId, password }
//  Returns: OT001 (success) | OT002 (failed) | OT099 (error)
// =============================================================
app.post("/api/login", async (req, res) => {
  const { userId, password } = req.body;

  if (!userId || !password) {
    return res
      .status(400)
      .json({ error: "userId and password are required." });
  }

  try {
    const response = await fetch(
      `${PAMODZI_BASE_URL}/olympusgateway/V1/login/companylogin`,
      {
        method: "POST",
        headers: pamodziHeaders(),
        body: JSON.stringify({ userId, password }),
      }
    );

    const data = await response.json().catch(() => ({}));
    console.log("[Login]", response.status, data);

    res.status(response.status).json({
      httpStatus: response.status,
      pamodzi: data,
      interpretation: interpretCode(data?.errorCode || response.status),
    });
  } catch (err) {
    handleError(res, err);
  }
});

// =============================================================
//  ENDPOINT 2 — Mobile Money Request Payment (STK Push)
//  Method : POST
//  Pamodzi: /PamodziPayments/V1/Mobile/MobileRequestPayment
//  Body   : { clientPhoneNumber, clientNarration, amount }
//
//  clientPhoneNumber : 15 chars  e.g. 2609xxxxxxxx
//  clientNarration   : 100 chars e.g. "Making Payments"
//  amount            : decimal   e.g. 100.00
//
//  Returns: OT001 → STK push sent to phone, wait for user to confirm
//           OT002 → Request failed (wrong number, insufficient funds, etc.)
//           OT099 → Pamodzi server error
//
//  NOTE: After this call succeeds (OT001), you get an
//  InternalTransactionId. Use that in Endpoint 3 to verify.
// =============================================================
app.post("/api/mobile/request-payment", async (req, res) => {
  const { clientPhoneNumber, clientNarration, amount } = req.body;

  if (!clientPhoneNumber || !clientNarration || !amount) {
    return res.status(400).json({
      error: "clientPhoneNumber, clientNarration, and amount are required.",
    });
  }

  try {
    const response = await fetch(
      `${PAMODZI_BASE_URL}/PamodziPayments/V1/Mobile/MobileRequestPayment`,
      {
        method: "POST",
        headers: pamodziHeaders(),
        body: JSON.stringify({ clientPhoneNumber, clientNarration, amount }),
      }
    );

    const data = await response.json().catch(() => ({}));
    console.log("[MobileRequestPayment]", response.status, data);

    res.status(response.status).json({
      httpStatus: response.status,
      pamodzi: data,
      interpretation: interpretCode(data?.errorCode || response.status),
      nextStep:
        data?.errorCode === "OT001"
          ? "STK push sent! Ask the user to enter their PIN. Then call /api/mobile/verify-payment with the InternalTransactionId returned above."
          : null,
    });
  } catch (err) {
    handleError(res, err);
  }
});

// =============================================================
//  ENDPOINT 3 — Mobile Money Verify Payment
//  Method : GET
//  Pamodzi: /PamodziPayments/V1/Mobile/MobileVerificationPayment
//  Query  : ?InternalTransactionId=TNXxxx&ClientPhoneNumber=2609xxx
//
//  InternalTransactionId : string 25 chars (from Endpoint 2 response)
//  ClientPhoneNumber     : string 15 chars
//
//  Returns: OT001 → Payment confirmed successful
//           OT002 → Payment failed or was rejected by user
//           OT099 → Pamodzi server error
// =============================================================
app.get("/api/mobile/verify-payment", async (req, res) => {
  const { InternalTransactionId, ClientPhoneNumber } = req.query;

  if (!InternalTransactionId || !ClientPhoneNumber) {
    return res.status(400).json({
      error: "InternalTransactionId and ClientPhoneNumber are required.",
    });
  }

  try {
    const url = `${PAMODZI_BASE_URL}/PamodziPayments/V1/Mobile/MobileVerificationPayment?InternalTransactionId=${InternalTransactionId}&ClientPhoneNumber=${ClientPhoneNumber}`;
    const response = await fetch(url, {
      method: "GET",
      headers: pamodziHeaders(),
    });

    const data = await response.json().catch(() => ({}));
    console.log("[MobileVerifyPayment]", response.status, data);

    res.status(response.status).json({
      httpStatus: response.status,
      pamodzi: data,
      interpretation: interpretCode(data?.errorCode || response.status),
    });
  } catch (err) {
    handleError(res, err);
  }
});

// =============================================================
//  ENDPOINT 4 — Client Transaction Verification / Search
//  Method : GET
//  Pamodzi: /olympusgateway/V1/Backend/TransactionSearch
//  Query  : ?clientPhoneNumber=&clientNarration=&amount=
//
//  Use this to search and confirm a transaction from the
//  merchant backend side.
//
//  Returns: OT001 → Transaction found and verified
//           OT002 → Not found / failed
//           OT099 → System error
// =============================================================
app.get("/api/transaction-search", async (req, res) => {
  const { clientPhoneNumber, clientNarration, amount } = req.query;

  if (!clientPhoneNumber || !clientNarration || !amount) {
    return res.status(400).json({
      error: "clientPhoneNumber, clientNarration, and amount are required.",
    });
  }

  try {
    const url = `${PAMODZI_BASE_URL}/olympusgateway/V1/Backend/TransactionSearch?clientPhoneNumber=${clientPhoneNumber}&clientNarration=${encodeURIComponent(clientNarration)}&amount=${amount}`;
    const response = await fetch(url, {
      method: "GET",
      headers: pamodziHeaders(),
    });

    const data = await response.json().catch(() => ({}));
    console.log("[TransactionSearch]", response.status, data);

    res.status(response.status).json({
      httpStatus: response.status,
      pamodzi: data,
      interpretation: interpretCode(data?.errorCode || response.status),
    });
  } catch (err) {
    handleError(res, err);
  }
});

// =============================================================
//  ENDPOINT 5 — Payment Verification One Request (All-in-one)
//  Method : POST
//  Pamodzi: /PamodziPayments/V1/Mobile/MobileRequestVerifyPayment
//  Body   : { txnID }
//
//  txnID : string 30 chars — your own transaction reference
//
//  NOTE: This single endpoint handles both request AND verify
//  internally. It takes LONGER than using Endpoints 2 + 3.
//  Do NOT use this if you need to confirm separately.
//
//  Returns: OT001 → Fully processed and verified
//           OT002 → Failed
//           OT099 → System error
// =============================================================
app.post("/api/mobile/request-verify-payment", async (req, res) => {
  const { txnID } = req.body;

  if (!txnID) {
    return res.status(400).json({ error: "txnID is required." });
  }

  try {
    const response = await fetch(
      `${PAMODZI_BASE_URL}/PamodziPayments/V1/Mobile/MobileRequestVerifyPayment`,
      {
        method: "POST",
        headers: pamodziHeaders(),
        body: JSON.stringify({ txnID }),
      }
    );

    const data = await response.json().catch(() => ({}));
    console.log("[MobileRequestVerifyPayment]", response.status, data);

    res.status(response.status).json({
      httpStatus: response.status,
      pamodzi: data,
      interpretation: interpretCode(data?.errorCode || response.status),
    });
  } catch (err) {
    handleError(res, err);
  }
});

// =============================================================
//  ENDPOINT 6 — Bank List Dropdown
//  Method : GET
//  Pamodzi: /olympusgateway/V1/DropDown/BankList
//
//  No parameters needed.
//  Returns a list of all banks on the Pamodzi system.
//
//  Returns: OT001 → List returned successfully
//           OT002 → Failed
//           OT099 → System error
// =============================================================
app.get("/api/dropdown/banks", async (req, res) => {
  try {
    const response = await fetch(
      `${PAMODZI_BASE_URL}/olympusgateway/V1/DropDown/BankList`,
      {
        method: "GET",
        headers: pamodziHeaders(),
      }
    );

    const data = await response.json().catch(() => ({}));
    console.log("[BankList]", response.status, data);

    res.status(response.status).json({
      httpStatus: response.status,
      pamodzi: data,
      interpretation: interpretCode(data?.errorCode || response.status),
    });
  } catch (err) {
    handleError(res, err);
  }
});

// =============================================================
//  ENDPOINT 7 — Country List Dropdown
//  Method : GET
//  Pamodzi: /olympusgateway/V1/DropDown/countrydropdown
//
//  No parameters needed.
//  Returns a list of all countries on the Pamodzi system.
//
//  Returns: OT001 → List returned successfully
//           OT002 → Failed
//           OT099 → System error
// =============================================================
app.get("/api/dropdown/countries", async (req, res) => {
  try {
    const response = await fetch(
      `${PAMODZI_BASE_URL}/olympusgateway/V1/DropDown/countrydropdown`,
      {
        method: "GET",
        headers: pamodziHeaders(),
      }
    );

    const data = await response.json().catch(() => ({}));
    console.log("[CountryList]", response.status, data);

    res.status(response.status).json({
      httpStatus: response.status,
      pamodzi: data,
      interpretation: interpretCode(data?.errorCode || response.status),
    });
  } catch (err) {
    handleError(res, err);
  }
});

// ─── Catch-all: serve index.html for anything else ───────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ─── Start server ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Pamodzi Tester running at http://localhost:${PORT}`);
  console.log(`   Base URL : ${PAMODZI_BASE_URL}`);
  console.log(`   Auth Key : ${AUTH_KEY}`);
  console.log(`\n   Available proxy routes:`);
  console.log(`   POST /api/login`);
  console.log(`   POST /api/mobile/request-payment`);
  console.log(`   GET  /api/mobile/verify-payment`);
  console.log(`   GET  /api/transaction-search`);
  console.log(`   POST /api/mobile/request-verify-payment`);
  console.log(`   GET  /api/dropdown/banks`);
  console.log(`   GET  /api/dropdown/countries\n`);
});
