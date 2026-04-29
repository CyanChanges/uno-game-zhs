import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 8080 });

const clients = new Map();
const lobbies = new Map(); // Map of lobbyId -> lobby object

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

function generateLobbyId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

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
    if (lobby.players.length > 1 && lobby.players.every(p => p.ready)) {
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
    
    lobby.game.started = true;
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
            const message = {
                action: 'start',
                players: lobby.players,
                discardPile: lobby.game.discardPile,
                turn: lobby.game.turn,
                hand: player.hand,
                id: metadata.id
            };
            client.send(JSON.stringify(message));
        }
    });
}

function broadcastWin(lobbyId, winnerName) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;
    
    const message = {
        action: 'win',
        winner: winnerName
    };
    broadcastToLobby(lobbyId, message);
    
    // Reset game state completely
    lobby.players.length = 0; // Clear all players from lobby
    lobby.game.deck = [];
    lobby.game.discardPile = [];
    lobby.game.turn = 0;
    lobby.game.direction = 1;
    lobby.game.started = false;
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
        nextPlayer.hand.push(...lobby.game.deck.splice(0, 2 * cardCount));
        lobby.game.turn = (lobby.game.turn + 2 * lobby.game.direction + lobby.players.length) % lobby.players.length;
    } else if (lastCard.type === 'wild4') {
        // Next player draws 4 cards per wild+4 played
        const nextPlayerIndex = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
        const nextPlayer = lobby.players[nextPlayerIndex];
        nextPlayer.hand.push(...lobby.game.deck.splice(0, 4 * cardCount));
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
            nextPlayer.hand.push(...lobby.game.deck.splice(0, 2));
            lobby.game.turn = (lobby.game.turn + 2 * lobby.game.direction + lobby.players.length) % lobby.players.length;
        } else if (card.type === 'wild' || card.type === 'wild4') {
            // Color will be chosen by the client
            if (card.type === 'wild4') {
                const nextPlayerIndex = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
                const nextPlayer = lobby.players[nextPlayerIndex];
                nextPlayer.hand.push(...lobby.game.deck.splice(0, 4));
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
    if (!lobby) return;
    
    const playerIndex = lobby.players.findIndex(p => p.id === playerId);

    if (lobby.game.turn !== playerIndex) {
        return; // Not their turn
    }

    const player = lobby.players[playerIndex];
    player.hand.push(lobby.game.deck.pop());
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
            const message = {
                action: 'update',
                players: lobby.players,
                discardPile: lobby.game.discardPile,
                turn: lobby.game.turn,
                hand: player.hand
            };
            client.send(JSON.stringify(message));
        }
    });
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
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

wss.on('connection', (ws) => {
    const id = uuidv4();
    const metadata = { id };
    clients.set(ws, metadata);

    console.log('Client connected');

    ws.on('message', (messageAsString) => {
        const message = JSON.parse(messageAsString);
        const metadata = clients.get(ws);

        if (message.action === 'join') {
            metadata.name = message.name;
            metadata.lobbyId = message.lobbyId || generateLobbyId();
            const lobby = findOrCreateLobby(metadata.lobbyId);
            
            // Check if name already exists in this lobby
            const existingPlayer = lobby.players.find(p => p.name.toLowerCase() === message.name.toLowerCase());
            if (existingPlayer) {
                // Send error message back to client
                ws.send(JSON.stringify({
                    action: 'error',
                    message: 'A player with that name already exists in this lobby. Please choose a different name.'
                }));
                return;
            }
            
            // Check if this is the first player (lobby creator)
            const isCreator = lobby.players.length === 0;
            
            lobby.players.push({ 
                id: metadata.id, 
                name: metadata.name, 
                ready: false,
                isCreator: isCreator
            });
            broadcastPlayers(metadata.lobbyId);
        }

        if (message.action === 'ready') {
            const lobby = findOrCreateLobby(metadata.lobbyId);
            const player = lobby.players.find(p => p.id === metadata.id);
            if (!player) {  // play is not in lobby
                ws.send(JSON.stringify({
                    action: 'error',
                    message: 'Ready is only available after joined a lobby'
                }));
                return
            }
            player.ready = !player.ready;
            broadcastPlayers(metadata.lobbyId);
            checkStartGame(metadata.lobbyId);
        }

        if (message.action === 'play') {
            handlePlay(metadata.lobbyId, metadata.id, message.card);
        }

        if (message.action === 'draw') {
            handleDraw(metadata.lobbyId, metadata.id);
        }

        if (message.action === 'uno') {
            handleUno(metadata.lobbyId, metadata.id);
        }

        if (message.action === 'play_multiple') {
            handlePlayMultiple(metadata.lobbyId, metadata.id, message.cards);
        }
        
        if (message.action === 'leave') {
            handleLeave(metadata.lobbyId, metadata.id);
        }
    });

    ws.on('close', () => {
        const metadata = clients.get(ws);
        const lobby = findOrCreateLobby(metadata.lobbyId);
        const playerIndex = lobby.players.findIndex(p => p.id === metadata.id);
        if (playerIndex > -1) {
            lobby.players.splice(playerIndex, 1);
            broadcastPlayers(metadata.lobbyId);
        }
        clients.delete(ws);
        console.log('Client disconnected');
    });
});

function handleLeave(lobbyId, playerId) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;
    
    const playerIndex = lobby.players.findIndex(p => p.id === playerId);
    if (playerIndex > -1) {
        lobby.players.splice(playerIndex, 1);
        broadcastPlayers(lobbyId);
        
        // If lobby is empty, we could optionally remove it
        if (lobby.players.length === 0) {
            lobbies.delete(lobbyId);
        }
    }
}

console.log('Server started on port 8080');
