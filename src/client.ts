const nameInput = document.getElementById('name') as HTMLInputElement;
const lobbyIdInput = document.getElementById('lobby-id') as HTMLInputElement;
const joinButton = document.getElementById('join') as HTMLButtonElement;
const playersList = document.getElementById('players') as HTMLUListElement;
const readyButton = document.getElementById('ready') as HTMLButtonElement;
const lobbyDiv = document.getElementById('lobby') as HTMLDivElement;
const gameDiv = document.getElementById('game') as HTMLDivElement;
const opponentHandsDiv = document.getElementById('opponent-hands') as HTMLDivElement;
const playerHandDiv = document.getElementById('player-hand') as HTMLDivElement;
const discardPileDiv = document.getElementById('discard-pile') as HTMLDivElement;
const drawCardButton = document.getElementById('draw-card') as HTMLButtonElement;
const turnIndicator = document.getElementById('turn-indicator') as HTMLDivElement;
const turnText = document.getElementById('turn-text') as HTMLHeadingElement;
const wildColorPicker = document.getElementById('wild-color-picker') as HTMLDivElement;
const colorOptions = document.getElementById('color-options') as HTMLDivElement;
const lobbyInfo = document.getElementById('lobby-info') as HTMLDivElement;
const currentLobbyId = document.getElementById('current-lobby-id') as HTMLSpanElement;
const inviteAIBtn = document.getElementById('invite-ai') as HTMLButtonElement;
const reactionTextInput = document.getElementById('reaction-text-input') as HTMLInputElement;
const reactionSendBtn = document.getElementById('reaction-send-btn') as HTMLButtonElement;
const reactionEmojis = document.getElementById('reaction-emojis') as HTMLDivElement;
const cardLayoutToggle = document.getElementById('card-layout-toggle') as HTMLButtonElement;

let storageCleared = false

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
  cardCount?: number;
  uno?: boolean;
}

interface SavedSelection {
  card: Card;
  index: number;
}

interface ServerMessage {
  action: string;
  id?: string;
  dev?: boolean;
  reconnectLost?: boolean;
  players?: Player[];
  turn?: number;
  direction?: number;
  lobbyId?: string;
  hand?: Card[];
  discardPile?: Card[];
  winner?: string;
  message?: string;
  errorKey?: string;
  spectator?: boolean;
  gameState?: number;
  drawingCount?: number;
  drawMode?: string;
  playerId?: string;
  type?: string;
  content?: string;
  log?: object[];
}

let NAME_LENGTH_MIN = 2;
let NAME_LENGTH_MAX = 32;
const CH_NAME = 'uno-game';
let tabSlot = 0;
// Stable per-tab identifier used to resolve same-slot conflicts deterministically.
const TAB_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);

function slotKey(k: string): string { return `${k}-${tabSlot || 1}`; }

// Resolves once this tab knows its slot. Code that loads UI state from
// `store` must await this; otherwise it falls back to the legacy plain
// localStorage key, which is shared across tabs and gets overwritten by
// whichever tab wrote last (so all tabs would read the same value).
let resolveSlotReady: () => void = () => {};
const slotReady: Promise<void> = new Promise(r => { resolveSlotReady = r; });

// Writes that arrived before the slot was assigned. Replayed once the slot
// is known so they land in the slot-scoped localStorage key (and survive
// the tab being closed).
const pendingWrites = new Map<string, string | null>();

const store = {
  get(k: string): string | null {
    return sessionStorage.getItem(k)
      ?? (tabSlot ? localStorage.getItem(slotKey(k)) : null)
      // Legacy fallback for users upgrading from a pre-slot build. Only ever
      // read, never written, so concurrent tabs cannot stomp on each other.
      ?? localStorage.getItem(k);
  },
  set(k: string, v: string): void {
    sessionStorage.setItem(k, v);
    if (tabSlot) localStorage.setItem(slotKey(k), v);
    else pendingWrites.set(k, v);
  },
  remove(k: string): void {
    if (tabSlot) localStorage.removeItem(slotKey(k));
    else pendingWrites.set(k, null);
    localStorage.removeItem(k);
    sessionStorage.removeItem(k);
  },
};

// ── BroadcastChannel slot negotiation ────────────────────
// Distributed (no central host): every tab heartbeats its own slot and listens
// for peers. A tab picks the smallest unclaimed positive integer based on what
// it has heard. Closing any tab — including whichever tab opened first — never
// strands the rest, because no single host owns the allocation table.
// Same-slot collisions (e.g. after a stale entry was reused, or two new tabs
// racing) are resolved by letting the tab with the larger TAB_ID drop and
// re-elect.
const ch = new BroadcastChannel(CH_NAME);
const HEARTBEAT_MS = 1500;
const STALE_MS = 4000;
const ELECTION_MS = 250;
interface SlotInfo { tabId: string; lastSeen: number }
const knownSlots = new Map<number, SlotInfo>();
let electionTimer: ReturnType<typeof setTimeout> | null = null;

function pruneStaleSlots(): void {
  const now = Date.now();
  for (const [s, info] of knownSlots) {
    if (info.tabId === TAB_ID) continue;
    if (now - info.lastSeen > STALE_MS) knownSlots.delete(s);
  }
}

function pickFreeSlot(): number {
  pruneStaleSlots();
  let s = 1;
  while (knownSlots.has(s)) s++;
  return s;
}

function claimSlot(slot: number): void {
  tabSlot = slot;
  sessionStorage.setItem('unoSlot', String(slot));
  knownSlots.set(slot, { tabId: TAB_ID, lastSeen: Date.now() });
  ch.postMessage({ type: 'heartbeat', slot, tabId: TAB_ID });
  // Flush any writes that happened during the election window.
  for (const [k, v] of pendingWrites) {
    if (v === null) localStorage.removeItem(slotKey(k));
    else localStorage.setItem(slotKey(k), v);
  }
  pendingWrites.clear();
  resolveSlotReady();
}

function runElection(): void {
  if (electionTimer !== null) return;
  ch.postMessage({ type: 'who', tabId: TAB_ID });
  electionTimer = setTimeout(() => {
    electionTimer = null;
    if (tabSlot !== 0) return; // already claimed during the wait window
    claimSlot(pickFreeSlot());
  }, ELECTION_MS);
}

ch.onmessage = (e: MessageEvent) => {
  const d = e.data;
  if (!d || typeof d !== 'object') return;
  if (d.type === 'heartbeat' && typeof d.slot === 'number' && typeof d.tabId === 'string') {
    knownSlots.set(d.slot, { tabId: d.tabId, lastSeen: Date.now() });
    // Same-slot collision: keep the tab with the lexicographically smaller id.
    if (d.slot === tabSlot && d.tabId !== TAB_ID && d.tabId < TAB_ID) {
      tabSlot = 0;
      sessionStorage.removeItem('unoSlot');
      runElection();
    }
  } else if (d.type === 'who') {
    if (tabSlot) ch.postMessage({ type: 'heartbeat', slot: tabSlot, tabId: TAB_ID });
  } else if (d.type === 'bye' && typeof d.slot === 'number' && typeof d.tabId === 'string') {
    const cur = knownSlots.get(d.slot);
    if (cur && cur.tabId === d.tabId) knownSlots.delete(d.slot);
  }
};

ch.onmessageerror = () => { /* ignore */ };

// Boot: reuse the slot remembered for this tab (survives F5), else negotiate.
(() => {
  const stored = Number(sessionStorage.getItem('unoSlot'));
  if (Number.isFinite(stored) && stored > 0) {
    claimSlot(stored);
    // Probe so that, if another tab grabbed our slot while we were reloading,
    // the same-slot conflict resolution kicks in promptly.
    ch.postMessage({ type: 'who', tabId: TAB_ID });
  } else {
    runElection();
  }
})();

setInterval(() => {
  pruneStaleSlots();
  if (tabSlot) ch.postMessage({ type: 'heartbeat', slot: tabSlot, tabId: TAB_ID });
}, HEARTBEAT_MS);

