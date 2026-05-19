const { WebSocketServer } = require('ws');
const { Server } = require('http');
const { readFileSync } = require('fs');
const path = require('path')
const aiplayer = require('./aiplayer');

const allowFiles = [['index.html', 'text/html'], ['client.js', 'text/javascript'], ['style.css', 'text/css']]
const files = {}

for (const [file, type] of allowFiles) {
    const fullPath = path.join(__dirname, file);
    files[file] = { content: readFileSync(fullPath), type }
}

const httpServer = new Server((req, res) => {
    const url = req.url.toLowerCase();
    const filename = url.slice(1)

    if (url === '/') {
        const { content, type } = files[allowFiles[0][0]]
        res.setHeader('Content-Type', type)
        return res.end(content)
    }

    if (!!filename && filename in files) {
        const { content, type } = files[filename]
        res.setHeader('Content-Type', type)
        return res.end(content)
    }
})

httpServer.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url, `http://${request.headers.host}`);

    if (pathname === '/ws') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

// const wss = new WebSocketServer({ port: 59980 });
const wss = new WebSocketServer({ noServer: true });

const clients = new Map();
const lobbies = new Map();
const startedLobbies = new Set();
const aiTimeouts = new Map();
const disconnectTimers = new Map(); // playerId -> timeout for reconnect grace period
const reconnectTimers = new Map(); // playerId -> timeout for 15s turn skip
const sessions = new Map(); // playerId -> { name, lobbyId } for reconnection
const deferTimers = new Map(); // playerId/lobbyId -> timeout for deferred close processing

let stateLog = [];
function logState(event, metadata, details = {}) {
    if (!isDev()) return;
    stateLog.push({
        t: Date.now(),
        event,
        playerId: metadata?.id?.slice(0,8),
        lobbyId: metadata?.lobbyId?.slice(0,8),
        name: metadata?.name,
        ...details
    });
    if (stateLog.length > 10000) stateLog.splice(0, 1000);
}

function validateState(playerId, name, lobbyId) {
    // Check if the player's current state is consistent
    if (!lobbyId) return 'disconnected';
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return 'disconnected';
    const player = lobby.players.find(p => p.id === playerId);
    if (!player) return 'disconnected';
    if (player.disconnected) return 'reconnecting';
    if (lobby.game.started) return 'in_game';
    return 'in_lobby';
}

function createLobby(lobbyId) {
    return {
        id: lobbyId,
        players: [],
        game: {
            deck: [],
            discardPile: [],
            turn: 0,
            direction: 1,
            started: false
        }
    };
}

function findOrCreateLobby(lobbyId) {
    if (!lobbies.has(lobbyId)) {
        lobbies.set(lobbyId, createLobby(lobbyId));
    }
    return lobbies.get(lobbyId);
}

// function generateLobbyId() {
//     return Math.random().toString(36).substring(2, 8).toUpperCase();
// }

function broadcastToLobby(lobbyId, message, excludeClientId = null) {
    [...clients.keys()].forEach((client) => {
        const metadata = clients.get(client);
        if (metadata.lobbyId === lobbyId && metadata.id !== excludeClientId) {
            client.send(JSON.stringify(message));
        }
    });
}

function broadcastPlayers(lobbyId) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;

    const message = {
        action: 'players',
        players: lobby.players,
        turn: lobby.game.turn,
        lobbyId: lobbyId
    };
    broadcastToLobby(lobbyId, message);
}

function checkStartGame(lobbyId) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;
    const activePlayers = lobby.players.filter(p => !p.disconnected);
    console.log(`[server] checkStartGame lobby=${lobbyId?.slice(0,8)} total=${lobby.players.length} active=${activePlayers.length} activeReady=${activePlayers.filter(p=>p.ready).length}`);
    if (lobby.players.length >= 2 && activePlayers.length >= 2 && activePlayers.every(p => p.ready)) {
        startGame(lobbyId);
    }
}

function createDeck(lobbyId) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;

    const colors = ['red', 'yellow', 'green', 'blue'];
    const types = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2'];
    const wildTypes = ['wild', 'wild4'];

    for (const color of colors) {
        for (const type of types) {
            lobby.game.deck.push({ color, type });
            if (type !== '0') {
                lobby.game.deck.push({ color, type });
            }
        }
    }

    for (let i = 0; i < 4; i++) {
        for (const type of wildTypes) {
            lobby.game.deck.push({ type });
        }
    }
}

function shuffleDeck(lobbyId) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;

    for (let i = lobby.game.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [lobby.game.deck[i], lobby.game.deck[j]] = [lobby.game.deck[j], lobby.game.deck[i]];
    }
}

function drawCardsFromDeck(lobby, lobbyId, count) {
    const drawn = [];
    while (drawn.length < count) {
        let card = lobby.game.deck.pop();
        if (!card) {
            if (lobby.game.discardPile.length >= 2) {
                const topCard = lobby.game.discardPile.pop();
                lobby.game.deck = lobby.game.discardPile;
                lobby.game.discardPile = [topCard];
                shuffleDeck(lobbyId);
                card = lobby.game.deck.pop();
            } else {
                break;
            }
        }
        drawn.push(card);
    }
    return drawn;
}

function dealCards(lobbyId) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;

    for (const player of lobby.players) {
        player.hand = lobby.game.deck.splice(0, 7);
        player.uno = false;
    }
}

