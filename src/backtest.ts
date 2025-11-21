import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import * as fs from 'fs';

// --- CONFIGURATION ---
// ⚠️ You MUST use a paid RPC (Helius, QuickNode, Alchemy) or this will rate limit immediately.
const RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=427a9062-a907-4b85-947f-c5bad7cf8052";
const connection = new Connection(RPC_ENDPOINT, 'confirmed');

// Known Jito Tip Accounts (To detect Bundles)
const JITO_TIP_ACCOUNTS = [
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
    "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT"
];

interface BacktestResult {
    detected: boolean;
    reason: string;
    data: {
        creationSlot: number;
        bundleSize: number; // How many buyers in Block 0
        isJito: boolean;
        farmSize: number; // How many connected by funding
        commonFunder: string | null;
    }
}

async function runBacktest(tokenAddress: string): Promise<BacktestResult> {
    console.log(`🕵️ Starting Forensic Backtest on: ${tokenAddress}`);
    const mintPubkey = new PublicKey(tokenAddress);

    
    // 1. FIND CREATION BLOCK (Block 0)
    // We fetch the absolute earliest transaction history
    let signatures = await connection.getSignaturesForAddress(mintPubkey, { limit: 50 });
    
    console.log(`🕵️ got ${signatures.length} signatures`);
    
    // Keep fetching backwards until we hit the end (creation)
    while (true) {
        const lastSig = signatures[signatures.length - 1];
        const olderSigs = await connection.getSignaturesForAddress(mintPubkey, { 
            limit: 100, 
            before: lastSig?.signature ?? "" 
        });
        
        if (olderSigs.length === 0) break;
        signatures = olderSigs; // We only care about the VERY FIRST batch
    }
    
    // The last signature in the list is usually the Mint/Creation
    const creationTxSig = signatures[signatures.length - 1];
    const creationSlot = creationTxSig?.slot;

    if (!creationSlot) {
        console.error("❌ Unable to determine creation slot.");

        return {
            detected: false,
            reason: "Error: Creation slot not found",
            data: {
                creationSlot: 0,
                bundleSize: 0,
                isJito: false,
                farmSize: 0,
                commonFunder: null
            }
        };
    }

    console.log(`📅 Token Created in Slot: ${creationSlot}`);

    // 2. ANALYZE BLOCK 0 BUYERS
    // Filter all transactions that happened in the SAME SLOT as creation
    const block0Txs = signatures.filter(s => s.slot === creationSlot);
    const uniqueBuyers = new Set<string>();

    // We need to fetch parsed details to identify buyers and Jito tips
    // (Batching this request for performance)
    const txDetails = await connection.getParsedTransactions(
        block0Txs.map(s => s.signature), 
        { maxSupportedTransactionVersion: 0 }
    );
    console.log("🚀 ~ runBacktest ~ txDetails:", txDetails)

    let isJito = false;

    for (const tx of txDetails) {
        if (!tx) continue;
        
        // A. Check for Jito Tip (The "Smoking Gun")
        const accountKeys = tx.transaction.message.accountKeys;
        const hasJitoTip = accountKeys.some(k => JITO_TIP_ACCOUNTS.includes(k.pubkey.toBase58()));
        if (hasJitoTip) isJito = true;

        // B. Identify Buyer (Signer who is NOT the Mint Authority)
        // Simplified: usually the first signer is the payer/buyer
        const buyer = accountKeys[0]?.pubkey.toBase58();

        if (buyer) uniqueBuyers.add(buyer);
    }

    console.log(`📉 Block 0 Analysis: ${uniqueBuyers.size} Unique Buyers. Jito Detected: ${isJito}`);

    // 3. TRACE FUNDING (The "Cluster" Check)
    // If we have > 5 buyers, let's see if they are connected
    const fundingSources: string[] = [];
    const buyersArray = Array.from(uniqueBuyers).slice(0, 10); // Check first 10 to save RPC
    
    if (buyersArray.length > 3) {
        console.log("🔗 Tracing funding sources for Block 0 buyers...");
        
        for (const buyer of buyersArray) {
            const funder = await getFirstFunder(buyer, creationSlot);
            if (funder) fundingSources.push(funder);
        }
    }

    // 4. THE VERDICT
    const funderCounts: {[key: string]: number} = {};
    let maxConn = 0;
    let topFunder = null;

    fundingSources.forEach(f => {
        funderCounts[f] = (funderCounts[f] || 0) + 1;
        if (funderCounts[f] > maxConn) {
            maxConn = funderCounts[f];
            topFunder = f;
        }
    });

    const detected = (uniqueBuyers.size > 5 && isJito) || maxConn > 2;
    
    let reason = "✅ Organic / No Cluster Detected";
    if (isJito && uniqueBuyers.size > 10) reason = "🚨 FARM (High): Jito Bundle > 10 Wallets";
    if (maxConn > 3) reason = `🚨 FARM (Critical): ${maxConn} wallets funded by same source`;

    return {
        detected,
        reason,
        data: {
            creationSlot,
            bundleSize: uniqueBuyers.size,
            isJito,
            farmSize: maxConn,
            commonFunder: topFunder
        }
    };
}

// Helper: Find who sent SOL to this wallet BEFORE they bought the token
async function getFirstFunder(wallet: string, beforeSlot: number): Promise<string | null> {
    try {
        const history = await connection.getSignaturesForAddress(new PublicKey(wallet), { limit: 10 });
        
        // Find the transaction that happened BEFORE the creation slot
        // and is likely a funding transfer
        const fundingTxSig = history.find(tx => tx.slot < beforeSlot);
        
        if (fundingTxSig) {
            const tx = await connection.getParsedTransaction(fundingTxSig.signature, { maxSupportedTransactionVersion: 0 });
            if (tx && tx.transaction.message.accountKeys && tx.transaction.message.accountKeys[0]) {
                return tx.transaction.message.accountKeys[0].pubkey.toBase58();// The Sender
            }
        }
    } catch (e) {
        // error suppressed
    }
    return null;
}

// --- EXECUTE ---
// Replace with your Token Address to test
const TEST_TOKEN = "9fLGtf1rRkYd6Dy93hvYh2r8T8Wy2EPa6WHC5ibgpump"; 

runBacktest(TEST_TOKEN).then(report => {
    console.log("\n📊 --- AUTOPSY REPORT ---");
    console.log(`Result: ${report.reason}`);
    console.log(`Creation Slot: ${report.data.creationSlot}`);
    console.log(`Bundle Size: ${report.data.bundleSize} wallets`);
    console.log(`Jito Used: ${report.data.isJito ? "YES" : "NO"}`);
    console.log(`Cluster Connection: ${report.data.farmSize} linked wallets`);
    if (report.data.commonFunder) {
        console.log(`Common Funder: https://solscan.io/account/${report.data.commonFunder}`);
    }
});
