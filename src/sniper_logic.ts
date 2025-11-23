import { Connection, PublicKey } from '@solana/web3.js';
import { saveSignal, initDB } from './database'; // <--- IMPORT DB

// --- CONFIGURATION ---
const RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=427a9062-a907-4b85-947f-c5bad7cf8052"; // ⚠️ Mets ton Helius ici
const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

const CONFIG = {
    FARM_THRESHOLD: 10,          
    MICRO_CABAL_THRESHOLD: 4,    
    SURVIVAL_CHECK_DELAY: 300000, // 5min pour le test
    HOLDING_REQUIREMENT: 0.90,
    MIN_TX_COUNT: 50             // NOUVEAU : Il faut au moins 50 transactions en 5 min.
};

const connection = new Connection(RPC_ENDPOINT, 'confirmed');

interface TokenAnalysis {
    mint: string;
    slot: number;
    block0Buyers: string[];
    isFarm: boolean;
}

async function main() {
    await initDB(); // <--- INITIALISATION DB
    console.log("🚀 BOT DÉMARRÉ : Logging Database Actif");

    connection.onLogs(
        PUMP_PROGRAM_ID,
        async (logs, ctx) => {
            const isMint = logs.logs.some(l => l.includes("Instruction: Create"));
            
            if (isMint && !logs.err) {
                const signature = logs.signature;
                const slot = ctx.slot;
                console.log(`\n🆕 MINT (Slot ${slot}) - Tx: ${signature}`);
                
                // Délai pour propagation du bloc
                setTimeout(() => processNewToken(signature, slot), 3000);
            }
        },
        "processed"
    );
}

async function processNewToken(mintTxSig: string, slot: number) {
    try {
        const block = await connection.getBlock(slot, {
            maxSupportedTransactionVersion: 0,
            rewards: false
        });

        if (!block || !block.transactions) return;

        // Récupération Mint Address (Logique simplifiée)
        const createTx = block.transactions.find(tx => tx.transaction.signatures[0] === mintTxSig);
        if (!createTx) return;
        const preBalances = createTx.meta?.postTokenBalances;
        if (!preBalances || preBalances.length === 0) return;
        const mintAddress = preBalances[0]?.mint;

        if(!mintAddress) {
            console.error("🚀 ~ processNewToken ~ mintAddress:", mintAddress)
            return;
        }

        // Scan acheteurs
        const buyers: string[] = [];
        for (const tx of block.transactions) {
            if (tx.meta?.err) continue;
            // --- FIX V0 TRANSACTIONS (Indispensable) ---
            let allAccountKeys: PublicKey[] = [];
            const transaction = tx.transaction;
            
            if ('version' in transaction && transaction.version === 0) {
                const staticKeys = transaction.message.staticAccountKeys;
                const loadedWritable = tx.meta?.loadedAddresses?.writable || [];
                const loadedReadonly = tx.meta?.loadedAddresses?.readonly || [];
                allAccountKeys = [...staticKeys, ...loadedWritable, ...loadedReadonly];
            } else {
                // @ts-ignore
                allAccountKeys = Array.from(transaction.message.accountKeys ?? []);
            }
                        
            const isPump = allAccountKeys.some(k => k.toString() === PUMP_PROGRAM_ID.toString());
            if (!isPump) continue;

            const tokenChanges = tx.meta?.postTokenBalances?.filter(b => b.mint === mintAddress);
            if (tokenChanges && tokenChanges.length > 0) {
                const buyer = allAccountKeys[0]?.toString();
                if (buyer && !buyers.includes(buyer)) buyers.push(buyer);
            }
        }

        const buyerCount = buyers.length;
        console.log(`📊 Analyse ${mintAddress} : ${buyerCount} acheteurs.`);

        if (buyerCount >= CONFIG.FARM_THRESHOLD) {
            console.log("🚨 ALERTE FERME DÉTECTÉE !");
            
            // --- ENREGISTREMENT DB : FERME ---
            await saveSignal(mintAddress, 'FARM', slot, buyerCount, "Jito Bundle détecté");

        } else {
            // On lance le tracker Supply Shock
            setTimeout(() => 
                checkSupplyShock({ 
                    mint: mintAddress, 
                    slot, 
                    block0Buyers: buyers, 
                    isFarm: false 
                }), 
                CONFIG.SURVIVAL_CHECK_DELAY
            );
        }

    } catch (e) {
        console.error("Erreur processNewToken:", e);
    }
}

