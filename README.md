# Polymarket Safe Proxy - Privy Embedded Wallets Integration Demo

A Next.js application demonstrating how to integrate Polymarket's **CLOB Client** and **Builder Relayer Client** for gasless trading with builder order attribution, using **Privy** for web2-style authentication and non-custodial wallet provisioning.

This demo shows developers how to:

- Authenticate users via **Privy** email login for web2-style onboarding
- Provision an **EOA wallet** automatically via Privy's embedded wallets
- Deploy a **Gnosis Safe Proxy Wallet** using the **builder-relayer-client**
- Obtain **User API Credentials** from the CLOB client
- Set **token approvals** for CTF Contract, CTF Exchange, Neg Risk Exchange, and Neg Risk Adapter
- Place orders via CLOB client with **builder attribution** using remote signing

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Quick Start](#quick-start)
3. [Core Integration Patterns](#core-integration-patterns)
   - [Flow Overview](#flow-overview)
   - [New User Flow](#new-user-flow)
   - [Returning User Flow](#returning-user-flow)
4. [Key Implementation Details](#key-implementation-details)
   - [1. Privy Authentication](#1-privy-authentication)
   - [2. Builder Config with Remote Signing](#2-builder-config-with-remote-signing)
   - [3. RelayClient Initialization](#3-relayclient-initialization)
   - [4. Safe Deployment](#4-safe-deployment)
   - [5. User API Credentials](#5-user-api-credentials)
   - [6. Token Approvals](#6-token-approvals)
   - [7. Authenticated ClobClient](#7-authenticated-clobclient)
   - [8. Placing Orders](#8-placing-orders)
5. [Project Structure](#project-structure)
6. [Environment Variables](#environment-variables)
7. [Key Dependencies](#key-dependencies)

---

## Prerequisites

Before running this demo, you need:

1. **Builder API Credentials** from Polymarket
   - Visit `polymarket.com/settings?tab=builder` to obtain your Builder credentials
   - You'll need: `API_KEY`, `SECRET`, and `PASSPHRASE`

2. **Polygon RPC URL**
   - Any Polygon mainnet RPC (Alchemy, Infura, or public RPC)

3. **Privy App ID**
   - Sign up at [privy.io](https://privy.io/) and create an app
   - Get your **App ID** from the Privy Dashboard

---

## Quick Start

### Installation

```bash
npm install
```

### Environment Setup

Populate `.env.local`:

```bash
# Polygon RPC endpoint
NEXT_PUBLIC_POLYGON_RPC_URL=your_RPC_URL

# Privy App ID (from privy.io dashboard)
NEXT_PUBLIC_PRIVY_APP_ID=your_privy_app_id

# Builder credentials (from polymarket.com/settings?tab=builder)
POLYMARKET_BUILDER_API_KEY=your_builder_api_key
POLYMARKET_BUILDER_SECRET=your_builder_secret
POLYMARKET_BUILDER_PASSPHRASE=your_builder_passphrase
```

### Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## Core Integration Patterns

### Flow Overview

This application demonstrates two distinct user flows:

#### **New User Flow**

1. User authenticates via Privy (email)
2. Privy provisions a non-custodial EOA embedded wallet
3. Initialize **RelayClient** with builder config
4. Derive Safe address (deterministic from Privy EOA)
5. Deploy Safe using **RelayClient**
6. Obtain **User API Credentials** via temporary **ClobClient**
7. Set token approvals (USDC.e + outcome tokens) in batch transaction
8. Initialize authenticated **ClobClient** with credentials + builder config
9. Ready to trade with builder attribution

#### **Returning User Flow**

1. User authenticates via Privy (retrieves existing wallet)
2. Initialize **RelayClient** with builder config
3. Load or derive existing **User API Credentials**
4. Verify Safe is deployed (skip deployment)
5. Verify token approvals (skip if already approved)
6. Initialize authenticated **ClobClient** with credentials + builder config
7. Ready to trade with builder attribution

---

## Key Implementation Details

### 1. Privy Authentication

**Files**: `providers/WalletProvider.tsx`, `providers/WalletContext.tsx`

Users authenticate via Privy's UI, which handles email login and automatically provisions a non-custodial EOA embedded wallet. No browser extension required.

```typescript
import { PrivyProvider, usePrivy, useWallets } from "@privy-io/react-auth";
import { createWalletClient, custom } from "viem";
import { polygon } from "viem/chains";

// Wrap your app with PrivyProvider
<PrivyProvider
  appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID}
  config={{
    defaultChain: polygon,
    embeddedWallets: {
      ethereum: { createOnLogin: "users-without-wallets" },
    },
  }}
>
  {children}
</PrivyProvider>

// Usage in components:
const { login, logout } = usePrivy();
const { wallets } = useWallets();

await login();  // Opens Privy auth UI
const wallet = wallets[0];
const eoaAddress = wallet.address;
const provider = await wallet.getEthereumProvider();
const walletClient = createWalletClient({
  account: eoaAddress,
  chain: polygon,
  transport: custom(provider),
});
```

---

### 2. Builder Config with Remote Signing

**File**: `app/api/polymarket/sign/route.ts`

Builder credentials are stored server-side and accessed via a remote signing endpoint. This keeps your builder credentials secure while enabling order attribution or relay authentication.

```typescript
// Server-side API route
import {
  BuilderApiKeyCreds,
  buildHmacSignature,
} from "@polymarket/builder-signing-sdk";

const BUILDER_CREDENTIALS: BuilderApiKeyCreds = {
  key: process.env.POLYMARKET_BUILDER_API_KEY!,
  secret: process.env.POLYMARKET_BUILDER_SECRET!,
  passphrase: process.env.POLYMARKET_BUILDER_PASSPHRASE!,
};

export async function POST(request: NextRequest) {
  const { method, path, body } = await request.json();
  const sigTimestamp = Date.now().toString();

  const signature = buildHmacSignature(
    BUILDER_CREDENTIALS.secret,
    parseInt(sigTimestamp),
    method,
    path,
    body
  );

  return NextResponse.json({
    POLY_BUILDER_SIGNATURE: signature,
    POLY_BUILDER_TIMESTAMP: sigTimestamp,
    POLY_BUILDER_API_KEY: BUILDER_CREDENTIALS.key,
    POLY_BUILDER_PASSPHRASE: BUILDER_CREDENTIALS.passphrase,
  });
}
```

**Why remote signing?**

- Builder secret never exposed to client
- Secure HMAC signature generation
- Required for builder order attribution (with ClobClient) or authentication (RelayClient)

> **Security Note:** This reference implementation exposes builder credentials (API key + passphrase) to the client via the `/api/polymarket/sign` endpoint. For production deployments, implement one of:
> - **Proxy pattern** - Server makes all CLOB/Relay requests, credentials never reach client
> - **Auth token validation** - Require authenticated session before returning credentials

---

### 3. RelayClient Initialization

**File**: `hooks/useRelayClient.ts`

The **RelayClient** is initialized with the user's Privy EOA signer and builder config. It's used for Safe deployment, token approvals, and CTF operations.

```typescript
import { RelayClient } from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";

const builderConfig = new BuilderConfig({
  remoteBuilderConfig: {
    url: "/api/polymarket/sign", // Your remote signing endpoint
  },
});

// ethersSigner comes from WalletProvider context
const relayClient = new RelayClient(
  "https://relayer-v2.polymarket.com/",
  137, // Polygon chain ID
  ethersSigner,
  builderConfig
);
```

**Key Points:**

- Requires user's EOA signer (from Privy via WalletProvider)
- Requires builder's config for authentication
- Used for Safe deployment and approvals
- Persisted throughout trading session

---

### 4. Safe Deployment

**File**: `hooks/useSafeDeployment.ts`

The Safe address is deterministically derived from the user's Privy EOA, then deployed if it doesn't exist.

```typescript
import { deriveSafe } from "@polymarket/builder-relayer-client/dist/builder/derive";
import { getContractConfig } from "@polymarket/builder-relayer-client/dist/config";

// Step 1: Derive Safe address (deterministic)
const config = getContractConfig(137); // Polygon
const safeAddress = deriveSafe(eoaAddress, config.SafeContracts.SafeFactory);

// Step 2: Check if Safe is deployed
const deployed = await relayClient.getDeployed(safeAddress);

// Step 3: Deploy Safe if needed (Privy handles signature)
if (!deployed) {
  const response = await relayClient.deploy();
  const result = await response.wait();
  console.log("Safe deployed at:", result.proxyAddress);
}
```

**Important:**

- Safe address is **deterministic** - same EOA always gets same Safe address
- Safe is the "funder" address that holds USDC.e and outcome tokens
- One-time deployment per EOA on user's first login
- Privy handles the signature request

---

### 5. User API Credentials

**File**: `hooks/useUserApiCredentials.ts`

User API Credentials are obtained by creating a temporary **ClobClient** and calling `deriveApiKey()`, `createApiKey()`, or `createOrDeriveApiKey()`.

```typescript
import { ClobClient } from "@polymarket/clob-client";

// Create temporary CLOB client (no credentials yet)
const tempClient = new ClobClient(
  "https://clob.polymarket.com",
  137, // Polygon chain ID
  ethersSigner
);

// Try to derive existing credentials (for returning users)
const derivedCreds = await tempClient.deriveApiKey().catch(() => null);

if (derivedCreds?.key && derivedCreds?.secret && derivedCreds?.passphrase) {
  creds = derivedCreds; // Privy handles signature
} else {
  // If derive fails, create new credentials
  creds = await tempClient.createApiKey(); // Privy handles signature
}

// creds = { key: string, secret: string, passphrase: string }
```

**Flow:**

1. **First-time users**: `createApiKey()` creates new credentials
2. **Returning users**: `deriveApiKey()` retrieves existing credentials
3. Both methods require user signature (EIP-712)
4. Credentials are stored in localStorage for future sessions

**Important:**

Credentials alone are not enough to place new orders. However, they can be used to view orders and to cancel limit orders. Storing the user's credentials in localStorage is **not recommended for production** due to XSS vulnerability risks. This demo prioritizes simplicity over security—in production, use secure httpOnly cookies or server-side session management instead.

**Why temporary client?**

- Credentials are needed to create the authenticated client
- Temporary client is destroyed after obtaining credentials

---

### 6. Token Approvals

**Files**: `hooks/useTokenApprovals.ts`, `utils/approvals.ts`

Before trading, the Safe must approve **multiple contracts** to spend USDC.e and manage outcome tokens. This involves setting approvals for both **ERC-20 (USDC.e)** and **ERC-1155 (outcome tokens)**.

#### Required Approvals

**USDC.e (ERC-20) Approvals:**

- CTF Contract: `0x4d97dcd97ec945f40cf65f87097ace5ea0476045`
- CTF Exchange: `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`
- Neg Risk CTF Exchange: `0xC5d563A36AE78145C45a50134d48A1215220f80a`
- Neg Risk Adapter: `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296`

**Outcome Token (ERC-1155) Approvals:**

- CTF Exchange: `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`
- Neg Risk CTF Exchange: `0xC5d563A36AE78145C45a50134d48A1215220f80a`
- Neg Risk Adapter: `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296`

#### Implementation

```typescript
import { createAllApprovalTxs, checkAllApprovals } from "@/utils/approvals";

// Step 1: Check existing approvals
const approvalStatus = await checkAllApprovals(safeAddress);

if (approvalStatus.allApproved) {
  console.log("All approvals already set");
  // Skip approval step
} else {
  // Step 2: Create approval transactions
  const approvalTxs = createAllApprovalTxs();
  // Returns array of SafeTransaction objects

  // Step 3: Execute all approvals in a single batch
  const response = await relayClient.execute(
    approvalTxs,
    "Set all token approvals for trading"
  );

  await response.wait();
  console.log("All approvals set successfully");
}
```

#### Approval Transaction Structure

Each approval transaction is a `SafeTransaction`:

```typescript
// ERC-20 approval (USDC.e)
{
  to: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // USDC.e address
  operation: OperationType.Call,
  data: erc20Interface.encodeFunctionData('approve', [
    spenderAddress,
    MAX_UINT256 // Unlimited approval
  ]),
  value: '0'
}

// ERC-1155 approval (outcome tokens)
{
  to: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045', // CTF Contract address
  operation: OperationType.Call,
  data: erc1155Interface.encodeFunctionData('setApprovalForAll', [
    operatorAddress,
    true // Enable operator
  ]),
  value: '0'
}
```

#### Why Multiple Approvals?

Polymarket's trading system uses different contracts for different market types:

- **CTF Contract**: Manages outcome tokens (ERC-1155)
- **CTF Exchange**: Standard binary markets
- **Neg Risk CTF Exchange**: Negative risk markets (mutually exclusive outcomes)
- **Neg Risk Adapter**: Converts between neg risk and standard markets

Setting all approvals upfront ensures:

- Users can trade in any market type
- One-time setup (approvals persist across sessions)
- Gasless execution via RelayClient
- Single user signature for all approvals

#### Checking Approvals

Before setting approvals, the app checks onchain state:

```typescript
// Check USDC.e approval
const allowance = await publicClient.readContract({
  address: USDC_E_ADDRESS,
  abi: ERC20_ABI,
  functionName: "allowance",
  args: [safeAddress, spenderAddress],
});

const isApproved = allowance >= threshold; // 1000000000000 (1M USDC.e)

// Check outcome token approval
const isApprovedForAll = await publicClient.readContract({
  address: CTF_CONTRACT_ADDRESS,
  abi: ERC1155_ABI,
  functionName: "isApprovedForAll",
  args: [safeAddress, operatorAddress],
});
```

**Key Points:**

- Uses **batch execution** via `relayClient.execute()` for gas efficiency
- Sets **unlimited approvals** (MaxUint256) for ERC-20 tokens
- Sets **operator approvals** for ERC-1155 outcome tokens
- One-time setup per Safe (persists across sessions)
- User signs once to approve all transactions (Privy handles signature)
- Gasless for the user

---

### 7. Authenticated ClobClient

**File**: `hooks/useClobClient.ts`

After obtaining User API Credentials, create the authenticated **ClobClient** with builder config.

```typescript
import { ClobClient } from "@polymarket/clob-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";

const builderConfig = new BuilderConfig({
  remoteBuilderConfig: {
    url: "/api/polymarket/sign",
  },
});

const clobClient = new ClobClient(
  "https://clob.polymarket.com",
  137, // Polygon chain ID
  signer,
  userApiCredentials, // { key, secret, passphrase }
  2, // signatureType = 2 for EOA associated to a Gnosis Safe proxy wallet
  safeAddress, // funder address from step 4
  undefined, // mandatory placeholder
  false,
  builderConfig // Builder order attribution
);
```

**Parameters Explained:**

- **signer**: EOA signer from Privy (via WalletProvider)
- **userApiCredentials**: Obtained from Step 5
- **signatureType = 2**: Type indicating EOA associated to a Gnosis Safe proxy wallet
- **safeAddress**: The Safe proxy wallet address that holds funds
- **builderConfig**: Enables order attribution

**This is the persistent client used for all trading operations.**

---

### 8. Placing Orders

**File**: `hooks/useClobOrder.ts`

With the authenticated ClobClient, you can place orders with builder attribution.

```typescript
// Create order
const order = {
  tokenID: "0x...", // Outcome token address
  price: 0.65, // Price in decimal (65 cents)
  size: 10, // Number of shares
  side: "BUY", // or 'SELL'
  feeRateBps: 0,
  expiration: 0, // 0 = Good-til-Cancel
  taker: "0x0000000000000000000000000000000000000000",
};

// Submit order (Privy handles signature)
const response = await clobClient.createAndPostOrder(
  order,
  { negRisk: false }, // Market-specific flag
  OrderType.GTC
);

console.log("Order ID:", response.orderID);
```

**Key Points:**

- Orders are signed by the user's Privy EOA
- Executed from the Safe address (funder)
- Builder attribution is automatic via builderConfig
- Gasless execution (no gas fees for users)

**Cancel Order:**

```typescript
await clobClient.cancelOrder({ orderID: "order_id_here" });
```

---

## Project Structure

### Core Implementation Files

```
polymarket-privy-safe/
├── app/
│   ├── api/
│   │   └── polymarket/
│   │       └── sign/
│   │           └── route.ts              # Remote signing endpoint
│   └── page.tsx                          # Main application UI
│
├── hooks/
│   ├── useTradingSession.ts              # Session orchestration (main flow)
│   ├── useRelayClient.ts                 # RelayClient initialization
│   ├── useSafeDeployment.ts              # Safe deployment logic
│   ├── useUserApiCredentials.ts          # User API credential derivation
│   ├── useTokenApprovals.ts              # Token approval management
│   ├── useClobClient.ts                  # Authenticated CLOB client
│   └── useClobOrder.ts                   # Order placement/cancellation
│
├── providers/
│   ├── WalletProvider.tsx                # Privy authentication + wallet client
│   ├── WalletContext.tsx                 # Wallet context and useWallet hook
│   └── TradingProvider.tsx               # Trading session + client context
│
├── utils/
│   ├── session.ts                        # Session persistence (localStorage)
│   └── approvals.ts                      # Token approval utilities
│
└── constants/
    ├── polymarket.ts                     # API URLs and constants
    └── tokens.ts                         # Token addresses
```

### Key Hook: `useTradingSession.ts`

This is the **orchestrator** that manages the entire trading session lifecycle:

```typescript
// Coordinates:
// 1. Initialize RelayClient with builder config
// 2. Derive Safe address
// 3. Check if Safe is deployed → deploy if needed
// 4. Get User API Credentials → derive or create
// 5. Check token approvals → approve if needed (batch)
// 6. Save session to localStorage
// 7. Initialize authenticated ClobClient

const {
  tradingSession,
  currentStep,
  initializeTradingSession,
  endTradingSession,
  relayClient,
  isTradingSessionComplete,
} = useTradingSession();
```

**Read this hook first** to understand the complete flow.

---

## Environment Variables

Create `.env.local`:

```bash
# Required: Polygon RPC
NEXT_PUBLIC_POLYGON_RPC_URL=https://polygon-rpc.com

# Required: Privy App ID (from privy.io dashboard)
NEXT_PUBLIC_PRIVY_APP_ID=your_privy_app_id

# Required: Builder credentials (from polymarket.com/settings?tab=builder)
POLYMARKET_BUILDER_API_KEY=your_builder_api_key
POLYMARKET_BUILDER_SECRET=your_builder_secret
POLYMARKET_BUILDER_PASSPHRASE=your_builder_passphrase
```

---

## Key Dependencies

| Package                                                                                                  | Version  | Purpose                                          |
| -------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------ |
| [`@privy-io/react-auth`](https://docs.privy.io/)                                                         | ^2.12.2  | Authentication / Embedded Wallet                 |
| [`@polymarket/clob-client`](https://github.com/Polymarket/clob-client)                                   | ^4.22.8  | Order placement, User API credentials            |
| [`@polymarket/builder-relayer-client`](https://www.npmjs.com/package/@polymarket/builder-relayer-client) | ^0.0.6   | Safe deployment, token approvals, CTF operations |
| [`@polymarket/builder-signing-sdk`](https://www.npmjs.com/package/@polymarket/builder-signing-sdk)       | ^0.0.8   | Builder credential HMAC signatures               |
| [`viem`](https://viem.sh/)                                                                               | ^2.39.2  | Ethereum interactions, RPC calls                 |
| [`ethers`](https://docs.ethers.org/v5/)                                                                  | ^5.8.0   | Wallet signing, EIP-712 messages                 |
| [`@tanstack/react-query`](https://tanstack.com/query)                                                    | ^5.90.10 | Server state management                          |
| [`next`](https://nextjs.org/)                                                                            | ^16.0.10 | React framework, API routes                      |

---

## Architecture Diagram

```
User (email/social login)
         ↓
    [Privy Auth]
         ↓
    Privy EOA (embedded wallet)
         ↓
┌────────────────────────────────────────────────────┐
│  Trading Session Initialization                    │
├────────────────────────────────────────────────────┤
│  1. Initialize RelayClient (with builder config)   │
│  2. Derive Safe address from EOA                   │
│  3. Check if Safe deployed → deploy if needed      │
│  4. Get User API Credentials (derive or create)    │
│  5. Set token approvals (batch execution):         │
│     - USDC.e → 4 spenders (ERC-20)                 │
│     - Outcome tokens → 3 operators (ERC-1155)      │
│  6. Save session to localStorage                   │
└────────────────────────────────────────────────────┘
         ↓
┌────────────────────────────────────────────────────┐
│  Authenticated ClobClient                          │
├────────────────────────────────────────────────────┤
│  - User API Credentials                            │
│  - Builder Config (remote signing)                 │
│  - Safe address (funder)                           │
│  - Privy EOA signer                                │
└────────────────────────────────────────────────────┘
         ↓
    Place Orders
    (Standard + Neg Risk markets)
    (with builder attribution)
```

---

## Troubleshooting

### "Privy authentication failed"

- Verify `NEXT_PUBLIC_PRIVY_APP_ID` is set correctly in `.env.local`
- Check Privy dashboard for any app configuration issues
- Ensure your app domain is allowed in Privy settings

### "Failed to initialize relay client"

- Check builder credentials in `.env.local`
- Verify `/api/polymarket/sign` endpoint is accessible
- Check browser console for errors

### "Safe deployment failed"

- Check Polygon RPC URL is valid
- User must approve signature via Privy
- Verify builder credentials are configured correctly
- Check browser console for relay service errors

### "Token approval failed"

- Safe must be deployed first
- User must approve transaction signature via Privy
- Verify builder relay service is operational

### Orders not appearing

- Verify trading session is complete
- Check Safe has USDC.e balance
- Wait 2-3 seconds for CLOB sync

---

## Resources

### Polymarket Documentation

- [CLOB Client Docs](https://docs.polymarket.com/developers/CLOB/clients)
- [Builder Program](https://docs.polymarket.com/developers/builder-program)
- [Authentication](https://docs.polymarket.com/developers/CLOB/authentication)
- [Order Placement](https://docs.polymarket.com/quickstart/orders/first-order)

### Privy Documentation

- [Privy Docs](https://docs.privy.io/)
- [Embedded Wallets](https://docs.privy.io/guide/react/wallets/embedded-wallets)

### GitHub Repositories

- [clob-client](https://github.com/Polymarket/clob-client)
- [builder-relayer-client](https://www.npmjs.com/package/@polymarket/builder-relayer-client)

### Other Resources

- [viem Documentation](https://viem.sh/)
- [Safe (Gnosis Safe)](https://docs.safe.global/)
- [EIP-712 Specification](https://eips.ethereum.org/EIPS/eip-712)

---

## Support

Questions or issues? Reach out on Telegram: **[@notyrjo](https://t.me/notyrjo)**

---

## License

MIT

---

**Built for builders exploring the Polymarket ecosystem with Privy authentication**