window.addEventListener('beforeunload', () => {
  if (tabSlot) ch.postMessage({ type: 'bye', slot: tabSlot, tabId: TAB_ID });
  ch.close();
});
const CLIENT_PREFIX = '[client]';
function clientLog(msg: string, ...args: unknown[]): void {
  console.log(`${CLIENT_PREFIX} ${msg}`, ...args);
}
function clientWarn(msg: string, ...args: unknown[]): void {
  console.warn(`${CLIENT_PREFIX} ${msg}`, ...args);
}

// ── Error definitions (fetched from /errors) ─────────────
interface ErrorDef {
  message: string;
  needRefresh: boolean;
}
let errorDefs: Record<string, ErrorDef> | null = null;

async function loadErrorDefs(): Promise<void> {
  if (errorDefs) return;
  try {
    const resp = await fetch('/errors');
    if (resp.ok) {
      errorDefs = await resp.json();
      clientLog('loaded error definitions');
    }
  } catch (_e) {
    clientWarn('failed to load error definitions');
  }
}

function getErrorDef(key: string): ErrorDef | undefined {
  return errorDefs ? errorDefs[key] : undefined;
}

let myId: string | null = null;
let ws: WebSocket | null = null;
let currentTurn = -1;
let gameDirection = 1;
let players: Player[] = [];
let pendingWildCard: Card | Card[] | null = null;
let selectedCards: SavedSelection[] = [];
let isSelectingMultiple = false;
let myHand: Card[] = [];
let myLobbyId: string | null = null;
let isSpectating = false;
let gameState = 0;
let drawingChain = 0;

function getLeaveSpectateBtn(): HTMLButtonElement | null {
  return document.getElementById('leave-spectate-btn') as HTMLButtonElement | null;
}

// Add these elements to the existing DOM references
const joinFormContainer = document.createElement('div');
joinFormContainer.id = 'join-form-container';

let isDisconnected = false;
let disconnectToastTimeout: ReturnType<typeof setTimeout> | null = null;
let countdownInterval: ReturnType<typeof setInterval> | null = null;
let actionQueue: object[] = [];
let refreshErrorCount = 0;
let refreshErrorTime = 0;
let justReconnected = false;

function encodeUGC(content: string): string {
  const tempEl = document.createElement('div');
  tempEl.textContent = content;
  return tempEl.innerHTML;
}

// Modal dialog helpers — replaces native alert/confirm
const modalOverlay = document.getElementById('modal-overlay') as HTMLDivElement;
const modalMessage = document.getElementById('modal-message') as HTMLParagraphElement;
const modalOkBtn = document.getElementById('modal-ok-btn') as HTMLButtonElement;
const modalCancelBtn = document.getElementById('modal-cancel-btn') as HTMLButtonElement;

function showAlert(msg: string): Promise<void> {
  return new Promise(resolve => {
    modalCancelBtn.style.display = 'none';
    modalMessage.textContent = msg;
    modalOkBtn.textContent = '确定';
    modalOverlay.classList.remove('hidden');
    modalOverlay.style.display = 'flex';

    function cleanup() {
      modalOverlay.classList.add('hidden');
      modalOverlay.style.display = '';
      modalOkBtn.removeEventListener('click', onOk);
      resolve();
    }
    function onOk() { cleanup(); }
    modalOkBtn.addEventListener('click', onOk);
  });
}