function startGame(lobbyId) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;
    const activePlayers = lobby.players.filter(p => !p.disconnected);
    if (activePlayers.length < 2) return;

    lobby.game.started = true;
    startedLobbies.add(lobbyId);
    createDeck(lobbyId);
    shuffleDeck(lobbyId);
    dealCards(lobbyId);

    // Ensure the first card is not a wild card
    let firstCardIndex = lobby.game.deck.findIndex(card => card.type !== 'wild' && card.type !== 'wild4');
    if (firstCardIndex === -1) {
        // This is extremely unlikely, but handle it just in case
        shuffleDeck(lobbyId);
        firstCardIndex = lobby.game.deck.findIndex(card => card.type !== 'wild' && card.type !== 'wild4');
    }
    lobby.game.discardPile.push(lobby.game.deck.splice(firstCardIndex, 1)[0]);

    [...clients.keys()].forEach((client) => {
        const metadata = clients.get(client);
        if (metadata.lobbyId === lobbyId) {
            const player = lobby.players.find(p => p.id === metadata.id);
            if (!player) return;
            const message = {
                action: 'start',
                players: sanitizePlayersForClient(lobby.players),
                discardPile: lobby.game.discardPile,
                turn: lobby.game.turn,
                hand: player.hand,
                id: metadata.id
            };
            client.send(JSON.stringify(message));
        }
    });

    scheduleAIMove(lobbyId);
}

function broadcastWin(lobbyId, winnerName) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;

    broadcastToLobby(lobbyId, { action: 'win', winner: winnerName });

    for (const [, meta] of clients) {
        if (meta.lobbyId === lobbyId) meta.lobbyId = null;
    }
    lobby.players.length = 0;
    lobby.game = { deck: [], discardPile: [], turn: 0, direction: 1, started: false };
    startedLobbies.delete(lobbyId);
}

function broadcastGameAborted(lobbyId, excludePlayerId) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;

    broadcastToLobby(lobbyId, { action: 'game_aborted' }, excludePlayerId);

    for (const [client, meta] of clients) {
        if (meta.lobbyId === lobbyId && meta.id !== excludePlayerId) meta.lobbyId = null;
    }
    lobby.players = [];
    lobby.game = { deck: [], discardPile: [], turn: 0, direction: 1, started: false };
    startedLobbies.delete(lobbyId);
}

function checkGameAborted(lobbyId, excludePlayerId) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby || !lobby.game.started) return;
    const realPlayers = lobby.players.filter(p => !p.isAI);
    if (realPlayers.length <= 1) {
        broadcastGameAborted(lobbyId, excludePlayerId);
    }
}

function generateAIName(lobby) {
    let index = 1;
    while (lobby.players.some(p => p.name === `AI-${index}`)) {
        index++;
    }
    return `AI-${index}`;
}

function clearAITimeout(playerId) {
    if (aiTimeouts.has(playerId)) {
        clearTimeout(aiTimeouts.get(playerId));
        aiTimeouts.delete(playerId);
    }
}

function clearAllAITimeouts(lobbyId) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;
    for (const player of lobby.players) {
        if (player.isAI) {
            clearAITimeout(player.id);
        }
    }
}

function performAIMove(lobbyId) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby || !lobby.game.started) return;

    const currentPlayer = lobby.players[lobby.game.turn];
    if (!currentPlayer || !currentPlayer.isAI) return;

    const decision = aiplayer.decideMove(lobby);

    if (decision.type === 'play') {
        handlePlay(lobbyId, currentPlayer.id, decision.card);
    } else if (decision.type === 'play_multiple') {
        handlePlayMultiple(lobbyId, currentPlayer.id, decision.cards);
    } else if (decision.type === 'draw') {
        handleDraw(lobbyId, currentPlayer.id);
    }
}

function scheduleAIMove(lobbyId) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby || !lobby.game.started) return;

    const currentPlayer = lobby.players[lobby.game.turn];
    if (currentPlayer && currentPlayer.isAI) {
        clearAITimeout(currentPlayer.id);
        const delay = 500 + Math.random() * 300;
        const timeout = setTimeout(() => performAIMove(lobbyId), delay);
        aiTimeouts.set(currentPlayer.id, timeout);
    }
}

