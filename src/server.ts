import { WebSocketServer, WebSocket } from 'ws';
import { Server, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { decideMove } from './aiplayer';
import { ERR, errorResponse, ErrorCode } from './errors';
import { RECONNECT_DEFER_MS, RECONNECT_DEADLINE_MS, DISCONNECT_REMOVE_MS, MAX_HAND_CARDS } from './constants';

interface Card {
  color?: string;
  type: string;
}

interface Player {
  id: string;
  name: string;
  ready: boolean;
  isCreator: boolean;
  isAI?: boolean;
  disconnected?: boolean;
  reconnectDeadline?: number | null;
  hand?: Card[];
  uno?: boolean;
}

enum LobbyGameState {
  normal,
  drawing  // 连续出加牌中...
}

interface Lobby {
  id: string;
  players: Player[];
  game: {
    deck: Card[];
    discardPile: Card[];
    turn: number;
    direction: number;
    started: boolean;
    state: LobbyGameState,
    drawingCount: number
  };
}

interface ClientMetadata {
  id: string;
  name?: string;
  lobbyId?: string | null;
  isSpectator?: boolean;
}

interface SessionData {
  name: string;
  lobbyId: string;
  pendingReady?: boolean;
}

interface StateLogEntry {
  t: number;
  event: string;
  playerId?: string;
  lobbyId?: string;
  name?: string;
  [key: string]: unknown;
}

interface ClientMessage {
  action: string;
  name?: string;
  lobbyId?: string;
  playerId?: string;
  card?: Card;
  cards?: Card[];
  indices?: number[];
  count?: number;
  type?: string;
  content?: string;
}

type StaticFile = [string, string];

const allowFiles: StaticFile[] = [['index.html', 'text/html'], ['about.html', 'text/html'], ['client.js', 'text/javascript'], ['style.css', 'text/css']];
const files: Record<string, { content: Buffer; type: string }> = {};

function loadStaticFiles(): void {
  for (const [file, type] of allowFiles) {
    let fullPath = path.join(__dirname, file);
    try { readFileSync(fullPath); } catch (_e) {
      if (file === 'client.js') {
        fullPath = path.join(__dirname, '..', 'dist', file);
      } else {
        fullPath = path.join(__dirname, '..', 'public', file);
      }
    }
    files[file] = { content: readFileSync(fullPath), type };
  }
}

// Load static files at startup
loadStaticFiles();

const httpServer = new Server((req: IncomingMessage, res: ServerResponse) => {
  const url = (req.url || '').toLowerCase();
  const filename = url.slice(1);

  if (url === '/') {
    const { content, type } = files[allowFiles[0][0]];
    res.setHeader('Content-Type', type);
    return res.end(content);
  }

  if (url === '/about') {
    const { content, type } = files['about.html'];
    res.setHeader('Content-Type', type);
    return res.end(content);
  }

  if (isDev() && url === '/errors') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(ERR));
  }

  // Serve icon SVGs from /icons/ path or static icons directory
  if (url.startsWith('/icons/')) {
    const iconFile = filename.slice(6); // remove "icons/"
    if (iconFile) {
      try {
        let iconPath = path.join(__dirname, 'icons', iconFile);
        if (!existsSync(iconPath)) {
          iconPath = path.join(__dirname, '..', 'public', 'icons', iconFile);
        }
        const content = readFileSync(iconPath);
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.end(content);
      } catch (_e) { /* fall through */ }
    }
  }

  if (!!filename && filename in files) {
    const { content, type } = files[filename];
    res.setHeader('Content-Type', type);
    return res.end(content);
  }

  res.statusCode = 404
  return res.end()
});

