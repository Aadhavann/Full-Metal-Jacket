const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const JWT_SECRET = 'your-secret-key-change-in-production';
const PORT = 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(__dirname));

// Game state
const waitingPlayers = [];
const activeGames = new Map();

// Authentication middleware
function authenticateToken(req, res, next) {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = user;
        next();
    });
}

// Routes
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);

        db.run('INSERT INTO users (username, password) VALUES (?, ?)',
            [username, hashedPassword],
            function(err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) {
                        return res.status(400).json({ error: 'Username already exists' });
                    }
                    return res.status(500).json({ error: 'Database error' });
                }

                const token = jwt.sign({ id: this.lastID, username }, JWT_SECRET);
                res.cookie('token', token, { httpOnly: true });
                res.json({ success: true, username });
            }
        );
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }

    db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        try {
            const match = await bcrypt.compare(password, user.password);
            if (!match) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
            res.cookie('token', token, { httpOnly: true });
            res.json({ success: true, username: user.username });
        } catch (error) {
            res.status(500).json({ error: 'Server error' });
        }
    });
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ success: true });
});

app.get('/api/me', authenticateToken, (req, res) => {
    res.json({ username: req.user.username, id: req.user.id });
});

app.get('/api/wstoken', authenticateToken, (req, res) => {
    // Generate a temporary token for WebSocket connection
    const wsToken = jwt.sign({ id: req.user.id, username: req.user.username }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token: wsToken });
});

app.get('/api/history', authenticateToken, (req, res) => {
    const userId = req.user.id;

    const query = `
        SELECT
            g.id,
            g.player1_score,
            g.player2_score,
            g.winner_id,
            g.ended_at,
            u1.username as player1_name,
            u2.username as player2_name
        FROM games g
        JOIN users u1 ON g.player1_id = u1.id
        JOIN users u2 ON g.player2_id = u2.id
        WHERE g.player1_id = ? OR g.player2_id = ?
        ORDER BY g.ended_at DESC
    `;

    db.all(query, [userId, userId], (err, games) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        const history = games.map(game => {
            const isPlayer1 = game.player1_id === userId;
            const won = game.winner_id === userId;

            return {
                id: game.id,
                opponent: isPlayer1 ? game.player2_name : game.player1_name,
                myScore: isPlayer1 ? game.player1_score : game.player2_score,
                opponentScore: isPlayer1 ? game.player2_score : game.player1_score,
                won,
                date: game.ended_at
            };
        });

        res.json(history);
    });
});

// WebSocket handling
wss.on('connection', (ws, req) => {
    console.log('WebSocket connection attempt from:', req.url);
    const token = new URL(req.url, 'http://localhost').searchParams.get('token');

    if (!token) {
        console.log('No token provided, closing connection');
        ws.close(1008, 'No token provided');
        return;
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            console.log('Invalid token, closing connection:', err.message);
            ws.close(1008, 'Invalid token');
            return;
        }

        ws.userId = user.id;
        ws.username = user.username;
        ws.isAlive = true;

        console.log(`User ${user.username} (ID: ${user.id}) connected via WebSocket`);

        ws.on('pong', () => {
            ws.isAlive = true;
        });

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                console.log(`Message from ${user.username}:`, data.type);
                handleWebSocketMessage(ws, data);
            } catch (error) {
                console.error('Error parsing message:', error);
            }
        });

        ws.on('close', () => {
            console.log(`User ${user.username} disconnected`);
            handlePlayerDisconnect(ws);
        });

        ws.send(JSON.stringify({ type: 'connected', username: user.username, userId: user.id }));
    });
});

function handleWebSocketMessage(ws, data) {
    switch (data.type) {
        case 'findMatch':
            findMatch(ws);
            break;
        case 'cancelMatch':
            cancelMatch(ws);
            break;
        case 'rejoinGame':
            rejoinGame(ws, data.gameId);
            break;
        case 'playerUpdate':
            broadcastPlayerUpdate(ws, data);
            break;
        case 'shoot':
            handleShoot(ws, data);
            break;
        case 'hit':
            handleHit(ws, data);
            break;
    }
}