function handlePlayMultiple(lobbyId, playerId, cards) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;

    const player = lobby.players.find(p => p.id === playerId);
    const playerIndex = lobby.players.findIndex(p => p.id === playerId);

    if (lobby.game.turn !== playerIndex) {
        return; // Not their turn
    }

    // Validate all cards are the same type and can be played
    const firstCard = cards[0];
    if (!cards.every(card => card.type === firstCard.type)) {
        return; // Cards must be the same type
    }

    if (!isValidMove(lobbyId, firstCard)) {
        return; // First card must be valid
    }

    // Remove all cards from player's hand
    cards.forEach(card => {
        let cardIndex;
        if (card.type === 'wild' || card.type === 'wild4') {
            cardIndex = player.hand.findIndex(c => c.type === card.type);
        } else {
            cardIndex = player.hand.findIndex(c => c.color === card.color && c.type === card.type);
        }

        if (cardIndex >= 0) {
            player.hand.splice(cardIndex, 1);
        }
    });

    // Add the last card to discard pile (the effect applies to the last card played)
    const lastCard = cards[cards.length - 1];
    lobby.game.discardPile.push(lastCard);

    // Handle special card effects (multiply by number of cards played)
    const cardCount = cards.length;

    if (lastCard.type === 'skip') {
        // Skip the next player(s)
        lobby.game.turn = (lobby.game.turn + (cardCount + 1) * lobby.game.direction + lobby.players.length) % lobby.players.length;
    } else if (lastCard.type === 'reverse') {
        // Reverse direction (multiple reverses cancel out if even number)
        if (cardCount % 2 === 1) {
            lobby.game.direction *= -1;
        }
        lobby.game.turn = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
    } else if (lastCard.type === 'draw2') {
        // Next player draws 2 cards per card played
        const nextPlayerIndex = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
        const nextPlayer = lobby.players[nextPlayerIndex];
        nextPlayer.hand.push(...drawCardsFromDeck(lobby, lobbyId, 2 * cardCount));
        lobby.game.turn = (lobby.game.turn + 2 * lobby.game.direction + lobby.players.length) % lobby.players.length;
    } else if (lastCard.type === 'wild4') {
        // Next player draws 4 cards per wild+4 played
        const nextPlayerIndex = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
        const nextPlayer = lobby.players[nextPlayerIndex];
        nextPlayer.hand.push(...drawCardsFromDeck(lobby, lobbyId, 4 * cardCount));
        lobby.game.turn = (lobby.game.turn + 2 * lobby.game.direction + lobby.players.length) % lobby.players.length;
    } else {
        // Regular cards or wild cards
        lobby.game.turn = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
    }

    broadcastGameUpdate(lobbyId);

    if (player.hand.length === 0) {
        broadcastWin(lobbyId, player.name);
    }
}

function handlePlay(lobbyId, playerId, card) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;

    const player = lobby.players.find(p => p.id === playerId);
    const playerIndex = lobby.players.findIndex(p => p.id === playerId);

    if (lobby.game.turn !== playerIndex) {
        return; // Not their turn
    }

    if (isValidMove(lobbyId, card)) {
        // Remove card from player's hand
        // For wild cards, we need to match by type only since color is added by client
        let cardIndex;
        if (card.type === 'wild' || card.type === 'wild4') {
            cardIndex = player.hand.findIndex(c => c.type === card.type);
        } else {
            cardIndex = player.hand.findIndex(c => c.color === card.color && c.type === card.type);
        }

        if (cardIndex >= 0) {
            player.hand.splice(cardIndex, 1);
        }

        // Add card to discard pile
        lobby.game.discardPile.push(card);

        // Handle special cards
        if (card.type === 'skip') {
            lobby.game.turn = (lobby.game.turn + 2 * lobby.game.direction + lobby.players.length) % lobby.players.length;
        } else if (card.type === 'reverse') {
            lobby.game.direction *= -1;
            lobby.game.turn = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
        } else if (card.type === 'draw2') {
            const nextPlayerIndex = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
            const nextPlayer = lobby.players[nextPlayerIndex];
            nextPlayer.hand.push(...drawCardsFromDeck(lobby, lobbyId, 2));
            lobby.game.turn = (lobby.game.turn + 2 * lobby.game.direction + lobby.players.length) % lobby.players.length;
        } else if (card.type === 'wild' || card.type === 'wild4') {
            // Color will be chosen by the client
            if (card.type === 'wild4') {
                const nextPlayerIndex = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
                const nextPlayer = lobby.players[nextPlayerIndex];
                nextPlayer.hand.push(...drawCardsFromDeck(lobby, lobbyId, 4));
                lobby.game.turn = (lobby.game.turn + 2 * lobby.game.direction + lobby.players.length) % lobby.players.length;
            } else {
                lobby.game.turn = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
            }
        } else {
            lobby.game.turn = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
        }

        broadcastGameUpdate(lobbyId);

        if (player.hand.length === 0) {
            broadcastWin(lobbyId, player.name);
        }
    }
}

function handleDraw(lobbyId, playerId) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby || !lobby.game.started) return;

    const playerIndex = lobby.players.findIndex(p => p.id === playerId);

    if (lobby.game.turn !== playerIndex) {
        return; // Not their turn
    }

    const player = lobby.players[playerIndex];

    const drawn = drawCardsFromDeck(lobby, lobbyId, 1);
    if (drawn.length > 0) {
        player.hand.push(drawn[0]);
    }
    lobby.game.turn = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
    broadcastGameUpdate(lobbyId);
}

function isValidMove(lobbyId, card) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return false;

    const topCard = lobby.game.discardPile[lobby.game.discardPile.length - 1];
    return card.color === topCard.color || card.type === topCard.type || card.type === 'wild' || card.type === 'wild4';
}

function checkAutoUno(lobbyId, player) {
    if (player.hand.length === 1) {
        player.uno = true;
        return true;
    }

    // Check if all remaining cards are the same type (and not wild cards)
    if (player.hand.length > 1) {
        const firstCard = player.hand[0];
        if (firstCard.type !== 'wild' && firstCard.type !== 'wild4') {
            const allSameType = player.hand.every(card => card.type === firstCard.type);
            if (allSameType) {
                player.uno = true;
                return true;
            }
        }
    }

    player.uno = false;
    return false;
}

function sanitizePlayersForClient(players) {
    return players.map(p => {
        const { hand, ...rest } = p;
        return { ...rest, cardCount: hand ? hand.length : 0 };
    });
}