httpServer.on('upgrade', (request: IncomingMessage, socket: import('net').Socket, head: Buffer) => {
  const { pathname } = new URL(request.url!, `http://${request.headers.host}`);

  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

const wss = new WebSocketServer({ noServer: true });

const clients = new Map<WebSocket, ClientMetadata>();
const lobbies = new Map<string, Lobby>();
const startedLobbies = new Set<string>();
const aiTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const sessions = new Map<string, SessionData>();
const deferTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ── Logging ──────────────────────────────────────────────
const LOG_PREFIX = '[server]';

function serverLog(msg: string, ...args: unknown[]): void {
  console.log(`${LOG_PREFIX} ${msg}`, ...args);
}

function serverWarn(msg: string, detail?: unknown): void {
  console.warn(`${LOG_PREFIX} ${msg}`, detail ?? '');
}

let stateLog: StateLogEntry[] = [];
function logState(event: string, metadata?: ClientMetadata, details: Record<string, unknown> = {}): void {
  if (!isDev()) return;
  stateLog.push({
    t: Date.now(),
    event,
    playerId: metadata?.id?.slice(0, 8),
    lobbyId: metadata?.lobbyId?.slice(0, 8),
    name: metadata?.name,
    ...details
  });
  if (stateLog.length > 10000) stateLog.splice(0, 1000);
}

function validateState(playerId: string, _name: string | undefined, lobbyId: string | null | undefined): string {
  if (!lobbyId) return 'disconnected';
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return 'disconnected';
  const player = lobby.players.find(p => p.id === playerId);
  if (!player) return 'disconnected';
  if (player.disconnected) return 'reconnecting';
  if (lobby.game.started) return 'in_game';
  return 'in_lobby';
}

function createLobby(lobbyId: string): Lobby {
  return {
    id: lobbyId,
    players: [],
    game: {
      deck: [],
      discardPile: [],
      turn: 0,
      direction: 1,
      started: false,
      state: LobbyGameState.normal,
      drawingCount: 0
    }
  };
}

function findOrCreateLobby(lobbyId: string): Lobby {
  if (!lobbies.has(lobbyId)) {
    lobbies.set(lobbyId, createLobby(lobbyId));
  }
  return lobbies.get(lobbyId)!;
}

function broadcastToLobby(lobbyId: string, message: object, excludeClientId: string | null = null): void {
  [...clients.keys()].forEach((client) => {
    const metadata = clients.get(client);
    if (metadata && metadata.lobbyId === lobbyId && metadata.id !== excludeClientId) {
      client.send(JSON.stringify(message));
    }
  });
}

function broadcastPlayers(lobbyId: string): void {
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

function checkStartGame(lobbyId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;
  const activePlayers = lobby.players.filter(p => !p.disconnected);
  serverLog(`checkStartGame lobby=${lobbyId?.slice(0, 8)} total=${lobby.players.length} active=${activePlayers.length} activeReady=${activePlayers.filter(p => p.ready).length}`);
  if (lobby.players.length >= 2 && activePlayers.length >= 2 && activePlayers.every(p => p.ready)) {
    startGame(lobbyId);
  }
}

function createDeck(lobbyId: string): void {
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

function shuffleDeck(lobbyId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;

  for (let i = lobby.game.deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [lobby.game.deck[i], lobby.game.deck[j]] = [lobby.game.deck[j], lobby.game.deck[i]];
  }
}

function generateRandomCard(): Card {
  const colors = ['red', 'yellow', 'green', 'blue'];
  const types = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2'];
  const r = Math.random();
  if (r < 0.05) return { type: 'wild4' };
  if (r < 0.10) return { type: 'wild' };
  return {
    color: colors[Math.floor(Math.random() * colors.length)],
    type: types[Math.floor(Math.random() * types.length)]
  };
}

function drawCardsFromDeck(lobby: Lobby, lobbyId: string, count: number): Card[] {
  const drawn: Card[] = [];
  while (drawn.length < count) {
    let card: Card

    if (false && lobby.game.deck.length > 1) {
      // disabled
      card = lobby.game.deck.pop()!;
      if (!card) {
        if (lobby.game.discardPile.length >= 2) {
          const topCard = lobby.game.discardPile.pop()!;
          lobby.game.deck = lobby.game.discardPile;
          lobby.game.discardPile = [topCard];
          shuffleDeck(lobbyId);
          card = lobby.game.deck.pop()!;
        }
      }
    } else {
      card = generateRandomCard();
    }
    if (card) drawn.push(card);
  }

  return drawn;
}

function dealCards(lobbyId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;

  for (const player of lobby.players) {
    player.hand = lobby.game.deck.splice(0, 7);
    player.uno = false;
  }
}

function startGame(lobbyId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;
  const activePlayers = lobby.players.filter(p => !p.disconnected);
  if (activePlayers.length < 2) return;

  lobby.game.started = true;
  startedLobbies.add(lobbyId);
  createDeck(lobbyId);
  shuffleDeck(lobbyId);
  dealCards(lobbyId);

  let firstCardIndex = lobby.game.deck.findIndex(card => card.type !== 'wild' && card.type !== 'wild4');
  if (firstCardIndex === -1) {
    shuffleDeck(lobbyId);
    firstCardIndex = lobby.game.deck.findIndex(card => card.type !== 'wild' && card.type !== 'wild4');
  }
  lobby.game.discardPile.push(lobby.game.deck.splice(firstCardIndex, 1)[0]);

  [...clients.keys()].forEach((client) => {
    const metadata = clients.get(client);
    if (metadata && metadata.lobbyId === lobbyId) {
      const player = lobby.players.find(p => p.id === metadata.id);
      if (!player) return;
      const message = {
        action: 'start',
        players: sanitizePlayersForClient(lobby.players),
        discardPile: lobby.game.discardPile,
        turn: lobby.game.turn,
        direction: lobby.game.direction,
            gameState: lobby.game.state,
            drawingCount: lobby.game.drawingCount,
        hand: player.hand,
        id: metadata.id
      };
      client.send(JSON.stringify(message));
    }
  });

  scheduleAIMove(lobbyId);
}

function broadcastWin(lobbyId: string, winnerName: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;

  broadcastToLobby(lobbyId, { action: 'win', winner: winnerName });

  for (const [, meta] of clients) {
    if (meta.lobbyId === lobbyId) meta.lobbyId = null;
  }
  lobby.players.length = 0;
  lobby.game = { deck: [], discardPile: [], turn: 0, direction: 1, started: false, state: LobbyGameState.normal, drawingCount: 0 };
  startedLobbies.delete(lobbyId);
}

function broadcastGameAborted(lobbyId: string, excludePlayerId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;

  broadcastToLobby(lobbyId, { action: 'game_aborted' }, excludePlayerId);

  for (const [client, meta] of clients) {
    if (meta.lobbyId === lobbyId && meta.id !== excludePlayerId) meta.lobbyId = null;
  }
  lobby.players = [];
  lobby.game = { deck: [], discardPile: [], turn: 0, direction: 1, started: false, state: LobbyGameState.normal, drawingCount: 0 };
  startedLobbies.delete(lobbyId);
}

function checkGameAborted(lobbyId: string, excludePlayerId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby || !lobby.game.started) return;
  const realPlayers = lobby.players.filter(p => !p.isAI);
  if (realPlayers.length <= 1) {
    broadcastGameAborted(lobbyId, excludePlayerId);
  }
}

function generateAIName(lobby: Lobby): string {
  let index = 1;
  while (lobby.players.some(p => p.name === `AI-${index}`)) {
    index++;
  }
  return `AI-${index}`;
}

function clearAITimeout(playerId: string): void {
  if (aiTimeouts.has(playerId)) {
    clearTimeout(aiTimeouts.get(playerId));
    aiTimeouts.delete(playerId);
  }
}

function clearAllAITimeouts(lobbyId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;
  for (const player of lobby.players) {
    if (player.isAI) {
      clearAITimeout(player.id);
    }
  }
}

function performAIMove(lobbyId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby || !lobby.game.started) return;

  const currentPlayer = lobby.players[lobby.game.turn];
  if (!currentPlayer || !currentPlayer.isAI) return;

  const decision = decideMove(lobby);

  if (decision.type === 'play') {
    handlePlay(lobbyId, currentPlayer.id, decision.card);
  } else if (decision.type === 'play_multiple') {
    handlePlayMultiple(lobbyId, currentPlayer.id, decision.cards);
  } else if (decision.type === 'draw') {
    handleDraw(lobbyId, currentPlayer.id);
  }
}

function scheduleAIMove(lobbyId: string): void {
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

function handlePlayMultiple(lobbyId: string, playerId: string, cards: Card[]): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;

  const player = lobby.players.find(p => p.id === playerId);
  const playerIndex = lobby.players.findIndex(p => p.id === playerId);

  if (!player || lobby.game.turn !== playerIndex) {
    return;
  }

  const firstCard = cards[0];
  if (!cards.every(card => card.type === firstCard.type)) {
    return;
  }

  if (!isValidMove(lobbyId, firstCard)) {
    return;
  }

  cards.forEach(card => {
    let cardIndex: number;
    if (card.type === 'wild' || card.type === 'wild4') {
      cardIndex = player.hand!.findIndex(c => c.type === card.type);
    } else {
      cardIndex = player.hand!.findIndex(c => c.color === card.color && c.type === card.type);
    }

    if (cardIndex >= 0) {
      player.hand!.splice(cardIndex, 1);
    }
  });

  const lastCard = cards[cards.length - 1];
  lobby.game.discardPile.push(lastCard);

  const cardCount = cards.length;

  if (lastCard.type === 'skip') {
    lobby.game.turn = (lobby.game.turn + (cardCount + 1) * lobby.game.direction + lobby.players.length) % lobby.players.length;
    lobby.game.state = LobbyGameState.normal;
    lobby.game.drawingCount = 0;
  } else if (lastCard.type === 'reverse') {
    if (cardCount % 2 === 1) {
      lobby.game.direction *= -1;
    }
    lobby.game.turn = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
    lobby.game.state = LobbyGameState.normal;
    lobby.game.drawingCount = 0;
  } else if (lastCard.type === 'draw2' || lastCard.type === 'wild4') {
    const n = (lastCard.type === 'draw2' ? 2 : 4) * cardCount;
    if (lobby.game.state === LobbyGameState.normal) {
      lobby.game.state = LobbyGameState.drawing;
      lobby.game.drawingCount = n;
    } else {
      lobby.game.drawingCount += n;
    }
    lobby.game.turn = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
  } else {
    // Non-draw card: break chain
    if (lobby.game.state === LobbyGameState.drawing) {
      const penalty = lobby.game.drawingCount;
      lobby.game.state = LobbyGameState.normal;
      lobby.game.drawingCount = 0;
      if (penalty > 0 && player) {
        player.hand!.push(...drawCardsFromDeck(lobby, lobbyId, penalty));
      }
    }
    lobby.game.turn = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
  }

  broadcastGameUpdate(lobbyId);

  if (player && player.hand && player.hand.length === 0) {
    broadcastWin(lobbyId, player.name);
  }
}

function handlePlay(lobbyId: string, playerId: string, card: Card): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;

  const player = lobby.players.find(p => p.id === playerId);
  const playerIndex = lobby.players.findIndex(p => p.id === playerId);

  if (lobby.game.turn !== playerIndex) {
    return;
  }

  if (isValidMove(lobbyId, card)) {
    let cardIndex: number;
    if (card.type === 'wild' || card.type === 'wild4') {
      cardIndex = player!.hand!.findIndex(c => c.type === card.type);
    } else {
      cardIndex = player!.hand!.findIndex(c => c.color === card.color && c.type === card.type);
    }

    if (cardIndex >= 0) {
      player!.hand!.splice(cardIndex, 1);
    }

    lobby.game.discardPile.push(card);

    if (card.type === 'skip') {
      lobby.game.turn = (lobby.game.turn + 2 * lobby.game.direction + lobby.players.length) % lobby.players.length;
      lobby.game.state = LobbyGameState.normal;
      lobby.game.drawingCount = 0;
    } else if (card.type === 'reverse') {
      lobby.game.direction *= -1;
      lobby.game.turn = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
      lobby.game.state = LobbyGameState.normal;
      lobby.game.drawingCount = 0;
    } else if (card.type === 'draw2' || card.type === 'wild4') {
      const n = card.type === 'draw2' ? 2 : 4;
      if (lobby.game.state === LobbyGameState.normal) {
        lobby.game.state = LobbyGameState.drawing;
        lobby.game.drawingCount = n;
      } else {
        lobby.game.drawingCount += n;
      }
      lobby.game.turn = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
    } else {
      // Non-draw card: break chain
      if (lobby.game.state === LobbyGameState.drawing) {
        const penalty = lobby.game.drawingCount;
        lobby.game.state = LobbyGameState.normal;
        lobby.game.drawingCount = 0;
        if (penalty > 0) {
          player!.hand!.push(...drawCardsFromDeck(lobby, lobbyId, penalty));
        }
      }
      lobby.game.turn = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
    }

    broadcastGameUpdate(lobbyId);

    if (player && player.hand && player.hand.length === 0) {
      broadcastWin(lobbyId, player.name);
    }
  }
}


function handleDraw(lobbyId: string, playerId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby || !lobby.game.started) return;

  const playerIndex = lobby.players.findIndex(p => p.id === playerId);

  if (lobby.game.turn !== playerIndex) {
    return;
  }

  const player = lobby.players[playerIndex];

  // In drawing state, draw = accept penalty
  if (lobby.game.state === LobbyGameState.drawing) {
    const penalty = lobby.game.drawingCount;
    lobby.game.state = LobbyGameState.normal;
    lobby.game.drawingCount = 0;
    if (penalty > 0) {
      player.hand!.push(...drawCardsFromDeck(lobby, lobbyId, penalty));
    } else {
      player.hand!.push(...drawCardsFromDeck(lobby, lobbyId, 1));
    }
    lobby.game.turn = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
    broadcastGameUpdate(lobbyId);
    return;
  }

  if (player.hand!.length >= MAX_HAND_CARDS) {
    lobby.game.turn = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
    broadcastGameUpdate(lobbyId);
    return;
  }

  const drawn = drawCardsFromDeck(lobby, lobbyId, 1);
  if (drawn.length > 0) {
    player.hand!.push(drawn[0]);
  }
  lobby.game.turn = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
  broadcastGameUpdate(lobbyId);
}

