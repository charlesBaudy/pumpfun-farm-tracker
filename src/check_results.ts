import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

async function viewSignals() {
    const db = await open({
        filename: './trading_signals.db',
        driver: sqlite3.Database
    });

    // Récupérer tous les signaux
    const signals = await db.all('SELECT * FROM signals ORDER BY detected_at DESC');

    console.log("\n📊 --- RAPPORT DE BACKTESTING --- 📊");
    console.log(`Nombre total de signaux : ${signals.length}\n`);

    signals.forEach((sig) => {
        console.log(`🕒 ${new Date(sig.detected_at).toLocaleTimeString()} | Type: ${sig.strategy}`);
        console.log(`🔑 Mint: ${sig.mint}`);
        console.log(`📉 Buyers Block 0: ${sig.buyers_count}`);
        console.log(`🔗 Lien GMGN: https://gmgn.ai/sol/token/${sig.mint}`);
        console.log(`📝 Notes: ${sig.notes}`);
        console.log("---------------------------------------------------");
    });
}

viewSignals();