function broadcastGameUpdate(lobbyId) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;

    // Check for auto UNO for all players
    lobby.players.forEach(player => {
        if (player.hand) {
            checkAutoUno(lobbyId, player);
        }
    });

    [...clients.keys()].forEach((client) => {
        const metadata = clients.get(client);
        if (metadata.lobbyId === lobbyId) {
            const player = lobby.players.find(p => p.id === metadata.id);
            if (!player) return;
            const message = {
                action: 'update',
                players: sanitizePlayersForClient(lobby.players),
                discardPile: lobby.game.discardPile,
                turn: lobby.game.turn,
                hand: player.hand
            };

            client.send(JSON.stringify(message));
        }
    });

    scheduleAIMove(lobbyId);
}

function handleUno(lobbyId, playerId) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;

    const player = lobby.players.find(p => p.id === playerId);
    if (player.hand.length === 1) {
        player.uno = true;
        broadcastPlayers(lobbyId);
    }
}



function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

wss.on('connection', (ws, req) => {
    const id = uuidv4();
    const metadata = { id };
    clients.set(ws, metadata);

    // Fallback: auto-reconnect via saved ID from localStorage
    // (client sends reconnect or join via onopen handler)

    ws.send(JSON.stringify({ action: 'init', dev: isDev(), id }))
    console.log('client connected', id)

    ws.on('message', (messageAsString) => {
        let message
        try {
            message = JSON.parse(messageAsString);
        } catch (e) {
            return;
        }

        const metadata = clients.get(ws);
        logState('msg', metadata, { action: message.action });
        if (metadata && metadata.lobbyId && message.action !== 'reconnect' && message.action !== 'join') {
            const state = validateState(metadata.id, metadata.name, metadata.lobbyId);
            if (state === 'disconnected') {
                console.log(`[server] state mismatch: player ${metadata.id?.slice(0,8)} is ${state}, resetting lobbyId`);
                metadata.lobbyId = null;
            }
        }

        if (!(message.action || '').startsWith('dev_')) {
            switch (message.action) {
                case 'join': {
                    metadata.name = message.name;
                    if (typeof message.lobbyId !== 'string' || !message.lobbyId.length) {
                        ws.send(JSON.stringify({
                            action: 'error',
                            message: '请提供大厅名称'
                        }));
                        return
                    }
                    let lobby = findOrCreateLobby(message.lobbyId);

                    if (startedLobbies.has(lobby.id)) {
                        // Allow reconnect if a disconnected player with same name exists
                        const disconnectedPlayer = lobby.players.find(p => p.disconnected && p.id === message.playerId && p.name.toLowerCase() === (message.name || '').toLowerCase());
                        if (disconnectedPlayer) {
                            const oldTimer = disconnectTimers.get(disconnectedPlayer.id);
                            if (oldTimer) clearTimeout(oldTimer);
                            disconnectTimers.delete(disconnectedPlayer.id);
                            const retryTimer = reconnectTimers.get(disconnectedPlayer.id);
                            if (retryTimer) clearTimeout(retryTimer);
                            reconnectTimers.delete(disconnectedPlayer.id);
                            disconnectedPlayer.reconnectDeadline = null;
                            disconnectedPlayer.disconnected = false;
                            metadata.name = disconnectedPlayer.name;
                            metadata.lobbyId = message.lobbyId;
                            metadata.id = disconnectedPlayer.id;
                            ws.send(JSON.stringify({ action: 'init', id: disconnectedPlayer.id, dev: isDev() }));
                            broadcastPlayers(message.lobbyId);
                            ws.send(JSON.stringify({
                                action: 'start',
                                id: disconnectedPlayer.id,
                                players: sanitizePlayersForClient(lobby.players),
                                discardPile: lobby.game.discardPile,
                                turn: lobby.game.turn,
                                hand: disconnectedPlayer.hand
                            }));
                            return;
                        }
                        ws.send(JSON.stringify({
                            action: 'error',
                            message: '大厅已开始对局, 请使用其他名称'
                        }));
                        return
                    }

                    // 检查重名
                    const existingPlayer = lobby.players.find(p => p.name.toLowerCase() === message.name.toLowerCase());
                    if (existingPlayer) {
                        if (existingPlayer.id === message.playerId || existingPlayer.disconnected) {
                            const oldTimer = disconnectTimers.get(existingPlayer.id);
                            if (oldTimer) clearTimeout(oldTimer);
                            disconnectTimers.delete(existingPlayer.id);
                            const retryTimer = reconnectTimers.get(existingPlayer.id);
                            if (retryTimer) clearTimeout(retryTimer);
                            reconnectTimers.delete(existingPlayer.id);
                            existingPlayer.reconnectDeadline = null;
                            existingPlayer.disconnected = false;
                            const dfk = existingPlayer.id;
                            const dft = deferTimers.get(dfk);
                            if (dft) { clearTimeout(dft); deferTimers.delete(dfk); }
                            metadata.name = existingPlayer.name;
                            metadata.lobbyId = message.lobbyId;
                            metadata.id = existingPlayer.id;
                            ws.send(JSON.stringify({ action: 'init', id: existingPlayer.id, dev: isDev() }));
                            broadcastPlayers(message.lobbyId);
                            return;
                        }
                        ws.send(JSON.stringify({
                            action: 'error',
                            message: '该大厅中已存在同名玩家，请选择其他名称'
                        }));
                        return;
                    }

                    metadata.lobbyId = message.lobbyId;

                    const isCreator = lobby.players.length === 0;
                    const player = {
                        id: metadata.id,
                        name: metadata.name,
                        ready: false,
                        isCreator: isCreator
                    }
                    lobby.players.push(player);
                    sessions.set(metadata.id, { name: metadata.name, lobbyId: metadata.lobbyId });
                    broadcastPlayers(metadata.lobbyId);
                    console.log('player jointed to', lobby.id, ':', player)
                    return;
                }

                case 'add_ai': {
                    const lobby = findOrCreateLobby(metadata.lobbyId);
                    const creator = lobby.players.find(p => p.id === metadata.id);
                    if (!creator || !creator.isCreator) {
                        ws.send(JSON.stringify({
                            action: 'error',
                            message: '只有房主可以邀请 AI'
                        }));
                        return;
                    }
                    if (startedLobbies.has(lobby.id)) {
                        ws.send(JSON.stringify({
                            action: 'error',
                            message: '对局已开始'
                        }));
                        return;
                    }
                    const aiId = uuidv4();
                    const aiName = generateAIName(lobby);
                    const aiPlayer = {
                        id: aiId,
                        name: aiName,
                        ready: true,
                        isCreator: false,
                        isAI: true
                    };
                    lobby.players.push(aiPlayer);
                    broadcastPlayers(metadata.lobbyId);
                    return;
                }

                case 'ai_ready': {
                    const lobby = findOrCreateLobby(metadata.lobbyId);
                    const creator = lobby.players.find(p => p.id === metadata.id);
                    if (!creator || !creator.isCreator) {
                        ws.send(JSON.stringify({
                            action: 'error',
                            message: '只有房主可以准备 AI'
                        }));
                        return;
                    }
                    const aiPlayer = lobby.players.find(p => p.id === message.playerId && p.isAI);
                    if (!aiPlayer) {
                        ws.send(JSON.stringify({
                            action: 'error',
                            message: 'AI 玩家未找到'
                        }));
                        return;
                    }
                    aiPlayer.ready = !aiPlayer.ready;
                    broadcastPlayers(metadata.lobbyId);
                    checkStartGame(metadata.lobbyId);
                    return;
                }

                case 'remove_ai': {
                    const lobby = findOrCreateLobby(metadata.lobbyId);
                    const creator = lobby.players.find(p => p.id === metadata.id);
                    if (!creator || !creator.isCreator) {
                        ws.send(JSON.stringify({
                            action: 'error',
                            message: '只有房主可以踢出 AI'
                        }));
                        return;
                    }
                    if (startedLobbies.has(lobby.id)) {
                        ws.send(JSON.stringify({
                            action: 'error',
                            message: '对局已开始'
                        }));
                        return;
                    }
                    const aiIndex = lobby.players.findIndex(p => p.id === message.playerId && p.isAI);
                    if (aiIndex === -1) {
                        ws.send(JSON.stringify({
                            action: 'error',
                            message: 'AI 玩家未找到'
                        }));
                        return;
                    }
                    clearAITimeout(lobby.players[aiIndex].id);
                    lobby.players.splice(aiIndex, 1);
                    broadcastPlayers(metadata.lobbyId);
                    return;
                }

                case 'transfer_creator': {
                    const lobby = findOrCreateLobby(metadata.lobbyId);
                    const from = lobby.players.find(p => p.id === metadata.id);
                    if (!from || !from.isCreator) {
                        ws.send(JSON.stringify({
                            action: 'error',
                            message: '只有房主可以转让'
                        }));
                        return;
                    }
                    const to = lobby.players.find(p => p.id === message.playerId);
                    if (!to || to.isAI || to.disconnected) {
                        ws.send(JSON.stringify({
                            action: 'error',
                            message: '目标玩家无效'
                        }));
                        return;
                    }
                    from.isCreator = false;
                    to.isCreator = true;
                    broadcastPlayers(metadata.lobbyId);
                    return;
                }

                case 'ready': {
                    const lobby = lobbies.get(metadata.lobbyId);
                    if (!lobby) {
                        ws.send(JSON.stringify({ action: 'error', message: '未加入大厅' }));
                        return;
                    }
                    let player = lobby.players.find(p => p.id === metadata.id);
                    if (!player) {
                        player = { id: metadata.id, name: metadata.name || 'Player', ready: false, isCreator: lobby.players.length === 0 };
                        lobby.players.push(player);
                    }
                    const oldReady = player.ready;
                    player.ready = !player.ready;
                    console.log(`[server] ready TOGGLE player=${player.name} ${oldReady}→${player.ready} metadata.lobbyId=${metadata.lobbyId?.slice(0,8)} playerId=${metadata.id?.slice(0,8)}`);
                    logState('ready', metadata, { player: player.name, ready: player.ready, allPlayers: lobby.players.map(p => ({name:p.name,ready:p.ready,disconnected:p.disconnected})) });
                    sessions.set(player.id, { ...sessions.get(player.id), pendingReady: player.ready });
                    broadcastPlayers(metadata.lobbyId);
                    checkStartGame(metadata.lobbyId);
                    return;
                }

                case 'reconnect': {
                    const session = sessions.get(message.playerId);
                    logState('reconnect', metadata, { session: !!session, playerId: message.playerId?.slice(0,8) });
                    if (!session) {
                        const newId = uuidv4();
                        metadata.id = newId;
                        ws.send(JSON.stringify({ action: 'init', id: newId, dev: isDev(), reconnectLost: true }));
                        return;
                    }
                    const rLobby = lobbies.get(session.lobbyId);
                    const lobbyAlive = rLobby && rLobby.players.length > 0;
                    logState('reconnect_lobby', metadata, { alive: lobbyAlive, started: rLobby?.game?.started, players: rLobby?.players?.length });
                    if (!lobbyAlive) {
                        // Lobby is gone or empty (game ended). Don't restore context.
                        // Client will show join form. Session stays for future reconnects.
                        const newId = uuidv4();
                        metadata.id = newId;
                        console.log(`[server] reconnect lobby dead, new session newId=${newId.slice(0,8)}, keeping old session=${message.playerId.slice(0,8)}`);
                        ws.send(JSON.stringify({ action: 'init', id: newId, dev: isDev(), reconnectLost: true }));
                        return;
                    }
                    const existingPlayer = rLobby.players.find(p => p.id === message.playerId);
                    console.log(`[server] reconnect existingPlayer=${!!existingPlayer} disconnected=${existingPlayer?.disconnected} ready=${existingPlayer?.ready}`);
                    if (!existingPlayer) {
                        // Player was removed from lobby (30s timeout, game ended, etc.)
                        // Don't restore context — send reconnectLost
                        const newId = uuidv4();
                        metadata.id = newId;
                        ws.send(JSON.stringify({ action: 'init', id: newId, dev: isDev(), reconnectLost: true }));
                        return;
                    }
                    metadata.name = session.name;
                    metadata.lobbyId = session.lobbyId;
                    metadata.id = message.playerId;
                    ws.send(JSON.stringify({ action: 'init', id: message.playerId, dev: isDev() }));
                    const oldTimer = disconnectTimers.get(existingPlayer.id);
                    if (oldTimer) clearTimeout(oldTimer);
                    disconnectTimers.delete(existingPlayer.id);
                    const retryTimer = reconnectTimers.get(existingPlayer.id);
                    if (retryTimer) clearTimeout(retryTimer);
                    reconnectTimers.delete(existingPlayer.id);
                    existingPlayer.reconnectDeadline = null;
                    existingPlayer.disconnected = false;
                    // Cancel any deferred close processing for this player
                    const deferKey = existingPlayer.id;
                    const deferTimer = deferTimers.get(deferKey);
                    if (deferTimer) { clearTimeout(deferTimer); deferTimers.delete(deferKey); }
                    // Restore pending ready from session (survives WS closure)
                    const pending = sessions.get(existingPlayer.id);
                    if (pending && pending.pendingReady !== undefined) {
                        existingPlayer.ready = pending.pendingReady;
                        console.log(`[server] reconnect restored ready=${existingPlayer.ready} for ${existingPlayer.name}`);
                    } else {
                        console.log(`[server] reconnect NO pendingReady for ${existingPlayer.name}, current ready=${existingPlayer.ready}`);
                    }
                    // Suppress old WS close handler
                    for (const [existingWs, existingMeta] of clients) {
                        if (existingMeta.id === message.playerId && existingWs !== ws) {
                            existingMeta.lobbyId = null;
                        }
                    }
                    broadcastPlayers(session.lobbyId);
                    if (rLobby.game.started) {
                        const player = existingPlayer || rLobby.players[0];
                        if (player && player.hand) {
                            ws.send(JSON.stringify({
                                action: 'start',
                                id: message.playerId,
                                players: sanitizePlayersForClient(rLobby.players),
                                discardPile: rLobby.game.discardPile,
                                turn: rLobby.game.turn,
                                hand: player.hand
                            }));
                        }
                    } else {
                        ws.send(JSON.stringify({
                            action: 'players',
                            players: rLobby.players,
                            turn: rLobby.game.turn,
                            lobbyId: session.lobbyId
                        }));
                    }
                    return;
                }

                case 'play':
                    if (!lobbies.has(metadata.lobbyId)) {
                        ws.send(JSON.stringify({ action: 'error', message: '游戏房间已不存在，单击确认刷新页面' })); return;
                    }
                    handlePlay(metadata.lobbyId, metadata.id, message.card);
                    return;

                case 'draw':
                    if (!lobbies.has(metadata.lobbyId)) {
                        ws.send(JSON.stringify({ action: 'error', message: '游戏房间已不存在，单击确认刷新页面' })); return;
                    }
                    handleDraw(metadata.lobbyId, metadata.id);
                    return;

                case 'uno':
                    if (!lobbies.has(metadata.lobbyId)) {
                        ws.send(JSON.stringify({ action: 'error', message: '游戏房间已不存在，单击确认刷新页面' })); return;
                    }
                    handleUno(metadata.lobbyId, metadata.id);
                    return;

                case 'play_multiple':
                    if (!lobbies.has(metadata.lobbyId)) {
                        ws.send(JSON.stringify({ action: 'error', message: '游戏房间已不存在，请刷新页面' })); return;
                    }
                    handlePlayMultiple(metadata.lobbyId, metadata.id, message.cards);
                    return;

                case 'leave':
                    if (!lobbies.has(metadata.lobbyId)) {
                        ws.send(JSON.stringify({ action: 'error', message: '游戏房间已不存在，请刷新页面' })); return;
                    }
                    handleLeave(metadata.lobbyId, metadata.id);
                    return;

                case 'surrender': {
                    const sLobby = lobbies.get(metadata.lobbyId);
                    if (!sLobby || !sLobby.game.started) return;
                    const surrenderPlayer = sLobby.players.find(p => p.id === metadata.id);
                    if (!surrenderPlayer) return;
                    const winner = sLobby.players.find(p => p.id !== metadata.id && !p.isAI)
                        || sLobby.players.find(p => p.id !== metadata.id);
                    if (winner) {
                        broadcastWin(metadata.lobbyId, winner.name);
                    }
                    return;
                }

                case 'reaction':
                    const lobby = lobbies.get(metadata.lobbyId);
                    if (!lobby || !lobby.game.started) break;
                    if (message.type === 'emoji') {
                        broadcastToLobby(metadata.lobbyId, {
                            action: 'reaction',
                            playerId: metadata.id,
                            type: 'emoji',
                            content: message.content
                        });
                    } else if (message.type === 'text') {
                        if (typeof message.content !== 'string' || message.content.length === 0) break;
                        let width = 0;
                        for (const ch of message.content) {
                            if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) width += 1;
                            else width += 0.3;
                        }
                        if (width > 64) break;
                        broadcastToLobby(metadata.lobbyId, {
                            action: 'reaction',
                            playerId: metadata.id,
                            type: 'text',
                            content: message.content
                        });
                    }
                    break;

                default:
                    console.warn('unhandled event', message)
                    return
            }
        } else {
            if (!isDev()) {
                console.warn('cannot handle dev event for production environment', message)
                return
            }

            // for dev
            switch (message.action) {
                case 'dev_call_win':
                    const lobby1 = findOrCreateLobby(metadata.lobbyId);
                    const player1 = lobby1.players.find(p => p.id === metadata.id);
                    if (!player1) {
                        ws.send(JSON.stringify({
                            action: 'error',
                            message: '玩家ID未找到'
                        }));
                        return;
                    }
                    broadcastWin(metadata.lobbyId, player1.name)
                    return;
                case 'dev_add_cards': {
                    const lobby2 = findOrCreateLobby(metadata.lobbyId);
                    if (!lobby2.game.started) { ws.send(JSON.stringify({ action: 'error', message: '对局未开始' })); return; }
                    const player2 = lobby2.players.find(p => p.id === metadata.id);
                    if (!player2) { ws.send(JSON.stringify({ action: 'error', message: '玩家ID未找到' })); return; }
                    const count = Math.min(message.count || 1, 20);
                    let drawn = lobby2.game.deck.splice(0, count);
                    if (drawn.length < count && lobby2.game.discardPile.length >= 2) {
                        const topCard = lobby2.game.discardPile.pop();
                        lobby2.game.deck = lobby2.game.discardPile;
                        lobby2.game.discardPile = [topCard];
                        shuffleDeck(metadata.lobbyId);
                        const more = lobby2.game.deck.splice(0, count - drawn.length);
                        drawn = [...drawn, ...more];
                    }
                    player2.hand.push(...drawn);
                    broadcastGameUpdate(metadata.lobbyId);
                    return;
                }
                case 'dev_add_all_cards': {
                    const lobby2 = findOrCreateLobby(metadata.lobbyId);
                    if (!lobby2.game.started) { ws.send(JSON.stringify({ action: 'error', message: '对局未开始' })); return; }
                    const player2 = lobby2.players.find(p => p.id === metadata.id);
                    if (!player2) { ws.send(JSON.stringify({ action: 'error', message: '玩家ID未找到' })); return; }
                    let drawn = lobby2.game.deck.splice(0, lobby2.game.deck.length);
                    if (drawn.length === 0 && lobby2.game.discardPile.length >= 2) {
                        const topCard = lobby2.game.discardPile.pop();
                        lobby2.game.deck = lobby2.game.discardPile;
                        lobby2.game.discardPile = [topCard];
                        shuffleDeck(metadata.lobbyId);
                        drawn = lobby2.game.deck.splice(0, lobby2.game.deck.length);
                    }
                    // Reserve card for discard so draws can reshuffle
                    if (drawn.length > 0 && lobby2.game.discardPile.length < 2) {
                        lobby2.game.discardPile.push(drawn.shift());
                    }
                    player2.hand.push(...drawn);
                    broadcastGameUpdate(metadata.lobbyId);
                    return;
                }
                case 'dev_remove_cards': {
                    const lobby3 = findOrCreateLobby(metadata.lobbyId);
                    if (!lobby3.game.started) { ws.send(JSON.stringify({ action: 'error', message: '对局未开始' })); return; }
                    const player3 = lobby3.players.find(p => p.id === metadata.id);
                    if (!player3) { ws.send(JSON.stringify({ action: 'error', message: '玩家ID未找到' })); return; }
                    const removeCount = Math.min(message.count || 1, player3.hand.length);
                    const removed = player3.hand.splice(0, removeCount);
                    lobby3.game.discardPile.push(...removed);
                    if (player3.hand.length === 0) {
                        broadcastWin(metadata.lobbyId, player3.name);
                    } else {
                        broadcastGameUpdate(metadata.lobbyId);
                    }
                    return;
                }
                case 'dev_skip': {
                    const lobby4 = findOrCreateLobby(metadata.lobbyId);
                    if (!lobby4.game.started) { ws.send(JSON.stringify({ action: 'error', message: '对局未开始' })); return; }
                    lobby4.game.turn = (lobby4.game.turn + lobby4.game.direction + lobby4.players.length) % lobby4.players.length;
                    broadcastGameUpdate(metadata.lobbyId);
                    return;
                }
                case 'dev_export_state': {
                    logState('export', metadata);
                    ws.send(JSON.stringify({ action: 'dev_state_export', log: stateLog }));
                    return;
                }
                default:
                    console.warn('unhandled dev event', message)
            }
        }
    });

    ws.on('close', () => {
        const metadata = clients.get(ws);
        logState('close', metadata);
        if (metadata && metadata.lobbyId) {
            const player = lobbies.get(metadata.lobbyId)?.players.find(p => p.id === metadata.id);
            if (player) player.disconnected = true;
            scheduleProcessClose(metadata.id, ws, metadata);
        }
        clients.delete(ws);
    });
});

