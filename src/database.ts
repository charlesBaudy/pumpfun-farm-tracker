// database.ts
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';

let dbInstance: Database | null = null;

export async function initDB() {
    if (dbInstance) return dbInstance;

    dbInstance = await open({
        filename: './trading_signals.db',
        driver: sqlite3.Database
    });

    // Création de la table si elle n'existe pas
    await dbInstance.exec(`
        CREATE TABLE IF NOT EXISTS signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mint TEXT NOT NULL,
            strategy TEXT NOT NULL, -- 'FARM' ou 'SUPPLY_SHOCK'
            detected_at TEXT NOT NULL,
            slot INTEGER,
            buyers_count INTEGER,
            notes TEXT
        )
    `);

    console.log("💾 Base de données connectée (trading_signals.db)");
    return dbInstance;
}

export async function saveSignal(
    mint: string, 
    strategy: 'FARM' | 'SUPPLY_SHOCK', 
    slot: number, 
    buyersCount: number,
    notes: string = ""
) {
    const db = await initDB();
    const now = new Date().toISOString(); // Format: 2024-11-21T10:30:00.000Z

    await db.run(
        `INSERT INTO signals (mint, strategy, detected_at, slot, buyers_count, notes) VALUES (?, ?, ?, ?, ?, ?)`,
        [mint, strategy, now, slot, buyersCount, notes]
    );

    console.log(`📝 Signal enregistré en DB : ${strategy} -> ${mint}`);
}