function showConfirm(msg: string): Promise<boolean> {
  return new Promise(resolve => {
    modalCancelBtn.style.display = '';
    modalMessage.textContent = msg;
    modalOkBtn.textContent = '确定';
    modalOverlay.classList.remove('hidden');
    modalOverlay.style.display = 'flex';

    function cleanup(result: boolean) {
      modalOverlay.classList.add('hidden');
      modalOverlay.style.display = '';
      modalOkBtn.removeEventListener('click', onOk);
      modalCancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    modalOkBtn.addEventListener('click', onOk);
    modalCancelBtn.addEventListener('click', onCancel);
  });
}

let connecting = false;
let currentWs: WebSocket | null = null;
function connect(): void {
  if (connecting && ws && ws.readyState !== WebSocket.CLOSED) return;
  connecting = true;
  joinButton.disabled = true;
  const wsUrl = new URL('/ws', location.href);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const newWs = new WebSocket(wsUrl.toString());
  currentWs = newWs;
  ws = newWs;

  newWs.onopen = () => {
    if (newWs !== currentWs) return;
    connecting = false;
    clientLog('Connected to server');
    isDisconnected = false;
    joinButton.disabled = false;
    lobbyIdInput.disabled = false;
    nameInput.disabled = false;
    loadErrorDefs();
    // Sync constants from server
    fetch('/constants').then(r => r.json()).then(c => {
      if (c.NAME_LENGTH_MIN) NAME_LENGTH_MIN = c.NAME_LENGTH_MIN;
      if (c.NAME_LENGTH_MAX) NAME_LENGTH_MAX = c.NAME_LENGTH_MAX;
    }).catch(() => {});
    const btn = document.getElementById('dev-disconnect-btn');
    if (btn) btn.textContent = '断开';
    // Wait for the slot to be assigned before reading per-tab state, otherwise
    // store.get falls back to the legacy plain localStorage key (shared across
    // tabs) and every tab would see the value written by whichever tab wrote
    // last.
    slotReady.then(() => {
      if (newWs !== currentWs) return;
      const savedId = store.get('unoPlayerId');
      clientLog(`onopen savedId=${savedId ? savedId.slice(0, 8) : null} actionQueue=${actionQueue.length}`);
      // Always pre-fill name/lobby from storage
      nameInput.value = store.get('unoPlayerName') || '';
      lobbyIdInput.value = store.get('unoLobbyId') || '';
      if (savedId) {
        justReconnected = true;
        sendMessage({ action: 'reconnect', playerId: savedId });
      } else if (!store.get('unoLeftLobby')) {
        const savedName = store.get('unoPlayerName');
        const savedLobbyId = '';
        if (savedName && savedLobbyId) {
          const msg: Record<string, string> = { action: 'join', name: savedName, lobbyId: savedLobbyId };
          if (savedId) msg.playerId = savedId;
          clientLog(`onopen fallback join name=${savedName}`);
          sendMessage(msg);
        }
        hideDisconnectedToast();
      } else {
        store.remove('unoLeftLobby');
        hideDisconnectedToast();
      }
    });
  };

  newWs.onmessage = async (event: MessageEvent) => {
    const message: ServerMessage = JSON.parse(event.data);

    switch (message.action) {
      case 'init':
        myId = message.id!;
        clientLog('[init] myId =', myId);
        if (message.reconnectLost) {
          clientLog('[init] reconnect lost, showing join form');
          store.remove('unoPlayerId');
          store.remove('unoInLobby');
          store.remove('unoInGame');
          store.set('unoLeftLobby', 'true');
          myLobbyId = null;
          resetGameState();
        } else if (!store.get('unoPlayerId')) {
          store.set('unoPlayerId', myId);
        }
        if (message.dev) setupDevPanel();
        hideDisconnectedToast();
        return;

      case 'error': {
        const key = message.errorKey;
        const def = key ? getErrorDef(key) : undefined;
        const msg = def ? def.message : (message.message || '未知错误');
        const needRefresh = def ? def.needRefresh : (!!message.message && message.message.includes('刷新页面'));
        if (needRefresh) {
          const now = Date.now();
          if (now - refreshErrorTime > 10000) refreshErrorCount = 0;
          refreshErrorTime = now;
          refreshErrorCount++;
          if (refreshErrorCount >= 3) {
            const reset = await showConfirm('多次重连失败，是否重置连接状态？（重置不会清除玩家名称和大厅 ID）');
            if (reset) {
              store.remove('unoInLobby');
              store.remove('unoInGame');
              store.remove('unoPlayerId');
            }
            refreshErrorCount = 0;
            nameInput.disabled = false;
            lobbyIdInput.disabled = false;
            joinButton.disabled = false;
            return;
          }
        }
        showAlert(msg).then(() => {
          if (needRefresh) {
            store.remove('unoInLobby');
            store.remove('unoInGame');
            store.remove('unoPlayerId');
          }
          nameInput.disabled = false;
          lobbyIdInput.disabled = false;
          joinButton.disabled = false;
        });
        return;
      }

      case 'players':
        clientLog(`players received, flushing actionQueue (was ${actionQueue.length})`);
        hideDisconnectedToast();
        players = message.players || [];
        currentTurn = message.turn || 0;
        gameDirection = message.direction || 1;
        gameState = message.gameState || 0;
        drawingChain = message.drawingCount || 0;
        myLobbyId = message.lobbyId || null;
        store.set('unoPlayerId', myId!);
        store.set('unoInLobby', '1');
        flushQueue();
        clientLog('[players] myId =', myId, 'players =', players.map(p => ({ id: p.id, name: p.name })));
        updatePlayers(players, currentTurn);
        updateTurnIndicator();
        showLobbyInfo(message.lobbyId || '');
        // Sync draw mode toggle
        if (message.drawMode) {
          const mode = message.drawMode;
          document.querySelectorAll('#draw-mode-toggle-box .mode-option').forEach(el => {
            el.classList.toggle('active', el.getAttribute('data-mode') === mode);
          });
        }
        break;

      case 'start':
        clientLog(`start received, flushing actionQueue (was ${actionQueue.length})`);
        hideDisconnectedToast();
        flushQueue();
        myId = message.id!;
        store.set('unoPlayerId', myId);
        isSpectating = message.spectator || false;
        clientLog('[start] myId =', myId, 'players =', (message.players || []).map(p => ({ id: p.id, name: p.name })), 'turn =', message.turn);
        lobbyDiv.style.display = 'none';
        gameDiv.style.display = 'block';
        document.getElementById('about-clear-btn')!.style.display = 'none';
        document.getElementById('about-storage-title')!.style.display = 'none';
        players = message.players || [];
        currentTurn = message.turn || 0;
        gameDirection = message.direction || 1;
        gameState = message.gameState || 0;
        drawingChain = message.drawingCount || 0;
        myHand = message.hand || [];
        updatePlayers(players, currentTurn);
        updateDiscardPile(message.discardPile || []);
        updateHand(myHand);
        applyCardLayout();
        updateTurnIndicator();
        const _btn0 = getLeaveSpectateBtn(); if (_btn0) _btn0.style.display = isSpectating ? '' : 'none';
        document.body.classList.toggle('spectator', isSpectating);
        break;

      case 'update':
        clientLog(`update received, flushing actionQueue (was ${actionQueue.length})`);
        hideDisconnectedToast();
        flushQueue();
        if (message.spectator !== undefined) {
          isSpectating = message.spectator;
          const _btn = getLeaveSpectateBtn(); if (_btn) _btn.style.display = isSpectating ? '' : 'none';
          document.body.classList.toggle('spectator', isSpectating);
        }
        clientLog('[update] myId =', myId, 'turn =', message.turn, 'players =', (message.players || []).map(p => ({ id: p.id, name: p.name })), 'current =', (message.players || [])[message.turn || 0] ? (message.players || [])[message.turn || 0].id : null);
        players = message.players || [];
        currentTurn = message.turn || 0;
        gameDirection = message.direction || 1;
        gameState = message.gameState || 0;
        drawingChain = message.drawingCount || 0;
        myHand = message.hand || [];
        updatePlayers(players, currentTurn);
        updateDiscardPile(message.discardPile || []);
        updateHand(myHand);
        applyCardLayout();
        updateTurnIndicator();
        break;

      case 'win':
        if (isSpectating) {
          const winnerMessage = message.winner?.length ? `${message.winner} 赢得了游戏！` : '没有人赢得了游戏, 所有真人玩家已离开对局'

          showAlert(winnerMessage).then(() => {
            resetGameState();
          });
        } else {
          showGameOver(message.winner || '');
        }
        break;

      case 'surrender_offer': {
        const spectate = await showConfirm('是否进入观战模式？\n确定=观战  取消=离开');
        if (spectate) {
          sendMessage({ action: 'spectate_accept' });
        } else {
          sendMessage({ action: 'leave' });
          store.remove('unoPlayerId');
          store.remove('unoInLobby');
          store.remove('unoInGame');
          resetGameState();
        }
        return;
      }

      case 'surrendered':
        localStorage.removeItem('unoInLobby');
        localStorage.removeItem('unoInGame');
        document.getElementById('about-clear-btn')!.style.display = '';
        document.getElementById('about-storage-title')!.style.display = '';
        resetGameState();
        break;

      case 'spectate_offer': {
        const want = await showConfirm('该大厅对局已开始，是否进入观战模式？');
        if (want) {
          sendMessage({ action: 'spectate', lobbyId: message.lobbyId, name: nameInput.value });
        } else {
          nameInput.disabled = false;
          lobbyIdInput.disabled = false;
          joinButton.disabled = false;
        }
        return;
      }

      case 'game_aborted':
        if (isSpectating) {
          store.remove('unoInLobby');
          store.remove('unoInGame');
          resetGameState();
        } else {
          showGameAborted();
        }
        break;

      case 'dev_state_export':
        clientLog('[dev_state_export]', JSON.stringify(message.log, null, 2));
        showAlert('状态日志已输出到控制台');
        break;

      case 'reaction':
        showReaction(message.playerId || '', message.type || '', message.content || '');
        break;
    }
  };

  newWs.onclose = (event: CloseEvent) => {
    if (newWs !== currentWs) return;
    connecting = false;
    clientLog(`ws.onclose code=${event.code} reason=${event.reason}`);
    isDisconnected = true;
    joinButton.disabled = true;
    showDisconnectedToast('connecting');
    if (event.code !== 1000) {
      setTimeout(connect, 1300);
    }
  };

  newWs.onerror = (err: Event) => {
    if (newWs !== currentWs) return;
    clientWarn('WebSocket error:', err);
  };
}

function canSendMessage(): boolean {
  return !!ws && ws.readyState === WebSocket.OPEN;
}

function flushQueue(): void {
  if (justReconnected) {
    justReconnected = false;
    clientLog(`flushQueue sending ${actionQueue.length} queued actions`);
  }
  while (actionQueue.length > 0) {
    const msg = actionQueue.shift()!;
    const action = (msg as Record<string, string>).action;
    // Skip ready on reconnect: server state is already current,
    // sending a stale ready would toggle the state incorrectly
    if (action === 'ready') {
      clientLog(`flush SKIPPING stale ready`);
      continue;
    }
    // Skip join if we are already in a lobby (reconnected successfully)
    if (action === 'join' && myLobbyId) {
      clientLog(`flush SKIPPING stale join (already in lobby ${myLobbyId})`);
      continue;
    }
    clientLog(`flush sending action=${action}`);
    if (canSendMessage()) {
      ws!.send(JSON.stringify(msg));
    }
  }
}

function sendMessage(message: object): boolean {
  if (canSendMessage()) {
    ws!.send(JSON.stringify(message));
    return true;
  }
  clientLog(`QUEUE action=${(message as Record<string, string>).action}`);
  actionQueue.push(message);
  isDisconnected = true;
  showDisconnectedToast('action');
  return false;
}

let lastReadyText = '';
function updateReadyButton(): void {
  if (!readyButton) return;
  readyButton.disabled = false;
  const me = players.find(p => p.id === myId);
  const text = me && me.ready ? '取消准备' : '准备';
  if (text === lastReadyText) return;
  lastReadyText = text;
  clientLog(`updateReadyButton myId=${myId ? myId.slice(0, 8) : null} found=${!!me} ready=${me ? me.ready : null} text=${text}`);
  readyButton.textContent = text;
}

function updateTurnIndicator(): void {
  if (currentTurn === -1 || !players.length) {
    turnText.textContent = '等待游戏开始...';
    turnIndicator.classList.remove('my-turn');
    document.body.classList.add('player-action-disabled');
    return;
  }

  const currentPlayer = players[currentTurn];
  const isMyTurn = currentPlayer && currentPlayer.id === myId;

  clientLog('[turn] myId =', myId, 'currentPlayer.id =', currentPlayer ? currentPlayer.id : null, 'isMyTurn =', isMyTurn);

  if (isMyTurn) {
    turnText.textContent = 'YOU';
    turnIndicator.classList.add('my-turn');
    document.body.classList.remove('player-action-disabled');
  } else {
    turnText.textContent = `${currentPlayer ? currentPlayer.name : '-'}的回合`;
    turnIndicator.classList.remove('my-turn');
    document.body.classList.add('player-action-disabled');
  }

  // Build turn order display
  let orderEl = document.getElementById('turn-order');
  if (!orderEl) {
    orderEl = document.createElement('div');
    orderEl.id = 'turn-order';
    opponentHandsDiv.insertAdjacentElement('beforebegin', orderEl);
  }
  orderEl.innerHTML = '';

  for (let i = 0; i < players.length; i++) {
    const p = players[i];

    const pill = document.createElement('span');
    pill.classList.add('turn-order-pill');
    if (i === currentTurn) pill.classList.add('current');
    if (p.isAI) pill.classList.add('ai');
    if (p.disconnected) pill.classList.add('disconnected');
    pill.textContent = p.name;
    orderEl.appendChild(pill);

    if (i < players.length - 1) {
      const arrow = document.createElement('span');
      arrow.classList.add('turn-order-arrow');
      arrow.textContent = gameDirection === 1 ? ' ▸ ' : ' ◂ ';
      orderEl.appendChild(arrow);
    }
  }

  if (lobbyDiv.style.display !== 'none') {
    orderEl.style.display = 'none';
  } else {
    orderEl.style.display = '';
  }
}

function showLobbyInfo(lobbyId: string): void {
  if (lobbyId) {
    currentLobbyId.textContent = lobbyId;
    readyButton.style.display = 'block';

    // Find the creator and update the lobby info
    const creator = players.find(p => p.isCreator);
    const lobbyInfoTitle = document.querySelector('#lobby-info h3');
    if (creator) {
      lobbyInfoTitle!.innerHTML = `大厅：<span id="current-lobby-id">${encodeUGC(lobbyId)}</span><br><small style="font-size: 0.8em; opacity: 0.8;">由 ${encodeUGC(creator.name)} 创建 <img src="/icons/crown.svg" style="width:1.2em;height:1.2em;vertical-align:text-bottom;"></small>`;
      // Re-add the click functionality to the new span
      const newLobbyIdSpan = document.getElementById('current-lobby-id')!;
      newLobbyIdSpan.style.cursor = 'pointer';
      newLobbyIdSpan.title = 'Click to copy lobby ID';
      newLobbyIdSpan.addEventListener('click', copyLobbyId);
    } else {
      lobbyInfoTitle!.innerHTML = `大厅：<span id="current-lobby-id">${encodeUGC(lobbyId)}</span>`;
    }

    lobbyInfo.style.display = 'block';
    hideJoinForm();

    store.set('unoPlayerName', nameInput.value);
    if (lobbyId) store.set('unoLobbyId', lobbyId);
  }
}

function attemptRejoin(): void {
  // Per-tab state may not be readable yet during the slot election window.
  slotReady.then(() => {
    const savedLobbyId = '';
    const savedPlayerName = store.get('unoPlayerName');

    if (savedLobbyId && savedPlayerName) {
      lobbyIdInput.value = savedLobbyId;
      nameInput.value = savedPlayerName;
    }
  });
}

function resetGameState(): void {
  localStorage.removeItem('unoInLobby');
  localStorage.removeItem('unoInGame');
  document.getElementById('about-clear-btn')!.style.display = '';
  document.getElementById('about-storage-title')!.style.display = '';
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  // Reset to lobby
  lobbyDiv.style.display = 'block';
  gameDiv.style.display = 'none';

  requestAnimationFrame(() => {

    nameInput.value = (store.get('unoPlayerName') || '').trim();
    nameInput.disabled = false;
    joinButton.disabled = false;
    lobbyIdInput.disabled = false;

    // Clear game state (keep myId — persists across lobby sessions)
    currentTurn = -1;
    players = [];
    pendingWildCard = null;
    selectedCards = [];
    isSelectingMultiple = false;
    myHand = [];
    myLobbyId = null;

    // Hide wild color picker and lobby info
    wildColorPicker.style.display = 'none';
    hideLobbyInfo();
    readyButton.style.display = 'none';
    if (inviteAIBtn) inviteAIBtn.style.display = 'none';
    document.getElementById('draw-mode-area')!.style.display = 'none';

    // Clear players list
    playersList.innerHTML = '';

    // Reset turn indicator
    turnText.textContent = 'Waiting for game to start...';
    turnIndicator.classList.remove('my-turn');
  });
}

function updatePlayers(newPlayers: Player[], turn: number): void {
  opponentHandsDiv.innerHTML = '';
  playersList.innerHTML = '';
  for (let i = 0; i < newPlayers.length; i++) {
    const player = newPlayers[i];
    const playerDiv = document.createElement('div');
    playerDiv.classList.add('player');
    if (i === turn) {
      playerDiv.classList.add('active');
    }

    if (player.uno) {
      playerDiv.classList.add('uno');
    }

    // Add creator styling to opponent display too
    if (player.isCreator) {
      playerDiv.classList.add('creator');
    }

    if (player.isAI) {
      playerDiv.classList.add('ai');
    }

    if (player.disconnected) {
      playerDiv.classList.add('disconnected');
    }

    let iconHtml = '';
    if (player.isCreator) {
      iconHtml += '<img src="/icons/crown.svg" style="width:1.2em;height:1.2em;vertical-align:text-bottom;margin-left:2px;">';
    }
    if (player.isAI) {
      iconHtml += '<img src="/icons/robot.svg" style="width:1.2em;height:1.2em;vertical-align:text-bottom;margin-left:2px;">';
    }

    let displayText = player.name;
    if (player.disconnected && player.reconnectDeadline) {
      const remaining = Math.max(0, Math.ceil((player.reconnectDeadline - Date.now()) / 1000));
      displayText += ` · 重连中 ${remaining}s`;
    }

    if (player.cardCount !== undefined && player.id !== myId) {
      playerDiv.innerHTML = `${encodeUGC(displayText)}${iconHtml}（${player.cardCount} 张牌）`;
    } else {
      playerDiv.innerHTML = `${encodeUGC(displayText)}${iconHtml}`;
    }

    playerDiv.dataset.playerId = player.id;
    if (player.id !== myId) {
      opponentHandsDiv.appendChild(playerDiv);
    }

    const li = document.createElement('li');
    li.classList.add('player-row');
    if (player.isCreator) li.classList.add('creator');
    if (player.isAI) li.classList.add('ai');
    if (player.disconnected) li.classList.add('disconnected');

    const nameSpan = document.createElement('span');
    nameSpan.classList.add('player-name');
    let nameText = player.name;
    if (player.ready) nameText += '（已准备）';
    if (player.disconnected && player.reconnectDeadline) {
      const remaining = Math.max(0, Math.ceil((player.reconnectDeadline - Date.now()) / 1000));
      nameText += ` · 重连中 ${remaining}s`;
    }
    nameSpan.innerHTML = `${encodeUGC(nameText)}${iconHtml}`;
    if (i === turn) nameSpan.style.fontWeight = 'bold';
    li.appendChild(nameSpan);

    // Ready button for unready AI players (only visible to creator)
    const me = newPlayers.find(p => p.id === myId);
    if (player.isAI && me && me.isCreator) {
      const actionsDiv = document.createElement('span');
      actionsDiv.classList.add('ai-actions');

      const readyAiBtn = document.createElement('button');
      readyAiBtn.textContent = player.ready ? '取消准备' : '准备';
      readyAiBtn.classList.add('ready-ai-btn');
      readyAiBtn.addEventListener('click', () => {
        sendMessage({ action: 'ai_ready', playerId: player.id });
      });
      actionsDiv.appendChild(readyAiBtn);

      const kickAiBtn = document.createElement('button');
      kickAiBtn.textContent = '踢出';
      kickAiBtn.classList.add('kick-ai-btn');
      kickAiBtn.addEventListener('click', () => {
        sendMessage({ action: 'remove_ai', playerId: player.id });
      });
      actionsDiv.appendChild(kickAiBtn);

      li.appendChild(actionsDiv);
    }

    // Transfer creator button for non-AI non-creator players (visible to creator)
    if (me && me.isCreator && !player.isAI && !player.isCreator && !player.disconnected && player.id !== myId) {
      const transferBtn = document.createElement('button');
      transferBtn.textContent = '转让房主';
      transferBtn.classList.add('transfer-creator-btn');
      transferBtn.addEventListener('click', () => {
        sendMessage({ action: 'transfer_creator', playerId: player.id });
      });
      li.appendChild(transferBtn);
    }

    playersList.appendChild(li);
  }

  // Show/hide invite AI button
  const me = newPlayers.find(p => p.id === myId);
  if (inviteAIBtn) {
    inviteAIBtn.style.display = (me && me.isCreator) ? '' : 'none';
  }
  const drawModeArea = document.getElementById('draw-mode-area')!;
  drawModeArea.style.display = (me && me.isCreator) ? 'flex' : 'none';
  updateReadyButton();

  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  const hasDeadline = newPlayers.some(p => p.disconnected && !!p.reconnectDeadline);
  if (hasDeadline) {
    countdownInterval = setInterval(() => updatePlayers(players, currentTurn), 1000);
  }
}

function updateHand(hand: Card[]): void {
  playerHandDiv.innerHTML = '';

  // Determine which cards are playable against the top discard
  const discardCard = discardPileDiv.querySelector('.card');
  const topColor = discardCard ? discardCard.getAttribute('data-color') : null;
  const topType = discardCard ? discardCard.getAttribute('data-type') : null;

  for (let i = 0; i < hand.length; i++) {
    const card = hand[i];
    const cardDiv = createCard(card);

    cardDiv.dataset.cardIndex = String(i);

    if (selectedCards.some(selected => selected.index === i)) {
      cardDiv.classList.add('selected');
    }

    // Mark non-playable cards (no hover lift)
    if (topColor && topType) {
      const isNCard = (t: string) => t === 'draw2' || t === 'wild4';
      const playable = card.type === 'wild' || card.type === 'wild4' ||
        card.color === topColor || card.type === topType ||
        (isNCard(card.type) && isNCard(topType));
      if (!playable) cardDiv.classList.add('not-playable');
    }

    cardDiv.addEventListener('click', () => handleCardClick(card, i, hand));
    playerHandDiv.appendChild(cardDiv);
  }

  // Add play selected cards button if multiple cards are selected (below the hand)
  if (selectedCards.length > 1) {
    const playButton = document.createElement('button');
    playButton.textContent = `出 ${selectedCards.length} 张牌`;
    playButton.classList.add('play-multiple-btn');
    playButton.addEventListener('click', playSelectedCards);
    playerHandDiv.appendChild(playButton);

    const cancelButton = document.createElement('button');
    cancelButton.textContent = '取消选择';
    cancelButton.classList.add('cancel-selection-btn');
    cancelButton.addEventListener('click', clearSelection);
    playerHandDiv.appendChild(cancelButton);
  }
}

async function handleCardClick(card: Card, cardIndex: number, hand: Card[]): Promise<void> {
  // If wild color picker is open and this card is not wild, dismiss picker
  if (wildColorPicker.style.display !== 'none' && card.type !== 'wild' && card.type !== 'wild4') {
    hideWildColorPicker();
  }

  // Check if we're selecting multiple cards
  if (isSelectingMultiple) {
    toggleCardSelection(card, cardIndex, hand);
  } else {
    // Single card play
    if (card.type === 'wild' || card.type === 'wild4') {
      showWildColorPicker(card);
    } else {
      // In drawing chain state, confirm before breaking with non-draw2/wild4
      if (gameState === 1 && card.type !== 'draw2' && card.type !== 'wild4') {
        const ok = await showConfirm(`确定要打破链式加牌吗？\n你将抽 ${drawingChain} 张牌`);
        if (!ok) return;
      }
      sendMessage({ action: 'play', card: card });
    }
  }
}

function startMultipleSelection(card: Card, cardIndex: number): void {
  isSelectingMultiple = true;
  selectedCards = [{ card, index: cardIndex }];
  updateHand(getCurrentHand());
}

function toggleCardSelection(card: Card, cardIndex: number, hand: Card[]): void {
  const existingIndex = selectedCards.findIndex(selected => selected.index === cardIndex);

  if (existingIndex >= 0) {
    // Remove from selection
    selectedCards.splice(existingIndex, 1);
  } else {
    // Add to selection if same type as first selected card
    if (selectedCards.length === 0 || selectedCards[0].card.type === card.type) {
      selectedCards.push({ card, index: cardIndex });
    } else {
      showAlert('只能选择相同类型的牌！');
      return;
    }
  }

  // If no cards selected, exit multiple selection mode
  if (selectedCards.length === 0) {
    isSelectingMultiple = false;
  }

  updateHand(hand);
}

function playSelectedCards(): void {
  if (selectedCards.length === 0) return;

  const firstCard = selectedCards[0].card;
  if (firstCard.type === 'wild' || firstCard.type === 'wild4') {
    // For wild cards, we need to pick a color first
    pendingWildCard = selectedCards.map(s => s.card);
    wildColorPicker.style.display = 'block';
  } else {
    // Send multiple cards to server
    sendMessage({
      action: 'play_multiple',
      cards: selectedCards.map(s => s.card),
      indices: selectedCards.map(s => s.index)
    });
    clearSelection();
  }
}

function clearSelection(): void {
  selectedCards = [];
  isSelectingMultiple = false;
  hideWildColorPicker();
  updateHand(getCurrentHand());
}

function getCurrentHand(): Card[] {
  return myHand;
}

let wildPickerScrollY = 0;
let onWildPickerScroll: (() => void) | null = null;

function showWildColorPicker(card: Card): void {
  pendingWildCard = card;
  wildPickerScrollY = window.scrollY;
  wildColorPicker.style.display = 'block';
  requestAnimationFrame(() => {
    wildColorPicker.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Attach manual scroll listener after auto-scroll settles
    setTimeout(() => {
      onWildPickerScroll = () => { wildPickerScrollY = 0; };
      window.addEventListener('scroll', onWildPickerScroll, { once: true });
    }, 600);
  });
}

function hideWildColorPicker(): void {
  wildColorPicker.style.display = 'none';
  pendingWildCard = null;
  if (onWildPickerScroll) {
    window.removeEventListener('scroll', onWildPickerScroll);
    onWildPickerScroll = null;
  }
  if (wildPickerScrollY) {
    window.scrollTo({ top: wildPickerScrollY, behavior: 'smooth' });
    wildPickerScrollY = 0;
  }
}

function updateDiscardPile(discardPile: Card[]): void {
  discardPileDiv.innerHTML = '';
  const card = discardPile[discardPile.length - 1];
  const cardDiv = createCard(card);
  discardPileDiv.appendChild(cardDiv);
}

function createCard(card: Card): HTMLDivElement {
  const cardDiv = document.createElement('div');
  cardDiv.classList.add('card');

  // Set data attributes for CSS styling
  cardDiv.setAttribute('data-color', card.color || 'black');
  cardDiv.setAttribute('data-type', card.type);

  // Create card content structure
  const cardContent = document.createElement('div');
  cardContent.classList.add('card-content');

  // Determine card display values
  let cornerNumber: string, cornerSymbol: string, centerContent: string;

  if (card.type === 'wild') {
    cornerNumber = 'W';
    cornerSymbol = '★';
    centerContent = 'W';
  } else if (card.type === 'wild4') {
    cornerNumber = '+4';
    cornerSymbol = '★';
    centerContent = '+4';
  } else if (card.type === 'draw2') {
    cornerNumber = '+2';
    cornerSymbol = '2';
    centerContent = '+2';
  } else if (card.type === 'skip') {
    cornerNumber = 'Ø';
    cornerSymbol = 'Ø';
    centerContent = 'Ø';
  } else if (card.type === 'reverse') {
    cornerNumber = '⇄';
    cornerSymbol = '⇄';
    centerContent = '⇄';
  } else {
    cornerNumber = card.type.toUpperCase();
    cornerSymbol = card.type.toUpperCase();
    centerContent = card.type.toUpperCase();
  }

  // Create top-left corner
  const topLeftCorner = document.createElement('div');
  topLeftCorner.classList.add('card-corner', 'top-left');

  const topLeftNumber = document.createElement('div');
  topLeftNumber.classList.add('card-corner-number');
  topLeftNumber.textContent = cornerNumber;

  topLeftCorner.appendChild(topLeftNumber);

  // Create bottom-right corner
  const bottomRightCorner = document.createElement('div');
  bottomRightCorner.classList.add('card-corner', 'bottom-right');

  const bottomRightNumber = document.createElement('div');
  bottomRightNumber.classList.add('card-corner-number');
  bottomRightNumber.textContent = cornerNumber;

  bottomRightCorner.appendChild(bottomRightNumber);

  // Create center ellipse
  const cardCenter = document.createElement('div');
  cardCenter.classList.add('card-center');

  const cardCenterContent = document.createElement('div');
  cardCenterContent.classList.add('card-center-content');

  const centerElement = document.createElement('div');
  centerElement.classList.add('card-center-number');
  centerElement.textContent = centerContent;

  cardCenterContent.appendChild(centerElement);
  cardCenter.appendChild(cardCenterContent);

  // Assemble the card
  cardContent.appendChild(topLeftCorner);
  cardContent.appendChild(bottomRightCorner);
  cardContent.appendChild(cardCenter);
  cardDiv.appendChild(cardContent);

  return cardDiv;
}

// Update the color picker to handle multiple wild cards
colorOptions.addEventListener('click', (e: Event) => {
  const target = e.target as HTMLElement;
  if (target.classList.contains('color-option')) {
    const color = target.dataset.color!;
    if (pendingWildCard) {
      if (Array.isArray(pendingWildCard)) {
        sendMessage({
          action: 'play_multiple',
          cards: pendingWildCard.map(card => ({ ...card, color: color })),
          indices: selectedCards.map(s => s.index)
        });
        clearSelection();
      } else {
        sendMessage({ action: 'play', card: { ...pendingWildCard, color: color } });
      }
    }
    wildPickerScrollY = 0;
    hideWildColorPicker();
  }
});

document.getElementById('cancel-wild-btn')!.addEventListener('click', hideWildColorPicker);

joinButton.addEventListener('click', async () => {
  const name = nameInput.value.trim();
  const lobbyId = lobbyIdInput.value.trim().toUpperCase();

  if (!name) {
    await showAlert('请输入你的名称');
    return;
  }

  if (name.length < NAME_LENGTH_MIN) {
    await showAlert('名称至少需要 2 个字符');
    return;
  }

  if (name.length > NAME_LENGTH_MAX) {
    await showAlert(`名称不能超过 ${NAME_LENGTH_MAX} 个字符`);
    return;
  }

  // Disable form to prevent multiple submissions
  nameInput.disabled = true;
  lobbyIdInput.disabled = true;
  joinButton.disabled = true;

  const savedId = store.get('unoPlayerId');
  const message: Record<string, string> = { action: 'join', name: name };
  if (lobbyId) message.lobbyId = lobbyId;
  if (savedId) message.playerId = savedId;
  // Save immediately so auto-reconnect can find these even if WS closes
  // before the first players/start message arrives
  store.set('unoPlayerName', name);
  if (lobbyId) store.set('unoLobbyId', lobbyId);
  sendMessage(message);
});

if (inviteAIBtn) {
  inviteAIBtn.addEventListener('click', () => {
    sendMessage({ action: 'add_ai' });
  });
}

readyButton.addEventListener('click', () => {
  if (readyButton.disabled) {
    clientLog(`ready click ignored (disabled)`);
    return;
  }
  readyButton.disabled = true;
  // readyButton.textContent = '...';
  clientLog(`ready click, sending, isDisconnected=${isDisconnected}`);
  if (sendMessage({ action: 'ready' })) {
    updateReadyButton()
  };
});

drawCardButton.addEventListener('click', async () => {
  if (gameState === 1 && drawingChain > 0) {
    const ok = await showConfirm(`确定要打破链式加牌吗？\n你将抽 ${drawingChain} 张牌`);
    if (!ok) return;
  }
  sendMessage({ action: 'draw' });
});

const surrenderBtn = document.getElementById('surrender-btn') as HTMLButtonElement;
if (surrenderBtn) {
  surrenderBtn.addEventListener('click', async () => {
    const confirmed = await showConfirm('确定要认输吗？');
    if (confirmed) {
      sendMessage({ action: 'surrender' });
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  connect();
  attemptRejoin();

  // Create form container and move elements
  const nameDiv = nameInput.parentNode!;
  const lobbyParentDiv = lobbyIdInput.parentNode!;

  joinFormContainer.appendChild(nameDiv);
  joinFormContainer.appendChild(lobbyParentDiv);
  joinFormContainer.appendChild(joinButton);

  // Insert before players list
  const playersUl = document.getElementById('players')!;
  playersUl.parentNode!.insertBefore(joinFormContainer, playersUl);

  // Add click-to-copy functionality to lobby ID
  const lobbyIdSpan = document.getElementById('current-lobby-id');
  if (lobbyIdSpan) {
    lobbyIdSpan.style.cursor = 'pointer';
    lobbyIdSpan.title = 'Click to copy lobby ID';
    lobbyIdSpan.addEventListener('click', copyLobbyId);
  }

  // Reaction bar event listeners
  reactionEmojis.addEventListener('click', (e: Event) => {
    const target = e.target as HTMLElement;
    const btn = target.closest('.reaction-emoji');
    if (!btn) return;
    const el = btn as HTMLElement;
    sendMessage({ action: 'reaction', type: 'emoji', content: el.dataset.emoji });
  });

  reactionSendBtn.addEventListener('click', sendReactionText);
  reactionTextInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') sendReactionText();
  });

  // Save name/lobby ID to localStorage on each keystroke
  nameInput.addEventListener('input', () => {
    store.set('unoPlayerName', nameInput.value);
  });
  lobbyIdInput.addEventListener('input', () => {
    store.set('unoLobbyId', lobbyIdInput.value.toUpperCase());
  });

  getLeaveSpectateBtn()?.addEventListener('click', async () => {
    const ok = await showConfirm('确定要退出观战吗？');
    if (!ok) return;
    sendMessage({ action: 'leave' });
  });

  // About modal
  const aboutOverlay = document.getElementById('about-overlay')!;
  const aboutBox = document.getElementById('about-box')!;
  document.getElementById('about-link')!.addEventListener('click', (e) => {
    e.preventDefault();
    aboutOverlay.classList.remove('hidden');
    aboutOverlay.style.display = 'flex';
    aboutBox.style.animation = 'modalIn 0.2s ease';
  });
  function closeAbout() {
    aboutBox.style.animation = 'modalOut 0.15s ease forwards';
    aboutBox.addEventListener('animationend', function h() {
      aboutBox.removeEventListener('animationend', h);
      aboutOverlay.classList.add('hidden');
      aboutOverlay.style.display = '';
      if (storageCleared) {
        location.reload()
      }
    });
  }
  document.getElementById('about-close-btn')!.addEventListener('click', closeAbout);
  document.getElementById('about-clear-btn')!.addEventListener('click', async () => {
    const ok = await showConfirm('确定要清除当前标签页的存储状态吗？此操作不可撤销。');
    if (!ok) return;
    // Clear all known keys for current slot and plain keys
    const s = tabSlot || 1;
    ['unoPlayerName', 'unoLobbyId', 'unoPlayerId', 'unoInLobby', 'unoInGame', 'unoLeftLobby', 'unoCardLayout'].forEach(k => {
      [`${k}-${s}`, k].forEach(sk => { sessionStorage.removeItem(sk); localStorage.removeItem(sk); });
    });
    sessionStorage.removeItem('unoSlot');
    if (tabSlot) {
      ch.postMessage({ type: 'bye', slot: tabSlot, tabId: TAB_ID });
      knownSlots.delete(tabSlot);
    }
    tabSlot = 0;
    storageCleared = true;
    const msg = document.getElementById('about-clear-msg')!;
    msg.style.display = 'block';
    setTimeout(() => { msg.style.display = 'none'; }, 2000);
  });

  // Rules modal
  const rulesOverlay = document.getElementById('rules-overlay')!;
  const rulesBox = document.getElementById('rules-box')!;
  document.getElementById('rules-link')!.addEventListener('click', (e) => {
    e.preventDefault();
    rulesOverlay.classList.remove('hidden');
    rulesOverlay.style.display = 'flex';
    rulesBox.style.animation = 'modalIn 0.2s ease';
  });
  function closeRules() {
    rulesBox.style.animation = 'modalOut 0.15s ease forwards';
    rulesBox.addEventListener('animationend', function h() {
      rulesBox.removeEventListener('animationend', h);
      rulesOverlay.classList.add('hidden');
      rulesOverlay.style.display = '';
    });
  }
  document.getElementById('rules-close-btn')!.addEventListener('click', closeRules);

  // Draw mode toggle
  document.querySelectorAll('#draw-mode-toggle-box .mode-option').forEach(el => {
    el.addEventListener('click', () => {
      const mode = el.getAttribute('data-mode')!;
      document.querySelectorAll('#draw-mode-toggle-box .mode-option').forEach(e => e.classList.remove('active'));
      el.classList.add('active');
      sendMessage({ action: 'set_draw_mode', mode });
    });
  });

  // Draw mode info → opens rules and highlights the section
  document.getElementById('draw-mode-info')!.addEventListener('click', () => {
    rulesOverlay.classList.remove('hidden');
    rulesOverlay.style.display = 'flex';
    rulesBox.style.animation = 'modalIn 0.2s ease';
    setTimeout(() => {
      const el = document.getElementById('rules-draw-mode-highlight');
      if (el) {
        el.classList.remove('highlight-section');
        void el.offsetWidth; // force reflow to restart animation
        el.classList.add('highlight-section');
      }
    }, 300);
  });
});

function copyLobbyId(): void {
  const lobbyIdSpan = document.getElementById('current-lobby-id')!;
  const lobbyId = lobbyIdSpan.textContent || '';

  // Use the modern clipboard API
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(lobbyId).then(() => {
      showCopyFeedback(lobbyIdSpan);
    }).catch(() => {
      // Fallback for older browsers
      fallbackCopyToClipboard(lobbyId, lobbyIdSpan);
    });
  } else {
    // Fallback for older browsers
    fallbackCopyToClipboard(lobbyId, lobbyIdSpan);
  }
}