function findMatch(ws) {
    // Check if already in queue or game
    if (waitingPlayers.includes(ws) || ws.gameId) {
        console.log(`${ws.username} already in queue or game`);
        return;
    }

    if (waitingPlayers.length > 0) {
        // Match found
        const opponent = waitingPlayers.shift();
        const gameId = `game_${Date.now()}`;

        console.log(`Match found! ${ws.username} vs ${opponent.username}`);

        const game = {
            id: gameId,
            player1: ws,
            player2: opponent,
            scores: { [ws.userId]: 0, [opponent.userId]: 0 },
            startTime: Date.now()
        };

        ws.gameId = gameId;
        opponent.gameId = gameId;
        activeGames.set(gameId, game);

        // Notify both players
        ws.send(JSON.stringify({
            type: 'matchFound',
            gameId,
            opponent: { id: opponent.userId, username: opponent.username },
            playerNumber: 1
        }));

        opponent.send(JSON.stringify({
            type: 'matchFound',
            gameId,
            opponent: { id: ws.userId, username: ws.username },
            playerNumber: 2
        }));
    } else {
        // Add to waiting queue
        console.log(`${ws.username} added to matchmaking queue`);
        waitingPlayers.push(ws);
        ws.send(JSON.stringify({ type: 'searching' }));
    }
}

function cancelMatch(ws) {
    const index = waitingPlayers.indexOf(ws);
    if (index > -1) {
        waitingPlayers.splice(index, 1);
        ws.send(JSON.stringify({ type: 'searchCancelled' }));
    }
}

function rejoinGame(ws, gameId) {
    console.log(`${ws.username} attempting to rejoin game ${gameId}`);

    const game = activeGames.get(gameId);
    if (!game) {
        console.log(`Game ${gameId} not found`);
        ws.send(JSON.stringify({ type: 'error', message: 'Game not found' }));
        return;
    }

    // Update the WebSocket reference in the game
    if (game.player1 && game.player1.userId === ws.userId) {
        console.log(`Updating player1 WebSocket for ${ws.username}`);
        game.player1 = ws;
        game.player1Disconnected = false; // Clear disconnect flag
        ws.gameId = gameId;
    } else if (game.player2 && game.player2.userId === ws.userId) {
        console.log(`Updating player2 WebSocket for ${ws.username}`);
        game.player2 = ws;
        game.player2Disconnected = false; // Clear disconnect flag
        ws.gameId = gameId;
    } else {
        console.log(`User ${ws.username} not part of game ${gameId}`);
        ws.send(JSON.stringify({ type: 'error', message: 'Not part of this game' }));
        return;
    }

    ws.send(JSON.stringify({
        type: 'gameRejoined',
        gameId: gameId,
        scores: game.scores
    }));
    console.log(`${ws.username} successfully rejoined game ${gameId}`);
}

function broadcastPlayerUpdate(ws, data) {
    // Find the game this player belongs to
    let game = null;
    let opponent = null;

    for (const [gameId, g] of activeGames) {
        if (g.player1 && g.player1.userId === ws.userId) {
            game = g;
            opponent = g.player2;
            ws.gameId = gameId;
            break;
        } else if (g.player2 && g.player2.userId === ws.userId) {
            game = g;
            opponent = g.player1;
            ws.gameId = gameId;
            break;
        }
    }

    if (!game) {
        console.log(`WARNING: No game found for user ${ws.username} (ID: ${ws.userId})`);
        console.log(`Active games: ${activeGames.size}`);
        return;
    }

    if (!opponent) {
        console.log(`WARNING: No opponent found for user ${ws.username}`);
        return;
    }

    if (opponent.readyState === WebSocket.OPEN) {
        opponent.send(JSON.stringify({
            type: 'opponentUpdate',
            position: data.position,
            rotation: data.rotation
        }));
    } else {
        console.log(`WARNING: Opponent WebSocket not open for ${ws.username}`);
    }
}

function handleShoot(ws, data) {
    if (!ws.gameId) return;

    const game = activeGames.get(ws.gameId);
    if (!game) return;

    const opponent = game.player1 === ws ? game.player2 : game.player1;

    if (opponent.readyState === WebSocket.OPEN) {
        opponent.send(JSON.stringify({
            type: 'opponentShoot',
            position: data.position,
            direction: data.direction
        }));
    }
}