function scheduleProcessClose(playerId, ws, metadata) {
    const deferKey = playerId || (metadata && metadata.lobbyId);
    if (!deferKey) return processClose(ws, metadata);
    const existing = deferTimers.get(deferKey);
    if (existing) clearTimeout(existing);
    const deferTimer = setTimeout(() => {
        deferTimers.delete(deferKey);
        processClose(ws, metadata);
    }, 500);
    deferTimers.set(deferKey, deferTimer);
}

function processClose(ws, metadata) {
    const lobby = lobbies.get(metadata.lobbyId);
    if (!lobby) return;
    const player = lobby.players.find(p => p.id === metadata.id);
    if (!player) return;
    player.disconnected = true;
    player.reconnectDeadline = Date.now() + 15000;
    broadcastPlayers(metadata.lobbyId);
    if (lobby.game.started) {
        broadcastGameUpdate(metadata.lobbyId);
    }
    const reconnectTimer = setTimeout(() => {
        reconnectTimers.delete(player.id);
        if (!player.disconnected) return;
        // Skip this player's turn if it's their turn
        if (lobby.game.started &&
            lobby.game.turn === lobby.players.indexOf(player)) {
            lobby.game.turn = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
            broadcastGameUpdate(metadata.lobbyId);
        }
        // Remove the player after reconnect deadline
        const oldTimer = disconnectTimers.get(player.id);
        if (oldTimer) clearTimeout(oldTimer);
        disconnectTimers.delete(player.id);
        const idx = lobby.players.findIndex(p => p.id === player.id);
        if (idx > -1) {
            const removed = lobby.players.splice(idx, 1)[0];
            if (removed.isCreator && lobby.players.length > 0) {
                lobby.players[0].isCreator = true;
            }
            sessions.delete(player.id);
            checkGameAborted(metadata.lobbyId, metadata.id);
            broadcastPlayers(metadata.lobbyId);
            if (lobby.players.length === 0) lobbies.delete(metadata.lobbyId);
        }
    }, 15000);
    reconnectTimers.set(player.id, reconnectTimer);
    const timer = setTimeout(() => {
        disconnectTimers.delete(player.id);
        const idx = lobby.players.findIndex(p => p.id === player.id);
        if (idx > -1 && lobby.players[idx].disconnected) {
            const removed = lobby.players.splice(idx, 1)[0];
            if (removed.isCreator) {
                const removedAIs = lobby.players.filter(p => p.isAI);
                lobby.players = lobby.players.filter(p => !p.isAI);
                for (const ai of removedAIs) clearAITimeout(ai.id);
                if (lobby.players.length > 0) lobby.players[0].isCreator = true;
            }
            sessions.delete(player.id);
            checkGameAborted(metadata.lobbyId, metadata.id);
            broadcastPlayers(metadata.lobbyId);
            if (lobby.players.length === 0) lobbies.delete(metadata.lobbyId);
        }
    }, 30000);
    disconnectTimers.set(player.id, timer);
}