function applyCardLayout(): void {
  if (store.get('unoCardLayout') !== 'wrap') {
    playerHandDiv.classList.add('scroll-mode');
    cardLayoutToggle.textContent = '切换到换行排列';
  } else {
    playerHandDiv.classList.remove('scroll-mode');
    cardLayoutToggle.textContent = '切换到滚动排列';
  }
  updateScrollAlignment();
}

function updateScrollAlignment(): void {
  const isScroll = playerHandDiv.classList.contains('scroll-mode');
  if (!isScroll) { playerHandDiv.style.justifyContent = ''; return; }
  playerHandDiv.style.justifyContent = playerHandDiv.scrollWidth > playerHandDiv.clientWidth ? 'flex-start' : 'center';
}

cardLayoutToggle.addEventListener('click', () => {
  playerHandDiv.classList.toggle('scroll-mode');
  const isScroll = playerHandDiv.classList.contains('scroll-mode');
  store.set('unoCardLayout', isScroll ? 'scroll' : 'wrap');
  cardLayoutToggle.textContent = isScroll ? '切换到换行排列' : '切换到滚动排列';
  updateScrollAlignment();
});

function sendReactionText(): void {
  const text = reactionTextInput.value.trim();
  if (!text) return;
  let width = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) width += 1;
    else width += 0.3;
  }
  if (width > 64) {
    showAlert('消息过长！');
    return;
  }
  sendMessage({ action: 'reaction', type: 'text', content: text });
  reactionTextInput.value = '';
}