function isValidMove(lobbyId: string, card: Card): boolean {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return false;

  if (lobby.game.discardPile.length === 0) return true;
  const topCard = lobby.game.discardPile[lobby.game.discardPile.length - 1];
  const isNCard = (t: string) => t === 'draw2' || t === 'wild4';
  return card.color === topCard.color || card.type === topCard.type
    || (isNCard(card.type) && isNCard(topCard.type))
    || card.type === 'wild' || card.type === 'wild4';
}

function checkAutoUno(_lobbyId: string, player: Player): boolean {
  if (player.hand && player.hand.length === 1) {
    player.uno = true;
    return true;
  }

  if (player.hand && player.hand.length > 1) {
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

function sanitizePlayersForClient(players: Player[]): object[] {
  return players.map(p => {
    const { hand, ...rest } = p;
    return { ...rest, cardCount: hand ? hand.length : 0 };
  });
}

function broadcastGameUpdate(lobbyId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;

  lobby.players.forEach(player => {
    if (player.hand) {
      checkAutoUno(lobbyId, player);
    }
  });

  [...clients.keys()].forEach((client) => {
    const metadata = clients.get(client);
    if (metadata && metadata.lobbyId === lobbyId) {
      const player = lobby.players.find(p => p.id === metadata.id);
      const message: Record<string, unknown> = {
        action: 'update',
        players: sanitizePlayersForClient(lobby.players),
        discardPile: lobby.game.discardPile,
        turn: lobby.game.turn,
        direction: lobby.game.direction,
        gameState: lobby.game.state,
        drawingCount: lobby.game.drawingCount,
        spectator: metadata.isSpectator || false,
        hand: player ? player.hand : []
      };

      client.send(JSON.stringify(message));
    }
  });

  scheduleAIMove(lobbyId);
}

function handleUno(lobbyId: string, playerId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;

  const player = lobby.players.find(p => p.id === playerId);
  if (player && player.hand && player.hand.length === 1) {
    player.uno = true;
    broadcastPlayers(lobbyId);
  }
}

function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
  const id = uuidv4();
  const metadata: ClientMetadata = { id };
  clients.set(ws, metadata);

  ws.send(JSON.stringify({ action: 'init', dev: isDev(), id }));
  serverLog(`client connected ${id}`);

  ws.on('message', (messageAsString: Buffer | string) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(messageAsString.toString());
    } catch (_e) {
      return;
    }

    const metadata = clients.get(ws)!;
    logState('msg', metadata, { action: message.action });
    if (metadata && metadata.lobbyId && message.action !== 'reconnect' && message.action !== 'join') {
      const state = validateState(metadata.id, metadata.name, metadata.lobbyId);
      if (state === 'disconnected') {
        serverLog(`state mismatch: player ${metadata.id?.slice(0, 8)} is ${state}, resetting lobbyId`);
        metadata.lobbyId = null;
      }
    }

    if (!(message.action || '').startsWith('dev_')) {
      switch (message.action) {
        case 'join': {
          metadata.name = message.name;
          if (typeof message.lobbyId !== 'string' || !message.lobbyId.length) {
            ws.send(JSON.stringify(errorResponse('NEED_LOBBY_NAME')));
            return;
          }
          let lobby = findOrCreateLobby(message.lobbyId);

          if (startedLobbies.has(lobby.id)) {
            const disconnectedPlayer = lobby.players.find(p => p.id === message.playerId && p.disconnected && p.name.toLowerCase() === (message.name || '').toLowerCase());
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
                direction: lobby.game.direction,
                hand: disconnectedPlayer.hand
              }));
              return;
            }
            ws.send(JSON.stringify({ action: 'spectate_offer', lobbyId: lobby.id }));
            return;
          }

          const existingPlayer = lobby.players.find(p => p.name.toLowerCase() === (message.name || '').toLowerCase());
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
            ws.send(JSON.stringify(errorResponse('NAME_DUPLICATE')));
            return;
          }

          metadata.lobbyId = message.lobbyId;

          const isCreator = lobby.players.length === 0;
          const player: Player = {
            id: metadata.id,
            name: metadata.name!,
            ready: false,
            isCreator: isCreator
          };
          lobby.players.push(player);
          sessions.set(metadata.id, { name: metadata.name!, lobbyId: metadata.lobbyId! });
          broadcastPlayers(metadata.lobbyId!);
          serverLog(`player jointed to ${lobby.id} :`, player);
          return;
        }

        case 'add_ai': {
          const lobby = findOrCreateLobby(metadata.lobbyId!);
          const creator = lobby.players.find(p => p.id === metadata.id);
          if (!creator || !creator.isCreator) {
            ws.send(JSON.stringify(errorResponse('CREATOR_ONLY')));
            return;
          }
          if (startedLobbies.has(lobby.id)) {
            ws.send(JSON.stringify(errorResponse('GAME_ALREADY_STARTED')));
            return;
          }
          const aiId = uuidv4();
          const aiName = generateAIName(lobby);
          const aiPlayer: Player = {
            id: aiId,
            name: aiName,
            ready: true,
            isCreator: false,
            isAI: true
          };
          lobby.players.push(aiPlayer);
          broadcastPlayers(metadata.lobbyId!);
          return;
        }

        case 'ai_ready': {
          const lobby = findOrCreateLobby(metadata.lobbyId!);
          const creator = lobby.players.find(p => p.id === metadata.id);
          if (!creator || !creator.isCreator) {
            ws.send(JSON.stringify(errorResponse('CREATOR_ONLY_AI_READY')));
            return;
          }
          const aiPlayer = lobby.players.find(p => p.id === message.playerId && p.isAI);
          if (!aiPlayer) {
            ws.send(JSON.stringify(errorResponse('AI_NOT_FOUND')));
            return;
          }
          aiPlayer.ready = !aiPlayer.ready;
          broadcastPlayers(metadata.lobbyId!);
          checkStartGame(metadata.lobbyId!);
          return;
        }

        case 'remove_ai': {
          const lobby = findOrCreateLobby(metadata.lobbyId!);
          const creator = lobby.players.find(p => p.id === metadata.id);
          if (!creator || !creator.isCreator) {
            ws.send(JSON.stringify(errorResponse('CREATOR_ONLY_KICK_AI')));
            return;
          }
          if (startedLobbies.has(lobby.id)) {
            ws.send(JSON.stringify(errorResponse('GAME_ALREADY_STARTED')));
            return;
          }
          const aiIndex = lobby.players.findIndex(p => p.id === message.playerId && p.isAI);
          if (aiIndex === -1) {
            ws.send(JSON.stringify(errorResponse('AI_NOT_FOUND')));
            return;
          }
          clearAITimeout(lobby.players[aiIndex].id);
          lobby.players.splice(aiIndex, 1);
          broadcastPlayers(metadata.lobbyId!);
          return;
        }

        case 'transfer_creator': {
          const lobby = findOrCreateLobby(metadata.lobbyId!);
          const from = lobby.players.find(p => p.id === metadata.id);
          if (!from || !from.isCreator) {
            ws.send(JSON.stringify(errorResponse('CREATOR_ONLY_TRANSFER')));
            return;
          }
          const to = lobby.players.find(p => p.id === message.playerId);
          if (!to || to.isAI || to.disconnected) {
            ws.send(JSON.stringify(errorResponse('TARGET_INVALID')));
            return;
          }
          from.isCreator = false;
          to.isCreator = true;
          broadcastPlayers(metadata.lobbyId!);
          return;
        }

        case 'ready': {
          const lobby = lobbies.get(metadata.lobbyId!);
          if (!lobby) {
            ws.send(JSON.stringify(errorResponse('NOT_IN_LOBBY')));
            return;
          }
          let player = lobby.players.find(p => p.id === metadata.id);
          if (!player) {
            player = { id: metadata.id, name: metadata.name || 'Player', ready: false, isCreator: lobby.players.length === 0 };
            lobby.players.push(player);
          }
          const oldReady = player.ready;
          player.ready = !player.ready;
          serverLog(`ready TOGGLE player=${player.name} ${oldReady}>>${player.ready} lobbyId=${metadata.lobbyId?.slice(0, 8)} playerId=${metadata.id?.slice(0, 8)}`);
          logState('ready', metadata, { player: player.name, ready: player.ready, allPlayers: lobby.players.map(p => ({ name: p.name, ready: p.ready, disconnected: p.disconnected })) });
          sessions.set(player.id, { ...sessions.get(player.id)!, pendingReady: player.ready });
          broadcastPlayers(metadata.lobbyId!);
          checkStartGame(metadata.lobbyId!);
          return;
        }

        case 'reconnect': {
          const session = sessions.get(message.playerId!);
          logState('reconnect', metadata, { session: !!session, playerId: message.playerId?.slice(0, 8) });
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
            const newId = uuidv4();
            metadata.id = newId;
            serverLog(`reconnect lobby dead, new session newId=${newId.slice(0, 8)}`);
            ws.send(JSON.stringify({ action: 'init', id: newId, dev: isDev(), reconnectLost: true }));
            return;
          }
          const existingPlayer = rLobby!.players.find(p => p.id === message.playerId);
          serverLog(`reconnect existingPlayer=${!!existingPlayer} disconnected=${existingPlayer?.disconnected} ready=${existingPlayer?.ready}`);
          if (!existingPlayer) {
            const newId = uuidv4();
            metadata.id = newId;
            ws.send(JSON.stringify({ action: 'init', id: newId, dev: isDev(), reconnectLost: true }));
            return;
          }
          metadata.name = session.name;
          metadata.lobbyId = session.lobbyId;
          metadata.id = message.playerId!;
          ws.send(JSON.stringify({ action: 'init', id: message.playerId, dev: isDev() }));
          const oldTimer = disconnectTimers.get(existingPlayer.id);
          if (oldTimer) clearTimeout(oldTimer);
          disconnectTimers.delete(existingPlayer.id);
          const retryTimer = reconnectTimers.get(existingPlayer.id);
          if (retryTimer) clearTimeout(retryTimer);
          reconnectTimers.delete(existingPlayer.id);
          existingPlayer.reconnectDeadline = null;
          existingPlayer.disconnected = false;
          const deferKey = existingPlayer.id;
          const deferTimer = deferTimers.get(deferKey);
          if (deferTimer) { clearTimeout(deferTimer); deferTimers.delete(deferKey); }
          const pending = sessions.get(existingPlayer.id);
          if (pending && pending.pendingReady !== undefined) {
            existingPlayer.ready = pending.pendingReady;
            serverLog(`reconnect restored ready=${existingPlayer.ready} for ${existingPlayer.name}`);
          } else {
            serverLog(`reconnect NO pendingReady for ${existingPlayer.name}, current ready=${existingPlayer.ready}`);
          }
          for (const [existingWs, existingMeta] of clients) {
            if (existingMeta.id === message.playerId && existingWs !== ws) {
              existingMeta.lobbyId = null;
            }
          }
          broadcastPlayers(session.lobbyId);
          if (rLobby!.game.started) {
            broadcastGameUpdate(session.lobbyId);
            const player = existingPlayer || rLobby!.players[0];
            if (player && player.hand) {
              ws.send(JSON.stringify({
                action: 'start',
                id: message.playerId,
                players: sanitizePlayersForClient(rLobby!.players),
                discardPile: rLobby!.game.discardPile,
                turn: rLobby!.game.turn,
                direction: rLobby!.game.direction,
                gameState: rLobby!.game.state,
                drawingCount: rLobby!.game.drawingCount,
                hand: player.hand
              }));
            }
          } else {
            ws.send(JSON.stringify({
              action: 'players',
              players: rLobby!.players,
              turn: rLobby!.game.turn,
              lobbyId: session.lobbyId
            }));
          }
          return;
        }

        case 'play':
          if (!lobbies.has(metadata.lobbyId || '')) {
            ws.send(JSON.stringify(errorResponse('LOBBY_NOT_FOUND'))); return;
          }
          handlePlay(metadata.lobbyId!, metadata.id, message.card!);
          return;

        case 'draw':
          if (!lobbies.has(metadata.lobbyId || '')) {
            ws.send(JSON.stringify(errorResponse('LOBBY_NOT_FOUND'))); return;
          }
          handleDraw(metadata.lobbyId!, metadata.id);
          return;

        case 'uno':
          if (!lobbies.has(metadata.lobbyId || '')) {
            ws.send(JSON.stringify(errorResponse('LOBBY_NOT_FOUND'))); return;
          }
          handleUno(metadata.lobbyId!, metadata.id);
          return;

        case 'play_multiple':
          if (!lobbies.has(metadata.lobbyId || '')) {
            ws.send(JSON.stringify(errorResponse('LOBBY_NOT_FOUND'))); return;
          }
          handlePlayMultiple(metadata.lobbyId!, metadata.id, message.cards!);
          return;

        case 'leave':
          if (!lobbies.has(metadata.lobbyId || '')) {
            ws.send(JSON.stringify(errorResponse('LOBBY_NOT_FOUND'))); return;
          }
          handleLeave(metadata.lobbyId!, metadata.id);
          sessions.delete(metadata.id);
          metadata.lobbyId = null;
          return;

        case 'surrender': {
          const sLobby = lobbies.get(metadata.lobbyId || '');
          if (!sLobby || !sLobby.game.started) return;
          const surrenderPlayer = sLobby.players.find(p => p.id === metadata.id);
          if (!surrenderPlayer) return;

          const remaining = sLobby.players.filter(p => p.id !== metadata.id);
          // 2-player room: surrender = opponent wins (original behavior)
          if (remaining.length <= 1) {
            const winner = remaining.find(p => !p.isAI) || remaining[0];
            if (winner) broadcastWin(metadata.lobbyId!, winner.name);
            return;
          }

          // >2 players: offer spectate, only remove if declined
          ws.send(JSON.stringify({ action: 'surrender_offer' }));
          return;
        }

        case 'spectate_accept': {
          const lobby = lobbies.get(metadata.lobbyId!);
          if (!lobby || !lobby.game.started) return;
          const player = lobby.players.find(p => p.id === metadata.id);
          if (!player) return;
          if (player.hand) lobby.game.discardPile.push(...player.hand);
          const idx = lobby.players.indexOf(player);
          if (idx === lobby.game.turn) {
            lobby.game.turn = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
          }
          lobby.players.splice(idx, 1);
          if (idx < lobby.game.turn && lobby.players.length > 0) {
            lobby.game.turn = (lobby.game.turn - 1 + lobby.players.length) % lobby.players.length;
          }
          sessions.delete(metadata.id);
          metadata.isSpectator = true;
          ws.send(JSON.stringify({
            action: 'start',
            id: metadata.id,
            players: sanitizePlayersForClient(lobby.players),
            discardPile: lobby.game.discardPile,
            turn: lobby.game.turn,
            direction: lobby.game.direction,
            hand: [],
            spectator: true
          }));
          checkGameAborted(metadata.lobbyId!, metadata.id);
          broadcastGameUpdate(metadata.lobbyId!);
          return;
        }

        case 'spectate': {
          const lobby = lobbies.get(message.lobbyId!);
          if (!lobby || !lobby.game.started) {
            ws.send(JSON.stringify(errorResponse('GAME_NOT_STARTED')));
            return;
          }
          metadata.name = message.name;
          metadata.lobbyId = message.lobbyId;
          metadata.isSpectator = true;
          ws.send(JSON.stringify({
            action: 'start',
            id: metadata.id,
            players: sanitizePlayersForClient(lobby.players),
            discardPile: lobby.game.discardPile,
            turn: lobby.game.turn,
            direction: lobby.game.direction,
            hand: [],
            spectator: true
          }));
          return;
        }

        case 'reaction':
          const lobby = lobbies.get(metadata.lobbyId!);
          if (!lobby || !lobby.game.started) break;
          if (message.type === 'emoji') {
            broadcastToLobby(metadata.lobbyId!, {
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
            broadcastToLobby(metadata.lobbyId!, {
              action: 'reaction',
              playerId: metadata.id,
              type: 'text',
              content: message.content
            });
          }
          break;

        default:
          serverWarn('unhandled event', message);
          return;
      }
    } else {
      if (!isDev()) {
        serverWarn('cannot handle dev event', message);
        return;
      }

      switch (message.action) {
        case 'dev_call_win':
          const lobby1 = findOrCreateLobby(metadata.lobbyId!);
          const player1 = lobby1.players.find(p => p.id === metadata.id);
          if (!player1) {
            ws.send(JSON.stringify(errorResponse('PLAYER_NOT_FOUND')));
            return;
          }
          broadcastWin(metadata.lobbyId!, player1.name);
          return;
        case 'dev_add_cards': {
          const lobby2 = findOrCreateLobby(metadata.lobbyId!);
          if (!lobby2.game.started) { ws.send(JSON.stringify(errorResponse('GAME_NOT_STARTED'))); return; }
          const player2 = lobby2.players.find(p => p.id === metadata.id);
          if (!player2) { ws.send(JSON.stringify(errorResponse('PLAYER_NOT_FOUND'))); return; }
          const count = Math.min(message.count || 1, 20);
          let drawn = lobby2.game.deck.splice(0, count);
          if (drawn.length < count && lobby2.game.discardPile.length >= 2) {
            const topCard = lobby2.game.discardPile.pop()!;
            lobby2.game.deck = lobby2.game.discardPile;
            lobby2.game.discardPile = [topCard];
            shuffleDeck(metadata.lobbyId!);
            const more = lobby2.game.deck.splice(0, count - drawn.length);
            drawn = [...drawn, ...more];
          }
          player2.hand!.push(...drawn);
          broadcastGameUpdate(metadata.lobbyId!);
          return;
        }
        case 'dev_add_all_cards': {
          const lobby2 = findOrCreateLobby(metadata.lobbyId!);
          if (!lobby2.game.started) { ws.send(JSON.stringify(errorResponse('GAME_NOT_STARTED'))); return; }
          const player2 = lobby2.players.find(p => p.id === metadata.id);
          if (!player2) { ws.send(JSON.stringify(errorResponse('PLAYER_NOT_FOUND'))); return; }
          let drawn = lobby2.game.deck.splice(0, lobby2.game.deck.length);
          if (drawn.length === 0 && lobby2.game.discardPile.length >= 2) {
            const topCard = lobby2.game.discardPile.pop()!;
            lobby2.game.deck = lobby2.game.discardPile;
            lobby2.game.discardPile = [topCard];
            shuffleDeck(metadata.lobbyId!);
            drawn = lobby2.game.deck.splice(0, lobby2.game.deck.length);
          }
          player2.hand!.push(...drawn);
          broadcastGameUpdate(metadata.lobbyId!);
          return;
        }
        case 'dev_remove_cards': {
          const lobby3 = findOrCreateLobby(metadata.lobbyId!);
          if (!lobby3.game.started) { ws.send(JSON.stringify(errorResponse('GAME_NOT_STARTED'))); return; }
          const player3 = lobby3.players.find(p => p.id === metadata.id);
          if (!player3) { ws.send(JSON.stringify(errorResponse('PLAYER_NOT_FOUND'))); return; }
          const removeCount = Math.min(message.count || 1, player3.hand!.length);
          player3.hand!.splice(0, removeCount);
          if (player3.hand!.length === 0) {
            broadcastWin(metadata.lobbyId!, player3.name);
          } else {
            broadcastGameUpdate(metadata.lobbyId!);
          }
          return;
        }
        case 'dev_skip': {
          const lobby4 = findOrCreateLobby(metadata.lobbyId!);
          if (!lobby4.game.started) { ws.send(JSON.stringify(errorResponse('GAME_NOT_STARTED'))); return; }
          lobby4.game.turn = (lobby4.game.turn + lobby4.game.direction + lobby4.players.length) % lobby4.players.length;
          broadcastGameUpdate(metadata.lobbyId!);
          return;
        }
        case 'dev_export_state': {
          logState('export', metadata);
          ws.send(JSON.stringify({ action: 'dev_state_export', log: stateLog }));
          return;
        }
        default:
          serverWarn('unhandled dev event', message);
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

function scheduleProcessClose(playerId: string, ws: WebSocket, metadata: ClientMetadata): void {
  const deferKey = playerId || (metadata && metadata.lobbyId!);
  if (!deferKey) return processClose(ws, metadata);
  const existing = deferTimers.get(deferKey);
  if (existing) clearTimeout(existing);
  const deferTimer = setTimeout(() => {
    deferTimers.delete(deferKey);
    processClose(ws, metadata);
  }, RECONNECT_DEFER_MS);
  deferTimers.set(deferKey, deferTimer);
}

function processClose(_ws: WebSocket, metadata: ClientMetadata): void {
  const lobby = lobbies.get(metadata.lobbyId!);
  if (!lobby) return;
  const player = lobby.players.find(p => p.id === metadata.id);
  if (!player) return;
  player.disconnected = true;
  player.reconnectDeadline = Date.now() + RECONNECT_DEADLINE_MS;
  broadcastPlayers(metadata.lobbyId!);
  if (lobby.game.started) {
    broadcastGameUpdate(metadata.lobbyId!);
  }
  const reconnectTimer = setTimeout(() => {
    reconnectTimers.delete(player.id);
    if (!player.disconnected) return;
    if (lobby.game.started &&
      lobby.game.turn === lobby.players.indexOf(player)) {
      lobby.game.turn = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
      broadcastGameUpdate(metadata.lobbyId!);
    }
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
      checkGameAborted(metadata.lobbyId!, metadata.id);
      broadcastPlayers(metadata.lobbyId!);
      if (lobby.players.length === 0) lobbies.delete(metadata.lobbyId!);
    }
  }, RECONNECT_DEADLINE_MS);
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
      checkGameAborted(metadata.lobbyId!, metadata.id);
      broadcastPlayers(metadata.lobbyId!);
      if (lobby.game.started) {
        broadcastGameUpdate(metadata.lobbyId!);
      }
      if (lobby.players.length === 0) lobbies.delete(metadata.lobbyId!);
    }
  }, DISCONNECT_REMOVE_MS);
  disconnectTimers.set(player.id, timer);
}

