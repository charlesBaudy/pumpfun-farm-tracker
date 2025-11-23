import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import axios from 'axios';

// On assume qu'on entre toujours au lancement (Pump.fun start ~5k MC)
const ASSUMED_ENTRY_MC = 5000; 

interface DexScreenerResponse {
    pairs: {
        chainId: string;
        dexId: string;
        url: string;
        priceUsd: string;
        fdv: number; // Market Cap
        liquidity: {
            usd: number;
        };
        priceChange: {
            h1: number;
            h6: number;
            h24: number;
        };
    }[];
}

async function runBacktest() {
    console.log("⏳ Chargement de la DB et interrogation de DexScreener...");

    const db = await open({
        filename: './trading_signals.db',
        driver: sqlite3.Database
    });

    // On récupère tous les signaux
    const signals = await db.all('SELECT * FROM signals ORDER BY detected_at DESC');

    if (signals.length === 0) {
        console.log("❌ Aucun signal trouvé dans la DB.");
        return;
    }

    console.log(`🔍 Analyse de ${signals.length} signaux...\n`);

    let wins = 0;
    let losses = 0;
    let rugs = 0;

    // En-tête du tableau
    console.log(
        "STRAT".padEnd(10) + 
        "| " + "MINT".padEnd(15) + 
        "| " + "CURRENT MC".padEnd(12) + 
        "| " + "LIQUIDITY".padEnd(10) + 
        "| " + "ROI (Approx)"
    );
    console.log("-".repeat(70));

    for (const sig of signals) {
        try {
            // Pause pour ne pas spammer l'API DexScreener (Rate Limit)
            await new Promise(r => setTimeout(r, 300));

            const response = await axios.get<DexScreenerResponse>(
                `https://api.dexscreener.com//tokens/solana/${sig.mint}`
            );

            const pairs = response.data.pairs;
            
            // Si aucune paire trouvée, le token est probablement mort/supprimé
            if (!pairs || pairs.length === 0) {
                printRow(sig.strategy, sig.mint, "DEAD", "0", "❌ -100%");
                rugs++;
                losses++;
                continue;
            }

            // On prend la paire principale (généralement la première sur Raydium ou Pump)
            const pair = pairs[0];

            if(!pair) {
                continue;
            }

            const currentMC = pair.fdv;
            const liquidity = pair.liquidity.usd;
            const priceChange24h = pair.priceChange.h24;

            // ANALYSE DU RESULTAT
            let status = "";
            let roi = 0;

            // Calcul du ROI approximatif (Current MC / 5k Entry)
            roi = (currentMC / ASSUMED_ENTRY_MC); 
            
            // Classification
            if (liquidity < 1000) {
                status = "💀 RUG";
                rugs++;
                losses++;
            } else if (roi > 2) {
                status = `✅ x${roi.toFixed(1)}`;
                wins++;
            } else if (roi < 0.5) {
                status = `🔻 -${((1 - roi) * 100).toFixed(0)}%`;
                losses++;
            } else {
                status = `Neutre (x${roi.toFixed(1)})`;
            }

            printRow(
                sig.strategy, 
                sig.mint, 
                `$${(currentMC/1000).toFixed(1)}k`, 
                `$${(liquidity/1000).toFixed(1)}k`, 
                status
            );

        } catch (e) {
            console.log(`Erreur API pour ${sig.mint}`);
        }
    }

    console.log("-".repeat(70));
    console.log(`📊 BILAN : ${wins} Wins | ${losses} Pertes | ${rugs} Rugs complets`);
    const winRate = (wins / signals.length) * 100;
    console.log(`🏆 Win Rate théorique : ${winRate.toFixed(1)}%`);
}

function printRow(strat: string, mint: string, mc: string, liq: string, roi: string) {
    const shortMint = mint.slice(0, 4) + "..." + mint.slice(-4);
    // Couleurs simples pour la console
    let color = "\x1b[0m"; // Reset
    if (roi.includes("✅")) color = "\x1b[32m"; // Vert
    if (roi.includes("❌") || roi.includes("💀")) color = "\x1b[31m"; // Rouge
    
    console.log(
        color +
        strat.slice(0, 9).padEnd(10) + 
        "| " + shortMint.padEnd(15) + 
        "| " + mc.padEnd(12) + 
        "| " + liq.padEnd(10) + 
        "| " + roi + 
        "\x1b[0m"
    );
}

runBacktest();