function fallbackCopyToClipboard(text: string, element: HTMLElement): void {
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.left = '-999999px';
  textArea.style.top = '-999999px';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  try {
    document.execCommand('copy');
    showCopyFeedback(element);
  } catch (err) {
    clientWarn('Failed to copy lobby ID:', err);
  }

  document.body.removeChild(textArea);
}

function showCopyFeedback(element: HTMLElement): void {
  const originalText = element.textContent || '';
  element.textContent = '已复制！';
  element.style.background = 'rgba(72, 187, 120, 0.3)';

  setTimeout(() => {
    element.textContent = originalText;
    element.style.background = 'rgba(255,255,255,0.2)';
  }, 1000);
}

function showDisconnectedToast(_reason: string): void {
  const toast = document.getElementById('disconnected-toast') || createDisconnectedToast();
  toast.textContent = '连接已断开，正在重连... 如持续失败请刷新页面';
  toast.classList.add('visible');
  clearTimeout(disconnectToastTimeout!);
}

function hideDisconnectedToast(): void {
  const toast = document.getElementById('disconnected-toast');
  if (toast) {
    toast.classList.remove('visible');
  }
  if (disconnectToastTimeout) clearTimeout(disconnectToastTimeout);
}

function createDisconnectedToast(): HTMLDivElement {
  const toast = document.createElement('div');
  toast.id = 'disconnected-toast';
  document.body.appendChild(toast);
  return toast;
}

