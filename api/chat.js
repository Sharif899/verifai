// api/chat.js
// ===========
// Vercel Serverless Function
// Handles the x402 payment flow with OpenGradient LLM:
//   1. Makes initial request → gets 402 + payment requirements
//   2. Signs payment with EIP-712 using wallet private key
//   3. Resubmits with X-PAYMENT header
//   4. Returns AI response + transaction hash to frontend
//
// Environment variables needed in Vercel dashboard:
//   OG_PRIVATE_KEY  — your wallet private key (0x...)
//   OG_WALLET_ADDR  — your wallet address (0x...)

const { ethers } = require("ethers");

// ── Config ─────────────────────────────────────────────────────
const LLM_URL      = "https://chat.opengradient.ai";  // Updated URL
const OPG_TOKEN    = "0x240b09731D96979f50B2C649C9CE10FcF9C7987F";
const FACILITATOR  = "0x339c7de83d1a62edafbaac186382ee76584d294f";
const BASE_SEPOLIA = 84532;

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  const { messages, model = "anthropic/claude-sonnet-4-5" } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array is required" });
  }

  const PRIVATE_KEY  = process.env.OG_PRIVATE_KEY;
  const WALLET_ADDR  = process.env.OG_WALLET_ADDR;

  if (!PRIVATE_KEY || !WALLET_ADDR) {
    return res.status(500).json({
      error: "Wallet not configured. Add OG_PRIVATE_KEY and OG_WALLET_ADDR to Vercel environment variables."
    });
  }

  try {
    const wallet   = new ethers.Wallet(PRIVATE_KEY);
    const endpoint = `${LLM_URL}/v1/chat/completions`;

    const requestBody = {
      model,
      messages,
      max_tokens: 500,
      temperature: 0.7,
    };

    // ── Step 1: Initial request → get 402 ──────────────────────
    console.log(`Making request to: ${endpoint}`);
    
    const probe = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    console.log(`Probe response status: ${probe.status}`);

    let paymentRequired = null;

    if (probe.status === 402) {
      // Decode payment requirements from header
      const payHeader = probe.headers.get("X-PAYMENT-REQUIRED");
      if (payHeader) {
        try {
          paymentRequired = JSON.parse(
            Buffer.from(payHeader, "base64").toString("utf8")
          );
        } catch(e) {
          try { paymentRequired = JSON.parse(payHeader); } catch(e2) {}
        }
      }
      console.log("Payment required:", paymentRequired);
    } else if (probe.status === 200) {
      // No payment needed (free tier / already approved)
      const data = await probe.json();
      const payResponse = probe.headers.get("X-PAYMENT-RESPONSE");
      let txHash = null;
      if (payResponse) {
        try {
          const receipt = JSON.parse(Buffer.from(payResponse, "base64").toString("utf8"));
          txHash = receipt.txHash || null;
        } catch(e) {}
      }
      return res.status(200).json({
        content:  data.choices?.[0]?.message?.content || "",
        model:    data.model || model,
        txHash,
        tokens:   data.usage,
        verified: true,
      });
    } else {
      // Handle other error statuses
      const errorText = await probe.text();
      console.log(`Unexpected status ${probe.status}:`, errorText);
      throw new Error(`API returned ${probe.status}: ${errorText}`);
    }

    // ── Step 2: Build + sign EIP-712 payment ───────────────────
    const amount     = paymentRequired?.maxAmountRequired || "1000000";
    const validBefore= Math.floor(Date.now() / 1000) + 300; // 5 min
    const nonce      = ethers.hexlify(ethers.randomBytes(32));

    const domain = {
      name:              paymentRequired?.extra?.name || "OPG",
      version:           paymentRequired?.extra?.version || "1",
      chainId:           BASE_SEPOLIA,
      verifyingContract: OPG_TOKEN,
    };

    const types = {
      TransferWithAuthorization: [
        { name: "from",        type: "address" },
        { name: "to",          type: "address" },
        { name: "value",       type: "uint256" },
        { name: "validAfter",  type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce",       type: "bytes32" },
      ],
    };

    const authorization = {
      from:        WALLET_ADDR,
      to:          FACILITATOR,
      value:       amount,
      validAfter:  0,
      validBefore: validBefore,
      nonce,
    };

    const signature = await wallet.signTypedData(domain, types, authorization);

    const paymentPayload = Buffer.from(JSON.stringify({
      payload: { signature, authorization }
    })).toString("base64");

    // ── Step 3: Resubmit with payment ──────────────────────────
    const paid = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type":     "application/json",
        "X-PAYMENT":        paymentPayload,
        "X-SETTLEMENT-TYPE":"individual",
      },
      body: JSON.stringify(requestBody),
    });

    if (!paid.ok) {
      const errData = await paid.json().catch(() => ({}));
      throw new Error(errData?.error?.message || `LLM request failed: ${paid.status}`);
    }

    const data = await paid.json();

    // Extract tx hash from payment response header
    let txHash = null;
    const payResponseHeader = paid.headers.get("X-PAYMENT-RESPONSE");
    if (payResponseHeader) {
      try {
        const receipt = JSON.parse(Buffer.from(payResponseHeader, "base64").toString("utf8"));
        txHash = receipt.txHash || null;
      } catch(e) {}
    }

    return res.status(200).json({
      content:  data.choices?.[0]?.message?.content || "",
      model:    data.model || model,
      txHash,
      tokens:   data.usage,
      verified: true,
      paymentNetwork: "Base Sepolia",
      proofNetwork:   "OpenGradient Testnet",
    });

  } catch (err) {
    console.error("OG chat error:", err);
    return res.status(500).json({
      error: err.message || "Failed to get AI response",
      verified: false,
    });
  }
};