function handleLeave(lobbyId, playerId) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;

    const playerIndex = lobby.players.findIndex(p => p.id === playerId);
    if (playerIndex > -1) {
        const player = lobby.players[playerIndex]
        lobby.players.splice(playerIndex, 1);

        if (player.isCreator) {
            const removedAIs = lobby.players.filter(p => p.isAI);
            lobby.players = lobby.players.filter(p => !p.isAI);
            for (const ai of removedAIs) clearAITimeout(ai.id);
            // Transfer creator to next non-AI player
            if (lobby.players.length > 0) {
                lobby.players[0].isCreator = true;
            }
        }

        checkGameAborted(lobbyId, playerId);

        // Exclude the leaving player from the broadcast so the client's resetGameState isn't overridden
        broadcastToLobby(lobbyId, {
            action: 'players',
            players: lobby.players,
            turn: lobby.game.turn,
            lobbyId: lobbyId
        }, playerId);

        checkStartGame(lobbyId);
        console.log('player leaved from', lobby.id, ':', player)

        // If lobby is empty, we could optionally remove it
        if (lobby.players.length === 0) {
            lobbies.delete(lobbyId);
        }
    }
}

function hasFlagExitImmediately() {
    return process.argv.includes('--exit-immediately') || process.argv.includes('-e');
}

function isDev() {
    return process.env.NODE_ENV === 'development'
}

process.on('SIGINT', () => {
    process.stdout.write('\nServer closed')

    if (!!process.stdin && !hasFlagExitImmediately() && !isDev()) {
        console.log(', press any key to close this window...');
        try {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on('data', () => process.exit(0));
        } catch (e) {
            console.warn('cannot wait for any key')
            console.error(e)
            process.exit(0)
        }
    } else {
        console.log()  // \n
        process.exit(0)
    }
});


httpServer.on('listening', () => console.log('Server started on port 3000'))
httpServer.on('error', (e) => { console.error(e); process.emit('SIGINT'); })
httpServer.listen(3000)