function createLeaveLobbyButton(): HTMLButtonElement {
  const leaveLobbyBtn = document.createElement('button');
  leaveLobbyBtn.id = 'leave-lobby';
  leaveLobbyBtn.textContent = '离开大厅';
  leaveLobbyBtn.classList.add('leave-lobby-btn');
  leaveLobbyBtn.addEventListener('click', leaveLobby);
  return leaveLobbyBtn;
}

async function leaveLobby(): Promise<void> {
  const confirmed = await showConfirm('确定要离开大厅吗？');
  if (!confirmed) return;

  sendMessage({ action: 'leave' });
  store.remove('unoPlayerId');
  store.remove('unoInLobby');
  store.remove('unoInGame');
  store.set('unoLeftLobby', 'true');
  requestAnimationFrame(() => resetGameState());
}

function showJoinForm(): void {
  joinFormContainer.style.display = 'block';

  // Remove leave lobby button if it exists
  const existingLeaveBtn = document.getElementById('leave-lobby');
  if (existingLeaveBtn) {
    existingLeaveBtn.remove();
  }
}

function hideJoinForm(): void {
  joinFormContainer.style.display = 'none';

  // Add leave lobby button if it doesn't exist
  let leaveLobbyBtn = document.getElementById('leave-lobby');
  if (!leaveLobbyBtn) {
    leaveLobbyBtn = createLeaveLobbyButton();
    // Insert after lobby info
    const lobbyInfoEl = document.getElementById('lobby-info')!;
    lobbyInfoEl.parentNode!.insertBefore(leaveLobbyBtn, lobbyInfoEl.nextSibling);
  }
}