// --- PHASE 2 : SUPPLY SHOCK DETECTOR (Le Chart SPACECAT) ---
async function checkSupplyShock(data: TokenAnalysis) {
    console.log(`\n🕵️ VERIFICATION SUPPLY SHOCK : ${data.mint}`);

    // 1. CHECK VOLUME : Est-ce que le token est vivant ?
    try {
        const signatures = await connection.getSignaturesForAddress(
            new PublicKey(data.mint), 
            { limit: CONFIG.MIN_TX_COUNT }
        );
        
        if (signatures.length < CONFIG.MIN_TX_COUNT) {
            console.log(`❌ MORT CLINIQUE : Seulement ${signatures.length} txs en 5 min.`);
            return; // On arrête là, pas la peine d'analyser plus.
        }
    } catch (e) {
        console.log("Erreur RPC volume check");
        return;
    }

    // Nous allons vérifier si les acheteurs du Block 0 ont vendu.
    // Si le Dev + ses 3 potes holdent toujours, l'offre est bloquée -> BULLISH.

    let totalInitialTokens = 0;
    let currentTokens = 0;
    let paperHandsCount = 0;

    // On vérifie chaque acheteur du début
    for (const buyer of data.block0Buyers) {
        try {
            // Récupérer le solde actuel
            const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
                new PublicKey(buyer),
                { mint: new PublicKey(data.mint) }
            );

            let balance = 0;
            if (tokenAccounts.value.length > 0) {
                balance = tokenAccounts.value[0]?.account.data.parsed.info.tokenAmount.uiAmount;
            }

            // Note : Pour faire un calcul précis du % de rétention, il faudrait avoir stocké
            // le montant exact acheté au Block 0.
            // Ici, on utilise une heuristique : Si balance < 1000 (poussière), il a vendu.
            // Si balance > 10000, il hold.
            
            if (balance < 1000) { 
                paperHandsCount++;
                console.log(`🔴 Buyer ${buyer.slice(0,6)} a vendu (Jeet).`);
            } else {
                console.log(`🟢 Buyer ${buyer.slice(0,6)} tient bon (Diamond Hand).`);
            }

        } catch (e) {
            console.log(`Erreur lecture balance pour ${buyer}`);
        }
        
        // Petite pause pour le RPC
        await new Promise(r => setTimeout(r, 200));
    }

    // LE SIGNAL D'ACHAT FINAL
    // Calcul du score
    const retentionScore = (data.block0Buyers.length - paperHandsCount) / data.block0Buyers.length;
    console.log(`💎 Retention Score : ${(retentionScore * 100).toFixed(0)}%`);

    // 3. VERDICT FINAL PLUS STRICT
    if (retentionScore >= CONFIG.HOLDING_REQUIREMENT) {
        console.log("🚀 --- SIGNAL SUPPLY SHOCK VALIDÉ ---");
        console.log("✅ 1. Les Insiders n'ont RIEN vendu.");
        console.log("✅ 2. Le token a survécu 5 minutes.");
        console.log("✅ 3. Il y a du volume (Community driven).");
        
        await saveSignal(
            data.mint, 
            'SUPPLY_SHOCK_ELITE', // Nouveau nom de stratégie
            data.slot, 
            data.block0Buyers.length, 
            `Retention: ${(retentionScore*100).toFixed(0)}% | Alive 5m`
        );
    } else {
        console.log("❌ Échec : Les insiders ont vendu ou le score est insuffisant.");
    }
}

main();