function handleLeave(lobbyId: string, playerId: string): void {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;

  const playerIndex = lobby.players.findIndex(p => p.id === playerId);
  if (playerIndex > -1) {
    const player = lobby.players[playerIndex];
    // If game started, put hand cards on discard pile
    if (lobby.game.started && player.hand) {
      lobby.game.discardPile.push(...player.hand);
    }
    // If it was this player's turn, advance
    if (playerIndex === lobby.game.turn) {
      lobby.game.turn = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length;
    }
    lobby.players.splice(playerIndex, 1);
    // Adjust turn if removed before current
    if (playerIndex < lobby.game.turn && lobby.players.length > 0) {
      lobby.game.turn = (lobby.game.turn - 1 + lobby.players.length) % lobby.players.length;
    }

    if (player.isCreator) {
      const removedAIs = lobby.players.filter(p => p.isAI);
      lobby.players = lobby.players.filter(p => !p.isAI);
      for (const ai of removedAIs) clearAITimeout(ai.id);
      if (lobby.players.length > 0) {
        lobby.players[0].isCreator = true;
      }
    }

    checkGameAborted(lobbyId, playerId);

    broadcastToLobby(lobbyId, {
      action: 'players',
      players: lobby.players,
      turn: lobby.game.turn,
      lobbyId: lobbyId
    }, playerId);

    checkStartGame(lobbyId);
    serverLog(`player leaved from ${lobby.id} :`, player);

    if (lobby.players.length === 0) {
      lobbies.delete(lobbyId);
    }
  }
}

function hasFlagExitImmediately(): boolean {
  return process.argv.includes('--exit-immediately') || process.argv.includes('-e');
}

function isDev(): boolean {
  return process.env.NODE_ENV === 'development';
}

process.on('SIGINT', () => {
  process.stdout.write('\nServer closed');
  if (!!process.stdin && !hasFlagExitImmediately() && !isDev()) {
    console.log(', press any key to close this window...');
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', () => process.exit(0));
    } catch (e) {
      console.warn('cannot wait for any key');
      console.error(e);
      process.exit(0);
    }
  } else {
    console.log();
    process.exit(0);
  }
});

httpServer.on('listening', () => console.log('Server started on port 3000'));
httpServer.on('error', (e: Error) => { console.error(e); process.emit('SIGINT'); });
httpServer.listen(3000);