function hideLobbyInfo(): void {
  lobbyInfo.style.display = 'none';
  showJoinForm();
}

const gameOverOverlay = document.getElementById('game-over-overlay') as HTMLDivElement;
const gameOverTitle = document.getElementById('game-over-title') as HTMLHeadingElement;
const gameOverMessage = document.getElementById('game-over-message') as HTMLParagraphElement;
const gameOverIcon = document.getElementById('game-over-icon') as HTMLDivElement;
const gameOverContent = document.getElementById('game-over-content') as HTMLDivElement;
const gameOverBtn = document.getElementById('game-over-btn') as HTMLButtonElement;

let isGameOverShowing = false;

function showGameOver(winnerName: string): void {
  if (isGameOverShowing) return;
  isGameOverShowing = true;
  store.remove('unoInLobby');
  store.remove('unoInGame');

  // No human players left (AI-only game)
  if (!winnerName) {
    gameOverIcon.innerHTML = '<img src="/icons/bolt.svg" style="width:64px;height:64px;">';
    gameOverTitle.textContent = '没有人赢了';
    gameOverMessage.textContent = '所有真人玩家已离开对局';
    gameOverContent.className = 'aborted';
    gameOverOverlay.classList.remove('hidden');
    gameOverOverlay.style.display = 'flex';
    return;
  }

  const myPlayer = players.find(p => p.id === myId);
  const isWinner = winnerName === (myPlayer ? myPlayer.name : '');
  const myName = store.get('unoPlayerName') || '';

  if (isWinner) {
    gameOverIcon.innerHTML = '<img src="/icons/trophy.svg" style="width:64px;height:64px;">';
    gameOverTitle.textContent = '你赢了！';
    gameOverMessage.innerHTML = `<img src="/icons/party.svg" style="width:1em;height:1em;vertical-align:middle;"> ${encodeUGC(winnerName)} 赢得了游戏！干得漂亮！`;
    gameOverContent.className = 'win';
    spawnConfetti();
  } else {
    gameOverIcon.innerHTML = '<img src="/icons/heartbreak.svg" style="width:64px;height:64px;">';
    gameOverTitle.textContent = '游戏结束';
    gameOverMessage.textContent = `${encodeUGC(winnerName)} 赢得了游戏！\n下次加油，${encodeUGC(myName)}！`;
    gameOverContent.className = 'lose';
  }

  gameOverOverlay.classList.remove('hidden');
  gameOverOverlay.style.display = 'flex';
}