function handleHit(ws, data) {
    console.log(`Hit registered by ${ws.username} (ID: ${ws.userId})`);

    // Find the game this player belongs to
    let game = null;
    let opponent = null;

    for (const [gameId, g] of activeGames) {
        if (g.player1 && g.player1.userId === ws.userId) {
            game = g;
            opponent = g.player2;
            ws.gameId = gameId;
            break;
        } else if (g.player2 && g.player2.userId === ws.userId) {
            game = g;
            opponent = g.player1;
            ws.gameId = gameId;
            break;
        }
    }

    if (!game || !opponent) {
        console.log(`WARNING: Hit registered but no game/opponent found for ${ws.username}`);
        return;
    }

    // Increment shooter's score
    game.scores[ws.userId]++;
    console.log(`Score updated: ${ws.username} now has ${game.scores[ws.userId]} points`);
    console.log(`Full scores:`, game.scores);

    // Broadcast scores
    const scoreUpdate = {
        type: 'scoreUpdate',
        scores: game.scores
    };

    ws.send(JSON.stringify(scoreUpdate));
    if (opponent.readyState === WebSocket.OPEN) {
        opponent.send(JSON.stringify(scoreUpdate));
    }

    // Check for winner (first to 5)
    if (game.scores[ws.userId] >= 5) {
        console.log(`${ws.username} wins!`);
        endGame(game, ws.userId);
    } else {
        // Notify hit
        if (opponent.readyState === WebSocket.OPEN) {
            opponent.send(JSON.stringify({ type: 'died' }));
            console.log(`Sent 'died' to ${opponent.username}`);
        }
        ws.send(JSON.stringify({ type: 'scored' }));
        console.log(`Sent 'scored' to ${ws.username}`);
    }
}

function endGame(game, winnerId) {
    const player1 = game.player1;
    const player2 = game.player2;

    // Save to database
    db.run(
        `INSERT INTO games (player1_id, player2_id, winner_id, player1_score, player2_score)
         VALUES (?, ?, ?, ?, ?)`,
        [player1.userId, player2.userId, winnerId,
         game.scores[player1.userId], game.scores[player2.userId]]
    );

    // Notify players
    const gameOverMsg = {
        type: 'gameOver',
        winnerId,
        scores: game.scores
    };

    player1.send(JSON.stringify(gameOverMsg));
    player2.send(JSON.stringify(gameOverMsg));

    // Cleanup
    delete player1.gameId;
    delete player2.gameId;
    activeGames.delete(game.id);
}

function handlePlayerDisconnect(ws) {
    // Remove from waiting queue
    const index = waitingPlayers.indexOf(ws);
    if (index > -1) {
        waitingPlayers.splice(index, 1);
        console.log(`${ws.username} removed from matchmaking queue`);
    }

    // Handle active game - give 10 second grace period for reconnection
    if (ws.gameId) {
        const game = activeGames.get(ws.gameId);
        if (game) {
            console.log(`${ws.username} disconnected from game ${ws.gameId}, starting 10s grace period`);

            // Mark which player disconnected
            if (game.player1 === ws) {
                game.player1Disconnected = true;
            } else if (game.player2 === ws) {
                game.player2Disconnected = true;
            }

            // Set timeout to end game if not reconnected
            setTimeout(() => {
                const currentGame = activeGames.get(ws.gameId);
                if (!currentGame) return; // Game already ended

                // Check if player reconnected (WebSocket reference would be updated)
                const playerReconnected = (game.player1 === ws && game.player1Disconnected) ||
                                         (game.player2 === ws && game.player2Disconnected);

                if (playerReconnected) {
                    console.log(`${ws.username} did not reconnect within grace period`);
                    const opponent = game.player1 === ws ? game.player2 : game.player1;

                    // Opponent wins by forfeit
                    if (opponent && opponent.readyState === WebSocket.OPEN) {
                        endGame(game, opponent.userId);
                        opponent.send(JSON.stringify({
                            type: 'opponentDisconnected',
                            message: 'Opponent disconnected. You win!'
                        }));
                    } else {
                        // Both disconnected, just delete game
                        console.log(`Both players disconnected from game ${ws.gameId}, deleting`);
                        activeGames.delete(ws.gameId);
                    }
                }
            }, 10000); // 10 second grace period
        }
    }
}

// Heartbeat to detect disconnected clients
const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(heartbeat);
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
