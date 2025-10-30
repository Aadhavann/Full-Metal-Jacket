const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, 'game.db'), (err) => {
    if (err) {
        console.error('Error opening database:', err);
    } else {
        console.log('Connected to SQLite database');
        initDatabase();
    }
});

function initDatabase() {
    db.serialize(() => {
        // Users table
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Games table
        db.run(`CREATE TABLE IF NOT EXISTS games (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player1_id INTEGER NOT NULL,
            player2_id INTEGER NOT NULL,
            winner_id INTEGER NOT NULL,
            player1_score INTEGER NOT NULL,
            player2_score INTEGER NOT NULL,
            started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            ended_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (player1_id) REFERENCES users(id),
            FOREIGN KEY (player2_id) REFERENCES users(id),
            FOREIGN KEY (winner_id) REFERENCES users(id)
        )`);

        console.log('Database tables initialized');
    });
}

module.exports = db;