function showGameAborted(): void {
  if (isGameOverShowing) return;
  isGameOverShowing = true;
  store.remove('unoInLobby');
  store.remove('unoInGame');

  gameOverIcon.innerHTML = '<img src="/icons/bolt.svg" style="width:64px;height:64px;">';
  gameOverTitle.textContent = '对局中止';
  gameOverMessage.textContent = '其他玩家离开了对局，游戏已结束';
  gameOverContent.className = 'aborted';

  gameOverOverlay.classList.remove('hidden');
  gameOverOverlay.style.display = 'flex';
}

function showReaction(playerId: string, type: string, content: string): void {
  const playerDiv = opponentHandsDiv.querySelector(`[data-player-id="${playerId}"]`) as HTMLDivElement;
  if (!playerDiv && playerId !== myId) return;

  const popup = document.createElement('div');
  popup.classList.add('reaction-popup');
  if (type === 'text') {
    popup.classList.add('reaction-popup-text');
    popup.textContent = content;
  } else {
    const iconMap: Record<string, string> = {
      '😂': 'laugh', '😡': 'angry', '😱': 'shock', '👍': 'like',
      '👎': 'dislike', '🎉': 'party', '😭': 'cry', '🔥': 'fire'
    };

    // ── Logging ──────────────────────────────────────────────
    const CLIENT_PREFIX = '[client]';
    const icon = iconMap[content] || 'laugh';
    popup.innerHTML = `<img src="/icons/${icon}.svg" style="width:32px;height:32px;">`;
  }

  let width = 0;
  for (const ch of content) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) width += 1;
    else width += 0.3;
  }
  const duration = Math.max(1.5, Math.min(5, 1 + width * 0.1));
  popup.style.animationDuration = duration + 's';

  if (playerDiv) {
    playerDiv.appendChild(popup);
  } else {
    // Self reaction: show above reaction bar
    const reactionBar = document.getElementById('reaction-bar');
    if (reactionBar) {
      popup.style.position = 'absolute';
      popup.style.bottom = '100%';
      popup.style.left = '50%';
      popup.style.transform = 'translateX(-50%)';
      reactionBar.appendChild(popup);
    }
  }

  popup.addEventListener('animationend', () => popup.remove(), { once: true });
}

gameOverBtn.addEventListener('click', () => {
  gameOverOverlay.classList.add('hidden');
  gameOverOverlay.style.display = '';
  isGameOverShowing = false;
  requestAnimationFrame(() => resetGameState());
});

function spawnConfetti(): void {
  const colors = ['#ff6b6b', '#ffd700', '#48bb78', '#667eea', '#ff8a5c', '#f1c40f', '#e74c3c', '#3498db', '#2ecc71'];
  const container = document.body;

  for (let i = 0; i < 80; i++) {
    const el = document.createElement('div');
    el.classList.add('confetti');
    el.style.left = Math.random() * 100 + 'vw';
    el.style.background = colors[Math.floor(Math.random() * colors.length)];
    el.style.width = (Math.random() * 8 + 4) + 'px';
    el.style.height = (Math.random() * 8 + 4) + 'px';
    el.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
    el.style.animationDuration = (Math.random() * 2 + 2) + 's';
    el.style.animationDelay = (Math.random() * 2) + 's';
    container.appendChild(el);

    setTimeout(() => el.remove(), 5000);
  }
}

function __callWin__(): void {
  sendMessage({ action: 'dev_call_win' });
}

// Dev Panel — press Ctrl+Shift+D to toggle; auto-shown when server is in dev mode
let devPanelSetup = false;
function setupDevPanel(): void {
  if (devPanelSetup) return;
  devPanelSetup = true;

  const panel = document.getElementById('dev-panel');
  if (!panel) return;

  panel.style.display = '';

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') {
      e.preventDefault();
      panel.classList.toggle('collapsed');
    }
  });

  // Toggle collapse on header click
  const header = document.getElementById('dev-panel-header');
  if (header) {
    header.addEventListener('click', () => {
      panel.classList.toggle('collapsed');
    });
  }

  // Dev button click handlers
  panel.addEventListener('click', (e: Event) => {
    const target = e.target as HTMLElement;
    const btn = target.closest('.dev-btn');
    if (!btn) return;
    const el = btn as HTMLElement;

    const action = el.dataset.action!;
    if (action === 'dev_disconnect') {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(4001, 'dev disconnect');
        el.textContent = '重连';
      } else if (ws && ws.readyState === WebSocket.CLOSED) {
        el.textContent = '断开';
        connect();
      }
      return;
    }

    const countStr = el.dataset.count;
    const count = countStr ? parseInt(countStr) : undefined;

    const msg: Record<string, unknown> = { action };
    if (count !== undefined) msg.count = count;
    sendMessage(msg);
  });
}

(function initDevPanel() {
  // Prepare panel hidden; setupDevPanel will be called when 'init' message confirms dev mode
  const panel = document.getElementById('dev-panel');
  if (panel) panel.style.display = 'none';
})();
