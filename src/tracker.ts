import * as borsh from '@project-serum/borsh';
import {
    Connection,
    MessageAccountKeys,
    PublicKey
} from '@solana/web3.js';

// --- CONFIGURATION ---
const RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=427a9062-a907-4b85-947f-c5bad7cf8052"; // ⚠️ REPLACE with a fast custom RPC (Helius/Quicknode)
const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

// Connect to Solana
const connection = new Connection(RPC_ENDPOINT, 'confirmed');

// --- DECODER LAYOUT ---
// Pump.fun "Buy" Instruction Layout (Anchor Style)
// Discriminator (8 bytes) + Amount (u64) + MaxSolCost (u64)
const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]); 

const BuyLayout = borsh.struct([
    borsh.u64('discriminator'),
    borsh.u64('amount'),     // Amount of tokens buying
    borsh.u64('maxSolCost')  // Max SOL to spend
]);

// --- TYPES ---
interface FarmCluster {
    mint: string;
    size: number;
    commonFunder: string | null;
    buyers: string[];
}

// --- MAIN LOGIC ---

async function main() {
    console.log("🚀 Farm Tracker Initialized. Monitoring Pump.fun...");
    
    // 1. Listen for "Create" events via Logs (Fastest Method)
    // We filter for the Pump Program ID
    connection.onLogs(
        PUMP_PROGRAM_ID,
        async (logs, ctx) => {
            const isMint = logs.logs.some(log => log.includes("Instruction: Create"));
            
            if (isMint && !logs.err) {
                const signature = logs.signature;
                const slot = ctx.slot;
                
                console.log(`\n🆕 NEW MINT DETECTED! (Slot: ${slot})`);
                console.log(`📝 Tx: https://solscan.io/tx/${signature}`);

                // 2. Analyze the BLOCK for Bundles
                // We wait 2s to ensure the block is propagated to the RPC
                setTimeout(() => analyzeBlockForFarm(slot, signature), 2000);
            }
        },
        "processed"
    );
}

async function analyzeBlockForFarm(slot: number, mintTxSignature: string) {
    try {
        // Fetch the full block with all transactions
        const block = await connection.getBlock(slot, {
            maxSupportedTransactionVersion: 0,
            rewards: false
        });

        if (!block || !block.transactions) return;

        // We need to find the Mint Address from the creation Tx first
        // (In a real bot, you parse this from the logs directly to save time)
        const createTx = block.transactions.find(tx => 
            tx.transaction.signatures[0] === mintTxSignature
        );
        
        if(!createTx) return;

        // Logic: Look for other Pump.fun "Buy" Txs in this SAME block
        const buyers: string[] = [];
        let totalBuyVolume = 0;

        for (const tx of block.transactions) {
            if (tx.meta?.err) continue;

            // --- CORRECTIF V0 / LEGACY ---
            // Au lieu d'utiliser la fonction getAccountKeys() qui plante,
            // on reconstruit la liste manuellement en fusionnant les clés statiques et dynamiques.
            
            let allAccountKeys: PublicKey[] = [];
            
            const transaction = tx.transaction;
            const message = transaction.message;

            if ('version' in transaction && transaction.version === 0) {
                // LOGIQUE V0 (Complexe)
                // On prend les clés statiques + les adresses résolues par le RPC (dans meta)
                // @ts-ignore: TypeScript peut raler sur le type exact de message ici, mais c'est sûr au runtime
                const staticKeys = message.staticAccountKeys; 
                const loadedWritable = tx.meta?.loadedAddresses?.writable || [];
                const loadedReadonly = tx.meta?.loadedAddresses?.readonly || [];
                
                allAccountKeys = [...staticKeys, ...loadedWritable, ...loadedReadonly];
            } else {
                // LOGIQUE LEGACY (Simple)
                // @ts-ignore: message.accountKeys est parfois une classe, on la convertit en tableau
                allAccountKeys = Array.from(message.accountKeys ?? []); 
            }
            // --- FIN DU CORRECTIF ---

            // Check 1 : Est-ce que le programme Pump.fun est impliqué ?
            // ATTENTION : On utilise findIndex sur le tableau direct (plus de .get())
            const programIndex = allAccountKeys.findIndex(pk => pk.equals(PUMP_PROGRAM_ID));
            if (programIndex === -1) continue;

            // Check 2 : Qui est l'acheteur ? (Le premier signataire est l'index 0)
            const signer = allAccountKeys[0]?.toBase58();
            
            // On ne compte pas le créateur du token s'il achète ses propres tokens (souvent le cas)
            if (signer && signer !== buyers[0]) { 
                buyers.push(signer);
            }
        }

        // 3. THE VERDICT
        const uniqueBuyers = [...new Set(buyers)]; // Remove duplicates
        
        if (uniqueBuyers.length >= 10) {
            console.log(`🚨 POTENTIAL FARM DETECTED!`);
            console.log(`📉 Cluster Size: ${uniqueBuyers.length} Wallets in Block 0`);
            
            // 4. Trace Funds (The Deep Dive)
            await checkFundingSource(uniqueBuyers.slice(0, 5)); // Check first 5 to save RPC credits
        } else {
            console.log(`✅ Organic/Slow Launch. Only ${uniqueBuyers.length} buyers in Block 0.`);
        }

    } catch (e) {
        console.error("Error analyzing block:", e);
    }
}

async function checkFundingSource(wallets: string[]) {
    console.log("🕵️  Tracing funding sources...");
    const funders: string[] = [];

    for (const wallet of wallets) {
        try {
            // Get the last few transactions of this wallet
            const history = await connection.getSignaturesForAddress(
                new PublicKey(wallet), 
                { limit: 5 }
            );

            // We look for the tx BEFORE the buy (usually the funding tx)
            // Typically index 1 (index 0 is the buy itself)
            if (history && history[1]) {
                const fundingTxId = history[1].signature;
                const tx = await connection.getParsedTransaction(fundingTxId, { maxSupportedTransactionVersion: 0 });
                
                if (tx && tx.transaction.message.accountKeys) {
                    // The funder is usually the first signer (Payer) of that transfer
                    const funder = tx.transaction.message.accountKeys[0]?.pubkey.toBase58();
                    if (funder) funders.push(funder);
                }
            }
        } catch (e) {
            // Ignore RPC errors
        }
    }

    // Find the most common funder
    const frequency: Record<string, number> = {};
    let maxFreq = 0;
    let topFunder = "";

    for (const funder of funders) {
        // Ignore CEX Hot Wallets (Known Dispensers)
        // You would maintain a list of these: Binance, Coinbase, etc.
        if (funder === "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1") continue; // Example Raydium Authority

        frequency[funder] = (frequency[funder] || 0) + 1;
        if (frequency[funder] > maxFreq) {
            maxFreq = frequency[funder];
            topFunder = funder;
        }
    }

    if (maxFreq > 2) {
         console.log(`🔥 CABAL CONFIRMED: ${maxFreq} wallets funded by same address!`);
         console.log(`💀 Funder Address: https://solscan.io/account/${topFunder}`);
    } else {
         console.log("🤷 Sources look dispersed (or CEX funded).");
    }
}

// Start
main();
